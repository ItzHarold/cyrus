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

Deliberate exemptions, each load-bearing: branch references (`name/ref` shape) — Linear derives them from the app username, the client sees them in their own repo, rewriting one breaks the pointer; `cyrus-setup.sh`/`cyrus-teardown.sh` — the client's own documented convention files in THEIR repo (renaming the convention is a product decision, not a policy one).

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
