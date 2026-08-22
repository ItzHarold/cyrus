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
