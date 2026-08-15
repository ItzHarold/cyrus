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
