## Linear Webhook Constraints

### agentSessionCreated

**IMPORTANT NOTE:** A delegation always triggers the first agentSession on a Linear issue. An @ mention can trigger either the first or an additional agentSession on a Linear issue. For the case when it triggers an additional agentSession, the webhook MUST use the existing selected repository, as we do NOT support switching repositories within a single issue.
When the first agentSession is created for a Linear issue, a repository must be selected and cached for that issue. If a repository can not be matched based on the metadata of the Linear issue and the configured routing for the repositories, then a agentSession select signal should be sent to Linear with the configured repositories as options. In this case, a
Claude runner should NOT be initialized until the subsequent agentSessionPrompted webhook is received.

An agentSessionCreated webhook has two triggers from Linear:

#### via @ mention:

- Skips label-based system prompt by default if (!isMentionTriggered || isLabelBasedPromptRequested))

- No system prompt unless user explicitly uses `/label-based-prompt` command

- More flexible/conversational mode

#### via delegation:

- Uses label-based system prompt routing.

- Checks issue labels for debugger, orchestrator, or other custom prompts.

- Falls back to default system prompt.

### agentSessionPrompted

An agentSessionPrompted webhook has three different handling branches:

#### if (agentActivity.signal === "stop"):

When this signal is received, all claudeRunners associated with this agentSession MUST be terminated. In this case, an agentSession MUST already exist.

#### if (this.repositoryRouter.hasPendingSelection(agentSessionId)):

When the pendingSelection flag is set for an agentSessionCreated webhook, the subsequent agentSessionPrompted webhook will either have the result of the selection or an unrelated response from the user ignoring the selection.
Currently, we only use the select signal for repository selection when the agentSessionCreated webhook can not route the metadata of the Linear issue to a configured repository. In this case, a select signal is posted to Linear,
which provides the user with options of the configured repositories. The user can then select a repository, which will send a agentSessionPrompted webhook where the body matches one of the options sent via the select signal, or an
unrelated prompt which we should handle by just using the fallback repo (first repo configured). In both cases, a Claude runner should be initialized.

#### else:

For this case an agentSession MUST exist and a repository MUST already be associated with the Linear issue. The repository will be retrieved from the issue-to-repository cache - no new routing logic is performed.



### Serialized lanes (PON-112)

Workspaces with `linearWorkspaces[id].laneSerialization: true` run at most ONE active session at a time. A `created` webhook while the lane is busy does NOT start a runner: the session is enqueued (raw webhook persisted immediately) and its single first activity is the queued-position ack. The stored webhook is replayed through the normal created flow when the session reaches the front. Prompts on queued sessions are intercepted before the normal prompted flow: a short next/prioritize intent reorders the queue; anything else is stored as context for start time. The lane releases on every end path (result success/error, dead runner, stop, unassign, terminal issue state) plus a 10-minute boot grace for a restored holder with no live runner. Child agent sessions bypass the lane (parent waits on them — queueing would deadlock). Default is off: workspaces without the flag behave exactly as before.

**Awaiting user input hands the lane back (PON-113).** A session that asks a question via `AskUserQuestion` releases the lane before blocking, so the client's other queued issues proceed instead of waiting on a human who may not reply for hours. When the answer arrives it re-enters through lane admission: the lane is acquired if free, or the answer webhook is enqueued as a `resume` entry and replayed once the lane frees. The one-active-session guarantee is unchanged — the lane is simply not held while nothing is being worked on.

### Scope-confirm gate (PON-150)

Delegated sessions in a gated workspace (`scopeConfirmGate !== false`, default **on**) carry a `<scope_confirm_gate>` system-prompt block: post a reading of the scope, then ask one `AskUserQuestion` with canonical options **Approve scope / Revise scope / Cancel**, and implement nothing until approval. The gate is **intrinsic, not enforced** — a prompt step, per the design principle in CLAUDE.local.md; the machinery only does bookkeeping:

- `ScopeApprovalStore` holds per-**issue** records (`awaiting|approved|revised`, `proposedAt`, `approvedAt`, `revisions`), persisted as `scopeApprovals` (state v4.3; `PERSISTENCE_VERSION` stays "4.0" so rollback keeps state). `approvedAt` is the SLA clock start, written exactly once — a queue-replayed answer webhook cannot move it, and a replayed revise cannot inflate `revisions` (a real second revision only follows a re-ask).
- The confirmation elicitation is recognised by the **exact** canonical "Approve scope" option — never by prefix, so "Approve deletion"-style questions cannot stamp the clock. Replies resolve **against the posted options** (PON-142's rule: by the answer, never by fallback); only the canonical labels approve/revise/cancel; free text never approves. A restart drops the in-memory pending question, so a canonical reply with no pending question still records — but only when a record exists, so a late answer after terminal cleanup resurrects nothing. **Cancel removes the record**: the pending list stays honest and a re-delegation re-gates fresh.
- The block is injected on new delegated sessions AND on **session resume** (`resumeAgentSession` via `appendScopeGateIfPending`) — a resumed runner does not inherit the previous invocation's appended prompt, so without re-injection a routine restart would remove the gate. Replies on **lane-queued** sessions are interpreted too (`handleQueuedSessionPrompt`), so the SLA clock is the answer's arrival, not the lane's convenience.
- Pre-approval waits release the lane with reason `awaiting_scope_confirm` (vs `awaiting_user_input` after approval) — same PON-113 release/re-admit machinery, distinct reason for the cockpit.
- Mentions stay conversational **except when a delegated flow is already mid-gate** (an open record exists): those get the block too — its side-conversation paragraph keeps them conversational while forbidding implementation, closing the ungated side door. Child sessions inherit the parent's scope; an approved issue never re-asks (approval survives restarts and unassign/re-delegate; it is cleared when the issue reaches a terminal state). The block explicitly supersedes PON-114's "state your reading and proceed" guidance.
- `GET /admin/scope-approvals` (loopback-only, like `/admin/lanes`) lists open gates — the guard against "an unconfirmed issue sits forever and nobody notices".
- Known accepted residuals (adversarial review 2026-08-22): a proposal recorded just before a failed elicitation post shows as a ghost "awaiting" entry (visible in the list, error logged); persistence is best-effort (a persist failure plus a crash can lose/restamp a record); a rollback build's first save drops the field (same semantics as lanes v4.2); records for issues whose terminal webhook was missed persist until cleanup sees one.


### Operator cockpit (PON-151)

`CockpitMirror` mirrors every delegated issue from tenant workspaces into one cockpit team/project (`cockpit: { linearWorkspaceId, workspaceName, teamId, projectId? }`, off when absent — including on hot-reload: the ConfigManager merge treats absence as a value for this field, it is the kill switch). Rules, all load-bearing:

- **Derived, write-only.** The module talks Linear GraphQL directly with the cockpit workspace's token; nothing reads a mirror to make a decision, and every method catches+logs — a broken mirror never breaks a client session. Per-issue write chains keep transitions ordered.
- **The `workspaceName` double-declaration is the cross-tenant guard.** The declared name must match `linearWorkspaces[id].linearWorkspaceName` or mirroring disables loudly (`cockpit_disabled_misconfigured`) — a copied-wrong workspace id (client ids sit next to the operator's) must never write mirrors into a client's Linear with that client's token.
- **A session end is not the end of the issue's work** (`shouldCloseCockpitMirror`): a mention conversation finishing, an open scope gate, queued entries, or other live sessions all keep the mirror open. Mention sessions are tracked in-memory (`mentionSessionIds`) and never mirrored or mirror-closing.
- **Boot reconciliation is authoritative against Linear, not just the map**: it adopts open mirror-looking issues (mirror title shape + a state label) it finds in the cockpit team so a lost `cockpitMirrors` map cannot mint duplicates, and closes orphans matching nothing live.
- Team setup (find-or-create state labels, resolve the Done state) caches per team, retries a failure only after a 5-minute cooldown, and filters the label query by name so a large team's label count cannot break it.
- Persistence: `cockpitMirrors` (v4.4); cockpit-driven persists are trailing-debounced, and `PersistenceManager.saveEdgeWorkerState` is now atomic (temp+rename) and in-process serialized — the state file carries every lane queue and scope approval, so concurrent fire-and-forget writers must not be able to tear it.
- Known residuals: mirrors go stale (never wrong-direction: worst case a closed/idle issue shows a live label) between an unwired release path (boot-grace lane release, tenant deactivation) and the next boot reconcile; sessions revived by prompt after a restart in a NON-serialized workspace are not re-mirrored until their next transition; the reconcile adoption scan reads the first 200 open team issues.


### Verify-before-client-sees (PON-152)

In a gated workspace (`verifyBeforeDelivery !== false`, default on) a delegated session's final completion response is intercepted (`AgentSessionManager.setFinalResponseInterceptor` → `EdgeWorker.holdCompletionForVerification`) and stored in `VerificationGate` (persisted as `pendingDeliveries`, v4.5) instead of posted. Mentions, child sessions, and post-delivery follow-ups post normally; the interceptor fails OPEN (a broken gate must never swallow a client's summary silently). The workspace is resolved from the session's repository, not the lane — in the runner-already-stopped ordering the lane has already released.

- **The mirror carries the notification**: `in-verification` state + `cockpit.assigneeId` assignment + the held summary and draft-PR links in the description. `handleLaneSessionEnded` shows in-verification instead of closing; boot reconcile keeps it alive.
- **One action on the mirror**: an @mention on a tracked mirror issue is intercepted in the created-webhook handler before ANY lane/routing/runner work (no model session, no cost). `approve` → PR(s) marked ready via GitHub GraphQL (per-repo App token; ref comes from OUR stored record and an explicit operator action, not an unverified payload) **then** the summary posts to the client thread **then** `delivered`. A failed summary post leaves the record pending and retryable; a replayed approve reports already-delivered. `reject: <feedback>` → record cleared, session resumed with the feedback as a direct prompt (the feedback text never reaches the client's thread), mirror back to `active`.
- **NEVER auto-release** (decided 2026-08-21): the ladder (10-min timer) only gets louder — one mirror-comment re-escalation after `remindAfterHours` (default 4), one honest delay note on the client's issue after `delayNoteAfterHours` (default 24). Nothing on a timer marks a PR ready or posts a summary, and restore never delivers.
- `GET /admin/verification` (loopback) — pending count + ages, independent of the cockpit.
- Config: `verifyBeforeDelivery` (workspace), `cockpit.assigneeId`, top-level `verificationEscalation` (in ConfigManager's both lists AND WorkerService's startup mapping — the systematic mapping test enforces the latter).

### Client-visible content policy (PON-168 / client-flow R2)

On any client-visible surface — tenant Linear activity, PR titles/bodies, commit messages, branch names, error activities — internal vocabulary never appears: the internal service name and its package names, internal filesystem paths, model ids, bare model-family words. `client-content-policy.ts` is the single definition, used three ways (intrinsic beats enforced, in that order of importance):

- **Intrinsic**: `buildClientSurfaceRuleBlock()` (`<client_surface_rules>`) is appended to EVERY session system prompt — new sessions in `buildNewSessionPrompt` and resumes in `resumeAgentSession` (resumed runners do not inherit the previous invocation's appended prompt). It also bans narration diaries and mandates deliverable framing.
- **Static sweep** (`client-content-policy.test.ts`): every `CLIENT_MESSAGES` template (all tenant-surface literals live in `client-messages.ts` — add new ones THERE, not inline), plus literal-extraction over ActivityPoster/RepositoryRouter/scope-confirm-gate. A registry-completeness test greps `src/` for posting APIs, so a new emitting module must either join the sweep or be documented operator-side — it cannot silently skip.
- **Runtime tripwire**: `AgentSessionManager.applyClientContentPolicy` runs on the final-response path and on `postResponseActivityStrict` deliveries. Unambiguous matches (internal name, path, model id) are redacted loudly — every rewrite journaled as `[event:client_content_policy_violation]` — ambiguous family words are logged only, never rewritten.

Deliberate exemptions, each load-bearing: branch references (`name/ref` shape) — Linear derives them from the app username, the client sees them in their own repo, rewriting one breaks the pointer; `cyrus-setup.sh`/`cyrus-teardown.sh` — the client's own documented convention files in THEIR repo (renaming the convention is a product decision, not a policy one); `claude-runner`/`claude-parser`/`claude-agent-sdk` (PON-186) — repository artifact names, not model ids: the model-id rule matched our own package directories and rewrote `packages/claude-runner` to `packages/the model` in a dogfood report. That last one is exempt from the model-id rule ONLY via a trailing-guarded pattern (`claude-runner-5` stays a match), and the redactor has to apply it as an ordered alternation rather than a pre-mask — the model-id pattern is greedy over `[\w.-]`, so a pre-mask would leave `claude-runner.ts` unrecognisable to the exemption.

### Deliverable-framed scope + operator notes (PON-169 / client-flow R1)

The scope-confirm gate's client comment is deliverable-framed by instruction: **Outcome / You will receive / Interpreted**, with an explicit ban on implementation detail (files, approach, steps) on the tenant surface. The internal reading lives operator-side:

- `record_operator_note` on the inline cyrus-tools MCP server (`record-operator-note.ts`; registered only when the harness passes `operatorNotes`, so CLI mode omits it; `mcp__cyrus-tools` is already a whole-server allow prefix, so no allowlist change). The gate block instructs note-FIRST, then the client comment, then the elicitation — the mirror carries the reading before the client sees the ask. The tool echoes bare `{success}` only: no handle it returns can be quoted onto a client surface.
- `EdgeWorker.deliverOperatorNote(cwd, note)`: cwd → session via `sessionForCwd` (shared with `log_failure_mode`), then the note lands on the issue's scope-approval record (`operatorNote`/`operatorNoteAt`, additive v4.6; survives approval — it is what the operator approved against) and best-effort on the cockpit mirror (`setOperatorNote`: description-only update under "## Internal reading", state/labels preserved, carried across ALL later transitions and into the closed description). The persisted record is authoritative; the mirror write failing never fails the recording. Note content is never journaled — length only.
- Latest note replaces the previous (a revision re-records). A note arriving before the elicitation creates the awaiting record early — `recordProposed` keeps the earlier `proposedAt`; the SLA clock (`approvedAt`) is untouched.
- Accepted residual: a mention session voluntarily calling the tool on a never-delegated issue creates an awaiting record, so future mentions on that issue carry the gate's conversational paragraph — conservative direction, harmless.

### Operator brief on the mirror (PON-170 / client-flow R3)

At scope approval the cockpit mirror composes the operator brief — a join over already-persisted state, no new sources of truth: **Client scope** (the deliverable-framed text, captured at proposal time via `record_operator_note`'s `client_scope` input and stored on the scope record, v4.7), **Approved/Revisions** (from the approval record — `approvedAt` is still written exactly once), **Internal reading** (R1's note), **Links** (PR urls, unioned in at `mirrorInVerification` from PON-152's `prUrls`). Mirror-record fields `clientScope/approvedAt/revisions/briefLinks` are carried across every transition like `operatorNote`; a brief-only change on an unchanged state still writes. All operator-side: zero tenant-surface changes.

### Delivery with operator notes (PON-171 / client-flow R5)

`approve: <notes>` on the mirror passes everything after the keyword to `deliverVerifiedWork(issueId, notes)`. The client summary becomes held-summary + `CLIENT_MESSAGES.deliveryFooter(previewUrl, mergeUrls, notes)` — **See it working** (first Vercel URL in the held summary, omitted honestly when absent) / **To take it: merge …** (only own-repo PRs CONFIRMED ready; a draft is never pointed at) / **Notes from our review**. Ordering and the strict post are untouched; bare `approve` and `reject:` unchanged; never-auto-release absolute. The notes are operator words on a client surface: `findClientContentViolations` runs FIRST — a violating note refuses the whole delivery (no PR readied, nothing posted, record stays pending) with a rephrase ask on the mirror, because the operator is present to fix it (vs. the session tripwire, which redacts, because nobody is).

### Needs-info mid-work (PON-172 / client-flow R6)

Intrinsic + bookkeeping, same split as the scope gate. `needs-info.ts`: canonical header **"Missing info"** (exact-match recognition, `isNeedsInfoQuestion`), `buildNeedsInfoRuleBlock()` appended to EVERY session prompt right after the client-surface rules (new sessions and resume) — ask once with everything needed, deliverable-framed, client-side inputs only; the scope gate takes precedence pre-approval (both blocks say so). Machinery: in `createAskUserQuestionCallback`, a recognised ask on a gate-closed issue records into `NeedsInfoStore` (persisted as `needsInfo`, v4.8), releases the lane with reason `awaiting_client_info` (gate reason still outranks any override), and flips the mirror to `needs-info` (new COCKPIT_STATES entry — pre-create the label where agent tokens can't). The answer closes the wait idempotently via `markNeedsInfoAnswered` from BOTH paths: pending-question resolution, and — post-restart, pending question gone — the normal prompted path whose resume (PON-164-validated) carries the answer as context; mirror back to `active`. Terminal issues clear the record with the scope record. Open waits are listed under `needsInfo` on `GET /admin/scope-approvals`.

### Fair ordering + reviewer sets (PON-173 / client-flow R4)

**Ordering**: `operator-ordering.ts` — pure `computeRoundRobinOrder` (one item per tenant per cycle; within a tenant `(stateRank, seq)`; tenants take turns oldest-head-first; single tenant = identity) and `stateRankOf` (in-verification first — the operator IS the blocker there; queued keeps the client's position). `CockpitMirror.resyncOperatorOrdering()` writes ranks as Linear `sortOrder` on mirrors whose rank changed (cached in `sortOrder` on the record, v4.x), awaited at the end of every upsert/close chain step and after boot reconcile; self-serialized with a trailing rerun. Derived-view rules intact: written, never read back. Honest limit: single-tenant prod = degenerate identity ordering until a second tenant exists.

**Reviewers**: `cockpit.reviewers` (set; first = default assignee) and `cockpit.assignments` (tenantWorkspaceId → reviewer) in the Zod schema — regenerate `packages/core/schemas` (`pnpm generate:json-schema`) whenever the config schema changes, the sync test enforces it. `EdgeWorker.cockpitReviewers()` (legacy `assigneeId` reads as a one-member set) gates approve/reject membership; `reviewerForWorkspace()` routes the in-verification assignment. Non-members are refused exactly as before.

### Client-quiet activity stream (PON-179)

Found live by Harold as the client on the R7 run: the tenant-side activity stream showed full working narration incl. box paths — and the `record_operator_note` tool CALL rendered as a client-visible action activity carrying the entire internal reading. Fix, all in the `postActivity` funnel: on client-quiet sessions (workspace has EITHER client-flow gate by RAW flag — not `verificationGateEnabled`, which folds in cockpit topology; both default ON so new tenants are quiet by default; the dev box's flags stay explicitly false = unchanged), thought/action activities do not post. Liveness = ack + per-invocation "Analyzing your request…" (which re-arms) + ONE `CLIENT_MESSAGES.workingStatus()` per invocation + elicitations + final response. Whatever still posts is policy-sanitized with REPO-RELATIVE path redaction (`redactClientContent(text, {stripPrefixes})` — session workspace path → `SUPPORT.md`, not `…/SUPPORT.md`); elicitation bodies sanitize via `AskUserQuestionHandler.deps.sanitizeClientText` → `ASM.sanitizeClientSurfaceText` (quiet sessions only). Also fixed en route: the branch-ref exemption needed a lookbehind (`BRANCH_REF_PATTERN`) — `\b` let `.cyrus-community/…` path segments masquerade as branch refs and escape redaction since PON-168. Dev audit for the record: all 104 client-team sessions on the dev box had narration with paths (23,703 path-bearing activities) — gates-off was Harold's explicit dev choice; flip before real clients.

### Decoupled quietness (PON-182)

Harold's ruling after PON-179: dev teams are partnership clients who knowingly watch the agent work — gating them as a side effect of path hygiene is an implicit client-facing change. Split: **`sanitizeClientPaths`** (path-ONLY: internal-path rule + repo-relative prefix strip + URL exemption; deliberately not names/models — dogfood narration on PON issues legitimately says package names) runs UNCONDITIONALLY on every activity payload in both posting paths (`sanitizePathsInContent`, debug-logged not journaled — routine on loud workspaces) and on elicitation bodies. **`linearWorkspaces[id].clientQuiet`** controls narration suppression alone: explicit wins; absent = gate-derived (either gate on → quiet), preserving pre-flag behavior with zero config edits. Quieting dev = one flag, no workflow change; gating dev stays a deliberate per-team decision.

### Workspace token liveness (PON-136)

Four live incidents: Linear OAuth access tokens expire ~daily; refresh is traffic-driven, so an idle workspace's token dies silently, and eventually its refresh token ages out too (silent expiry → full re-auth ceremony). `armWorkspaceLiveness` (10-min interval, `CYRUS_LIVENESS_INTERVAL_MS` override min 60s, boot probe at +45s, unref'd, serialized ticks) pings each active workspace through `tenantStillHasAccess` — deliberately a new CLOCK for existing behaviour: the tracker's patched client auto-refreshes on 401 (rotated pair persisted via onTokenRefresh), so **the ping drives refresh**; at this cadence a refresh token is never older than ~a day, killing the case-2 shape. Conclusive failure → `handleTenantAccessLost` (PON-115 path); recovery after re-auth = config hot-reload; passing ping = debug-silent; `active: false` workspaces skipped. CLI: `check-tokens` + `refresh-token` end with explicit `process.exit` (the env-watcher held the loop open — the incident-tooling hang); `refresh-token` tries the silent refresh grant first and never blocks on stdin non-interactively.

### Startup retry (PON-138)

A session ending in an ERROR result with ≤8 entries (the 529 startup-death signature: 8/10 sessions dead at 4 activities in the measured incident) retries: `initializeAgentRunner` captures its own arguments per session (`startupRetryState`, attempts preserved across replays); `handleLaneSessionEnded` consults `maybeScheduleStartupRetry` FIRST — a scheduled retry skips the mirror end-of-work transitions and releases the lane with reason `startup_retry`. Classification (`classifyStartupError`): permanent markers WIN over co-occurring transient ones (billing/auth never retry — standing rule); only enumerated transients (529/overloaded/429/rate-limit/5xx/conn failures) retry; unknown = permanent. Backoff 30s×2^n, ≤4 attempts, +≤25% jitter. Replay re-acquires the lane (lane-busy re-waits 60s without consuming an attempt, 30-min deadline) and guards on the session still existing (PON-135 lesson). A failed attempt's held error "summary" is discarded from the verification gate — a raw API error must never deliver. Exhaustion → `CLIENT_MESSAGES.sessionStartFailed()` as an error activity (posts on quiet workspaces too) + `startup_retries_exhausted`.

### Model allowlist (PON-147) + 0600 writes (PON-148)

PON-147: the result-time pin check now asserts EVERY model in `modelUsage` — pin or `KNOWN_INTERNAL_MODELS` (only `claude-haiku-4-5`, verified against 12h live + 62 historical lines) — anything else fails the session naming the model and its token share. Allowlist, not threshold. Dominant-model PON-110 drift unchanged. Note: the dispatcher swallows the throw by design; the failure mechanism is session status=error + the drift thought — tests assert THAT.

PON-148: all four config-updater writes (config/env + backups) are `{mode: 0o600}` + `chmodSync` (mode applies only on create — the chmod is what makes rewrites of pre-existing 0644 files CORRECT rather than accidentally so). Retention decided: bounded at 5 newest per backup family (`pruneBackups`, best-effort, never fails the write).

### Work-in-progress links held from the client (PON-221)

Found live by Harold on the ACM-5 run: a clickable draft-PR link on the client's thread while the work was still in review. **External URLs are a session SURFACE write, not an activity** — `AgentSessionManager.publishLinks` calls `updateSessionSurface(sessionId, {addedExternalUrls})` — so they reach a client through neither the client-quiet funnel nor PON-152's final-response interceptor, both of which only ever see activities. This is the FOURTH path to a client surface and the first that is not a post; the other three are `postActivity`, `syncEntryToActivitySink` and `ActivityPoster.postActivityDirect`.

- **Held, not dropped.** `setLinkPublicationHold(fn)` mirrors `setFinalResponseInterceptor`'s shape; links found while held accumulate in `heldLinks` (deduped by url, journaled `[event:client_links_held]`) and are attached by `releaseHeldLinks(sessionId)` from `deliverHeldSummary`, immediately after the strict summary post succeeds. A link the client never gets is as wrong as one they get too early.
- **The predicate is `linksHeldForSession`, NOT client-quiet.** PON-182 decoupled quietness from the gates, so a workspace can be quiet with no release event ever coming — holding there would strand links forever. Held means `verificationGateEnabled(workspaceId)`: there is an approval coming. Operator sessions are excluded FIRST and explicitly, the same trap `clientQuietSession` documents — their subject is the client's repository, so every workspace lookup would otherwise resolve against the CLIENT's workspace and hold the links on the one surface built to show them.
- **This hold fails CLOSED**, unlike the poster it sits beside: a suppressed link costs the client one look at their own repository; a leaked one hands them work in progress. Only the second is unrecoverable.

Also in PON-221, all operator-surface: `endNarrationTurn` posts a plain-words sign-off as a `response` (the activity TYPE is what tells Linear the turn completed — a thought leaves the session reading "Stopped responding") on the verification, delivery and needs-info paths; `ASK_CLIENT` accepts plain phrasing but requires `client(?![-\w])` and a non-empty question — the first draft's `\b[:,-]?` matched "ask the client-**facing** team…" and would have sent the client "facing team to review the copy"; `stateSince` (v4.x, on `SerializedCockpitMirror`) plus `formatMirrorAge` render the mirror's OWN age, preserved across re-renders of an unchanged state and compared against the position-suffixed `nextState` so a re-rank never restarts the clock. `DESCRIPTION_VERSION` bumped to 4 — bump it in the same commit as any rendering change, or existing mirrors keep showing the old body.

### The client is delivered what actually merges (PON-210)

Found on the PON-208 acceptance run: the client received the FIRST-PASS summary after review had changed the code. Not introduced by PON-208 — surfaced by it, because operator iteration is the first thing that can change the code *after* `holdCompletionForVerification` captured the summary. Operator sessions are exempt from the gate (correctly: gating them would mint a second pending delivery and overwrite the client's summary with text written for the reviewer), so nothing refreshed it.

- **The head the summary describes is now kept.** `capturedHeadSha` on the verification record (v4.13). Set from `buildStartHereBlock`, which already fetches the PR head to build the review block and runs immediately after capture — so it costs no extra API call. `recordCapturedHead` is **write-once**: the mirror recomposes on a refresh clock and on boot, and a setter that overwrote would re-point the record at the current head, erasing the very staleness it was looking for. `recordPending` rebuilds the record wholesale, so a genuinely new summary re-captures.
- **`summaryStaleness` returns undefined for "no" AND "cannot tell"**, deliberately the same answer: no captured head (a pre-release record), no own-repo PR, no token, a failed lookup. A delivery is only ever held on two facts that differ. Blocking a client's delivery on something we do not know would be worse than the bug.
- **There is no bespoke rewrite path — the refusal points at `reject:`.** The first cut resumed the CLIENT session fire-and-forget to regenerate the summary. Adversarial review killed it: the same message invited the reviewer to override, so an override marked the record `delivered`, which opens the gate — and the in-flight rewrite then posted ITSELF to the client with nobody having read it. It could also move the branch (invalidating the override SHA), ignored `operatorHoldsBranch` (`mine`), and could drop the PR link from `prUrls`, silently losing the draft-PR readying. `reject: <feedback>` already resumes the session correctly, clears the record and holds a fresh summary with a fresh captured head. Do not build a second resume path next to it.
- **`staleNotifiedForSha` is the override, keyed by SHA rather than a boolean.** Approving again on the same head delivers (the reviewer has been told and chose to proceed); if the code moves *again* after the warning, the next approve warns again rather than shipping a summary that is stale in a new way. A gate the human it reports to cannot override is a gate that gets worked around.
- The check runs beside PON-171's notes check, **before anything irreversible** — no PR readied, nothing posted, links still held.

### Approval parks the work (PON-224, v3 cockpit step 1)

Scope approval no longer starts implementation. The auto-start was intrinsic — the approval answer resolved into the blocked `AskUserQuestion` call while the gate block said "proceed with the work as described" — so the change is intrinsic-first too, with bookkeeping around it:

- **The gate block's approve instruction is now confirm-and-stop**, and `buildImplementationParkedBlock()` is injected (same points as the gate block: new sessions and resumes, never child/operator sessions) whenever the issue's approval record carries `implementationDeferred`. Between approval and implementation start, every client-thread session converses and never implements.
- **`implementationDeferred` (v4.14) is set by `recordApproved` on the real transition only** — a replayed approve webhook cannot re-park started work. `markImplementationStarted` clears it (the delegate-to-start increment calls this); legacy records approved under auto-start carry no flag and behave exactly as before.
- **The mirror is born `queued` unconditionally** with reviewers subscribed at birth (queued work is claimable work). A runner on a parked issue (the confirmation turn, a follow-up answer) mirrors `queued`, never `active`; so does a needs-info answer.
- **The confirmation turn is exempt from the PON-152 hold** — there is nothing to verify. The exemption is scoped to the flag, so a `reject:`-resumed regeneration (approved, flag long cleared) is held exactly as before. Deliberately NOT mirrored into `linksHeldForSession`: a parked session should mint no links, and a leaked one is released at eventual delivery — held is safe, leaked work-in-progress is not.
- **Parked work is live work**: `shouldCloseCockpitMirror` keeps the mirror open when the scoping session ends, reconcile counts `listDeferred()` as a `parked` category (upserted `queued`; a lane-derived entry for the same issue wins, it carries the position), and the terminal-issue prune sweeps deferred records alongside pending ones.
- Between this increment and delegate-to-start, delegating a parked mirror gets an honest "Queued — not started" reply instead of "Work is underway".

### Delegating a queued mirror starts the work (PON-225, v3 cockpit step 3)

`startWorkFromMirror` is the fresh-start twin of `runOperatorIteration`. Same subject/surface split (client repository and credentials, cockpit thread), same registration, so every operator exemption applies unchanged. What differs follows from there being no prior run:

- **Entry**: on a parked issue (`scopeApprovals.isImplementationDeferred`), both `orient` (a bare delegation) and `iterate` (a comment) start the work, the comment riding in as extra instruction. `mine`/`handback` say there is nothing built yet. **Starting is reviewer-gated** — it joins approve/reject/ask-client, because the stated cost that leaves `iterate` open ("nothing they can do reaches the client or ships anything") does not survive a path that pushes a branch and opens a PR on the client's repository.
- **The lane is taken.** Unlike a review turn, this IS the client's build, which is what PON-112 serializes. A busy lane refuses with the issue that holds it rather than queueing: the reviewer picked this moment, so an invisible wait would be the wrong answer.
- **`ownsDelivery` on the link** is the one new concept. It narrows exactly one exemption — `holdCompletionForVerification` — because this run's closing summary IS the client's deliverable, not a report to the reviewer. Everything else stays wide, and two of those are load-bearing: `linksHeldForSession` must keep the blanket exemption or the PR/preview links are held on a session id `releaseHeldLinks` is never called with, and `handleLaneSessionEnded` must NOT take the operator early-return or the mirror never reaches in-verification.
- **The record names the CLIENT session, not the mirror one.** `deliverVerifiedWork` posts to `record.sessionId`; storing the mirror session would deliver the client's work onto the cockpit thread and mark it delivered anyway. `sessionRepoOriginRef` and `buildCheckoutInstructions` want the client side too.
- **`reject:` continues on the mirror session** for delivery-owning work — resuming the record's session would move the conversation off the thread the reviewer is standing in.
- **The credential follows the cockpit.** `buildAgentRunnerConfig` reads `operatorSessions.get(sessionId)?.cockpitWorkspaceId` first. Deliberately not a new parameter on `resumeAgentSession`: its `linearWorkspaceId` is dual-purpose and also selects the tracker that fetches the issue, so passing the cockpit id there fetches a client issue from the wrong workspace and throws before any runner starts.
- **`buildMirrorImplementationBlock`, not `buildOperatorSessionBlock`.** The latter forbids a client-facing summary, which is precisely what this run must end with. Narration is for the reviewer; the closing summary is for the client, and it must spell the PR and preview URLs out in full because they are read back out of that text.

### Machinery must not fabricate a surface (PON-227)

Two defects of one class, both found live during the acceptance run: a surface said work was happening when none was.

- **A parked mirror looked busy.** The mirror's narration thread is a real Linear agent session, client narration is shadowed onto it (PON-212), and a turn is closed only by a `response` — so between approval and the reviewer starting, the thread sat in Linear's `active` state with a running timer, quoting a stale plan item from the client's scoping session. Nothing was running. `handleLaneSessionEnded` now signs the turn off when a **client** session ends on a parked issue: the shadow has finished writing, and the honest state is "queued, nobody has picked this up". It self-corrects — a later client turn reopens the thread and its own end closes it again. Guard on `!operatorLink`, or an operator turn would sign off as if it were the client's.
- **A dead session grew a second thread.** `recoverMissingSessionForAssignment` (PON-200) guarded on *live* sessions, and a session that DIED also leaves none live — so after a billing-error death it opened a second agent thread on the client's issue, as doomed as the first. It now also checks `agentSessionSeenAt`: a thread Linear opened within three grace windows belongs to THIS delegation whatever became of it. The case PON-200 exists for — a re-delegation notification with no session at all — has no recent thread by definition.

The rule worth carrying: **liveness is not existence.** Any recovery that asks "is something running?" to decide "did anything happen?" will fire on every failure path it was never meant to cover.

### The reviewer gets a finished turn (PON-229)

Three symptoms, one cause. The verification gate suppresses a mirror run's final response — correctly, it is the client's and it is held — but **a Linear turn is closed only BY a response**. So the implementation session ran forever: no finished moment, the reviewer's own messages queued behind a turn that never ended (making in-session iteration impossible), and nothing announced that work was ready. The work was done and the surface could not say so.

- **`signOffIntoVerification` is thread-aware.** On an `ownsDelivery` link it hands off on the session that did the work; otherwise it keeps signing off on the narration thread as before. The two are different threads on one mirror, and the reviewer is standing in the first.
- **The hand-off is a different register from the client summary, deliberately.** Commit, PRs, the review block, checkout instructions, the action legend — plus the run's own `record_operator_note`, which the mirror-implementation block now asks for before the final message: what changed and why per file, how to check it on the preview with which test login, and what the reviewer might decide differently. Facts readable off the PR are added around it, so the note does not spend itself repeating them. The held client summary is untouched.
- **A comment carries the notification.** An agent activity does not reach an inbox; a comment on an issue the reviewer is assigned to does. `commentOnMirror` already existed for exactly this reason on the escalation path.
- **The narration thread is pointed at the live one when work starts.** Otherwise the parked sign-off ("nothing is running here") stays standing and turns false the moment work begins — which is precisely how a run sixteen minutes deep was reported as stuck.

Guard is `verificationSignedOff`, cleared on deliver and reject, so a second round of review signs off again.

### A question must never mutate the branch (PON-228)

Found live on CKP-22: the reviewer asked *"why did you make metric-definitions.ts its own file instead of keeping the notes inline?"* — a question about a decision — and the session edited files, committed, pushed a second commit onto the branch under review, and rewrote the pull-request description.

Nothing in the chain was broken. `classifyMirrorIntent`'s catch-all is `iterate` (deliberately — refusing plain instructions was the defect PON-208 fixed), and `buildOperatorSessionBlock` told the session to "work exactly as you did before… commit and push as usual". A question arrived wrapped in *carry on working*.

`request-intent.ts` is one mechanism for two surfaces, because it is one failure:

- **Reviewer thread** (`buildReviewerRequestBlock`, added to every non-handback operator iteration): question → answer, change NOTHING; directive → implement; unclear → one short question. A handback is exempt — `back to you: <what I changed>` is a directive by construction, and offering a way to read it as a question is how a handback stalls.
- **Delivered client thread** (`buildDeliveredRequestBlock`, added by `sessionRuleBlocks` once the gate says `delivered`): question → answer in their language from what was delivered; change request → restate as a deliverable and get confirmation, never act directly, because a change made straight onto delivered work is a change nobody reviewed.

Intrinsic, not a classifier: free English is exactly the shape a code-side matcher fails on, and enforcement has already failed here three times. What the machinery guarantees is that the question is always **asked**, on every turn, on both surfaces.

**The asymmetry is load-bearing.** Both blocks say which way to fall and why: answering something that wanted action costs one message, while acting on something that wanted an answer rewrites a branch someone was mid-review of — or changes delivered software in front of the client who owns it.

### The client's merge closes the cycle (PON-230)

Delivery hands work to the client; it no longer finishes it. The mirror moves to **In client review**, and only their squash-merge (or a cancel) reaches Done.

- **Two new states**, `in-client-review` and `rework`, in `COCKPIT_STATES` + `COCKPIT_STATUS_NAMES`. Status adoption is by name and **all-or-none** (`CockpitMirror.ts` `ensureTeamSetup`) — ship a name before the status exists in the CKP team and *every* mirror loses its column, not just the new ones. Create the statuses and the state labels first; the per-team setup is cached for the process lifetime, so it also needs a restart.
- **Ranks**: `rework` takes the gap PON-219 left at 2 — ahead of active and everything queued, behind in-verification and needs-info, which are finished work already blocked on a human. `in-client-review` sits at 5: not the reviewer's turn, not finished. `queued` and `rework` join `WAITING_STATES` (since PON-224 the reviewer *starts* parked work, so it is waiting on them); `in-client-review` deliberately does not, or the board would offer work the client is holding.
- **Reconcile must know both states.** It closes anything it cannot see, into Canceled, and an item can sit in client review for days — this is the highest-severity trap in the change. `shouldCloseCockpitMirror` gained the matching clause, or a stray follow-up session ending would close the mirror out from under the cycle.
- **The record state stays `delivered`.** Four behaviours key on that literal (the delivered-thread request block, the link-hold release, follow-up posting, the double-delivery guard). The client-review phase is `delivered` + a `mergeWatch` + no `mergedAt`, not a new record state.
- **Merge detection polls**, folded into the 3-minute mirror-refresh clock. The merge fact was already in a response that clock makes and discarded. Webhooks lose decisively: the App subscribes to **zero** events with no webhook URL (0 deliveries in 30 days), prod runs the transport in proxy mode where payloads are explicitly not origin-verified, and enabling the App's webhook would start delivering `issue_comment` for every PR in every client repo — with `GITHUB_BOT_USERNAME` unset, every one of those starts a session. Detection is up to one interval late; that is the stated cost.
- **Everything fails UNKNOWN.** A missing token, a 404, a rate-limit or a parse failure is never "not merged" and never "merged" — same posture as `summaryStaleness`. A PR **closed without merging** is not a completion: it is a client rejecting work, so it goes to the reviewer once and the item stays put.
- **Close-out order is load-bearing**: client close-out → mirror comment → move their issue to completed. That last write fires the terminal path, which removes the record, closes the mirror and deletes the worktree.
- **`releaseHeldLinks` cannot attach the client's links on a mirror-originated run** — they were published to the mirror session, so nothing is held under the client's id. `attachClientDeliveryLinks` writes them explicitly, or their Linear renders a delivery with no Diff and no merge button.

### The client's summary is handed over, not scraped (PON-230)

Twice a mirror run ended its final message with a line addressed to the REVIEWER — *"Done and verified. Here's the state"*, then *"Hand-off recorded. Two things flagged for you"* — and the client received it, because the final-response interceptor captures the whole message. Sharpening the instruction fixed the first shape; the next run found another.

So the client's text stops being scraped from free-form output. `record_operator_note` gained a `client_summary` input, and the mirror-implementation block asks the run to hand the summary over there. `holdCompletionForVerification` prefers it over the final message. Exactly PON-196's move — the scope stopped being a comment the model posted and became something the machinery carried — for the same reason: a client-facing artefact should not depend on a model choosing the right words in the right place at the right moment.

The final message goes back to being what it naturally wants to be: the reviewer's.

Guarded on `clientSummaryAt > link.startedAt`: the field persists across runs, and a previous run's client text is the same stale-artefact problem the hand-off note already hit once. No recorded summary falls back to today's behaviour.

Also here: **we no longer post `Session stopped — <ID> was marked as Done or Canceled` on a thread we ourselves just closed out.** Observed live on the first merge-closes-the-loop run — the client got "Merged — this is now part of your project", then that. `selfCompletedIssues` suppresses it for the seconds between our own write and the webhook it causes.

### A change request reopens the work

Delivered work is never edited quietly. The delivered-thread block asks the client to confirm a restated delta using two canonical labels, and the machinery recognises the exact "yes" — the same shape the scope gate uses, because a client's agreement to more work is a decision to recognise exactly, not to infer from prose. Label-plus-note is read the way PON-230 taught the scope gate, since a client who picks an option and then explains is the normal case.

On confirmation: mirror to `rework` (rank 2 — ahead of every fresh start, behind work already on the reviewer's desk), reviewers subscribed, and an inbox **comment**, because a finished item reopening is exactly what a reviewer would otherwise learn about by accident.

Re-entry sets `implementationDeferred` back on the scope record, so it starts through the same admission point a first start uses — `mayStartParkedWork`, WIP gate included. No second start path beside the one that works, which is the PON-210 lesson about not building a second resume path next to `reject:`.

Guarded on the record being **delivered**: before that the client has been given nothing, so those labels must move nothing.

### The reviewer could not release their own work

Harold typed `approve: Verified on the preview…` into CKP-22's implementation thread and got back *"Only a configured reviewer can release work to the client."* He is the mirror's assignee — the same identity PON-225's check accepts to START the work. The journal named nobody: `{"clientIssueId":"b22fbd9d-…","intent":"approve"}`, no actor at all, twice (15:52:47, 15:53:05 — he tried again).

The check was right; **the actor was never resolved**. The prompted path read `agentSession.creator`, which Linear documents as "unset if the session was initiated via automation or by an agent user" — and a mirror's implementation session is routinely created by our own PON-200 re-delegation recovery. So `creator` is unset **by design on exactly the threads a reviewer works in**, and the reviewer check failed closed on an unresolvable actor. Same failure family as PON-225, where a delegation's actor was on the notification rather than the webhook: identity does not live in one field, and a path that assumes it does works right up until the session is born a different way.

- **`resolveMirrorActor` reads four sources in order of richness** — `agentActivity.content.user` (the transport's own source of truth for a prompt's author), `agentActivity.userId`, `agentSession.creator`, `agentSession.comment.user` — and both entrances to `handleMirrorAction` use it, so the created and prompted paths can never disagree about who is asking. It resolves **who is asking; it never decides whether they may**. The membership check is untouched — a stranger is still refused.
- **A later source may supply the name an earlier one lacked, matched on id** so two people can never be spliced into one actor. That is what makes the refusal journal readable: this bug cost a dig precisely because the line named nobody.
- **The refusal tells the truth about which failure it is.** `no_actor` → "I couldn't verify who sent that… this is about attribution, not about you"; `not_a_reviewer` keeps the old words. Telling the actual reviewer they are not one sent the diagnosis in exactly the wrong direction — the message named a permission problem when the system had an identity problem.
- **`deliveriesInFlight` closes the concurrency window.** The `state === "delivered"` replay guard catches a *sequential* second approve, but the record is not marked until after the post, so two arriving together both passed it. A client receiving their delivery twice is the kind of thing that only ever happens in front of them.
- **Comment webhooks reach no mirror listener**, asserted for both live shapes: `Comment`/`create` (what Linear actually sends, and it matches no guard — it falls off the end of the dispatch chain) and `AppUserNotification`/`issueNewComment` (the branch that returns early). Typing one `approve:` emits a comment webhook AND a prompted event 150ms apart, so this is the double-fire that would be invisible until a client saw it. The first draft of this test used the `Comment` shape against the `issueNewComment` branch and passed under mutation — **vacuous**, because the payload matched neither. Mutation-checking is what caught that.

All four fixes mutation-checked: reverting each one fails its test.

### One preview link, and it opens

Four defects found by a reviewer reading a delivery *before* releasing it — the read Harold made because the summary was nowhere he could find it.

- **The client got two preview links, one of them dead.** The footer's link is built with the tenant's bypass value, but the held summary is posted VERBATIM, and a run that wrote a preview URL into its own prose wrote the bare one. Followed unauthenticated, it 302s to the hosting provider's login — which the client has no account for. Worse, the two could point at different builds: the prose link is the deployment of whatever commit the run finished on, the reviewer verified the head as it now stands. `clientPreviewUrl` now RESOLVES the link for `capturedHeadSha` — the same fact the staleness gate is keyed on — instead of scraping prose. That is PON-230's move applied to the link: a client-facing artefact must not depend on a model writing the right URL in the right place. Only a **ready** deployment is offered (a link that 404s while building teaches the client the link lies), and it falls back to the scraped link rather than shipping none, because a delivery with no way to see the work is worse.
- **`bypassPreviewLinksIn` is the safety net, not the fix.** Runs are now asked to leave links out of the client summary entirely, so on a regenerated summary it finds nothing. It exists for summaries already held under the old scraping path, where the alternative is knowingly shipping a dead link.
- **The summary was rendered inside the file list.** The blank line before `**What the session reported:**` was a bare `""` element in an array ending `.filter(Boolean)` — which removed it. The heading landed on the line after the last `Files changed` bullet and Markdown read it as a continuation of that list item. The blank line is now part of the heading string. A reviewer could not find the client's summary on the mirror; that is a rendering bug, not a reviewer problem.
- **`reject:` could destroy the summary it exists to regenerate.** `VerificationGate.reject()` DELETES the record, and the resumability check came after it — so a rejection that could not resume cleared the client's held summary and had nothing to replace it, surviving only truncated to 3000 characters in the mirror body. Resolve session and repository FIRST, delete second, and refuse honestly while leaving the record deliverable. It did not bite on ACM-21 only because `sessionRepositories` is rebuilt on boot from the persisted `issueRepositoryCache`; that is a happy accident of another feature, not a guarantee this path was entitled to.
- **The regeneration path now asks for the hand-over.** `reject:` is the designated rewrite route (PON-210 refused to build a second one beside it), so it is where PON-230's `client_summary` hand-off has to be requested — otherwise every regeneration silently falls back to scraping, which is the exact failure PON-230 exists to remove. The same prompt forbids URLs in the summary, since the delivery composes the one link itself.

All five mutation-checked. The first draft of the rendering test asserted array-join semantics rather than the composer's output — decorative, and it passed under mutation; it now drives `composeVerificationMirror` and reads the note the mirror actually receives.

**Follow-up, same issue:** telling the rewrite to omit URLs silently removed the client's merge path. `recordPending` scrapes `prUrls` out of the summary's prose, so a regeneration — which only restates what was already built and has no reason to name a URL — produced a record with no pull request: nothing to mark ready, no merge line, and no head for the staleness check or the preview lookup to resolve. Two changes: the instruction now forbids only the PREVIEW url (naming the PR is expected), and the gate carries the last known `prUrls` across a rejection, because the pull request is a fact about the WORK, not about the run that last described it. A rewrite naming a different PR still wins. The carry is in-memory, so a restart mid-rewrite degrades to the old behaviour rather than to anything worse.

### The client's session carries the work (PON-231)

The delivery already sets the pull request and the bypassed preview as **external URLs on the CLIENT's agent session** (`attachClientDeliveryLinks` → `agentSessionUpdate(addedExternalUrls)`), and has since PON-230. Verified live on ACM-21: `client_delivery_links_attached count: 2`, and Linear returns both on the session. **The app half was never the gap** — a delivery that shows as links in text rather than a Diff tab is a workspace-integration gap on the client's side, not a missing call.

It had no test, which is how "already works" quietly becomes "used to work". Five guards now, all mutation-checked: both URLs are set; they target the CLIENT session and never the mirror (getting that backwards renders the delivery on the cockpit and leaves the client with prose); the preview keeps its access value (stripping it hands them a login they cannot pass); an empty set sends no update; and a failure to attach never fails the delivery — the summary IS the delivery, so losing the native surface is a degradation while losing the summary is the product failing.

**What the native surface actually requires, client-side** (Linear docs, `linear.app/docs/diffs` and `/coding-sessions`): the workspace connects the GitHub integration AND grants **code access** for the repository — code access is the separate permission that turns a PR link into a Diff, and an already-connected workspace still has to add it. Then, per person: a personal GitHub connection under Connected Accounts, and Settings → Code & reviews → *Enable code reviews*. Merging from Linear runs **as the authenticated GitHub user**, so that person needs write access on the repo — and if the GitHub org uses an IP allow list, Linear's IPs must be added or diffs and review actions silently fail. None of this is reachable from our side: we hold no credential for the client's Linear or their GitHub org, so it is an onboarding step we ask for and confirm by asking, never something we can check (the standing "we can only see the repository" constraint).

Link-based delivery is the documented fallback when a client skips it, and it is why the footer's links must be complete and correct on their own.

### Issue-number decoder — read this before citing a PON number

Several sections above were written under working labels that **never existed as Linear issues**. The labels were invented in commit messages and PR bodies before the issues were filed, and the numbering drifted. Every editable artefact (these headings, PR bodies, board text) has been remapped to real numbers; **merged commit messages were left as they are**, so this table is the permanent decoder for `git log`.

| Cited in a merged commit | What it actually is |
|---|---|
| PON-226 — "Machinery must not fabricate a surface" | **PON-227** |
| PON-228 — "The reviewer gets a finished turn" | **PON-229** |
| PON-229 — "A question must never mutate the branch" | **PON-228** |
| PON-233 — "The client's merge closes the cycle" | **PON-230** |
| PON-234 — per-company WIP = 1 | **PON-230** (documented in its body) |
| PON-235 — "Hand the client's summary over" | **PON-230** (its defect #1) |
| PON-236 — "A change request reopens the work" | **no issue** — PON-230's "Not in this increment" follow-up |
| PON-237 — "The reviewer could not release their own work" | **no issue** — see the section above |
| PON-238 — "One preview link, and it opens" | **no issue** — see the section above |
| PON-239 — "The client's session carries the work" | **PON-231** |

Note that 228 and 229 are a genuine **swap**, not a shift: each commit cites the other's number. A sequential find-and-replace collapses them onto one number — use placeholders.

**Standing rule, from 2026-09-01: never cite an issue number you have not read back from Linear in the same session.** Filing the issue first and quoting the number it was actually assigned costs one API call; the alternative produced ten wrong citations across six merged commits and a documentation file that future sessions read as ground truth. A number that cannot be resolved is worse than no number, because it sends the reader looking for context that was never written.

### A reviewer can stop a runaway mirror session (PON-223 punch list)

The mirror intercept in `handleUserPromptedAgentActivity` returned unconditionally **before** the stop check, so on a mirror thread a stop never reached its handler. Worse than a no-op: Linear's Stop button sends an empty body, and `classifyMirrorIntent` reads an empty body as `orient` — a **claim**. Pressing Stop on a runaway announced "I am taking this" and let it keep running; typing "stop" was passed in as work.

This is the one control that matters most on that surface. An operator session works the **client's** repository on the **client's** credential, so a run that will not stop spends their budget and can keep moving a branch under review. Required before any real client.

The stop is now ordered above the intercept — deliberately there rather than inside `handleMirrorAction`, because a stop is not an operator action on the work, it is a control on the runner. `handleStopSignal` already resolves mirror sessions (they live in the same session manager), already handles the queued case, and already closes the turn with a confirmation, so the fix is ordering, not new machinery. The confirmation now names the actor via `resolveMirrorActor` — the same attribution gap that broke the release check had it thanking "user".

Also here: **a canceled waiting room is never resurrected.** Reuse of a *closed* room is the designed cycle, but cancellation is a human saying that copy is dead — usually while tidying duplicates — and the tidying itself makes the canceled copy the most recently updated, so the old selector would have elected the corpse and put the live list of waiting conversations inside an issue the board shows as abandoned. It mints a fresh room instead.
