/**
 * Operator sessions (PON-208) — the cockpit mirror as a working surface.
 *
 * Until now a mirror was an approval gate: `approve` or `reject:`, and any
 * other word got a canned "discussion belongs on the client's issue". This
 * module is what turns the mirror into a place the operator can actually
 * work, by naming a distinction the system already made but never wrote
 * down:
 *
 *   SUBJECT  — whose work is this? Derived from the session's REPOSITORY
 *              (`resolveWorkspaceIdForSession`). Drives the Anthropic
 *              credential, the GitHub App token, the content policy, lanes.
 *   SURFACE  — where does the output go? A PER-SESSION activity sink
 *              (`AgentSessionManager.setActivitySink`), independent of the
 *              above.
 *
 * An operator session is registered with the CLIENT as its subject and the
 * COCKPIT as its surface. Everything follows from that one split:
 *
 *   - the client's credential pays for the client's work (the cockpit
 *     workspace is an apiKey tenant — billing it there would silently spend
 *     the metered budget on client iteration),
 *   - the client's App token pushes to the client's repo as usual,
 *   - and the client's thread stays silent STRUCTURALLY: the client's issue
 *     id is not reachable from this session's posting path. There is nothing
 *     to suppress, so there is nothing that can fail open.
 *
 * Pure bookkeeping. It resolves and remembers; it posts nothing and decides
 * no policy.
 */

import type { SerializedOperatorSession } from "cyrus-core";

export type OperatorSessionLink = SerializedOperatorSession;

/**
 * What the operator asked for on the mirror.
 *
 * `approve`/`reject` are PON-152's and stay exactly as they were — they are
 * decisions about delivery, not work. The three new verbs are about who
 * holds the branch:
 *
 *   iterate    — the default. Anything that is not one of the other verbs is
 *                a work request; it used to be a canned refusal.
 *   mine       — "I'll do this part myself in my IDE". The agent stops
 *                touching the branch and hands over the checkout command.
 *   handback   — "back to you": the agent resumes ON TOP of the operator's
 *                commits (fast-forward only; it never resolves by force).
 *   ask-client — the ONE deliberately client-visible action during
 *                iteration, and it is operator-initiated by construction.
 */
export type MirrorIntent =
	| { kind: "approve"; notes: string }
	| { kind: "reject"; feedback: string }
	| { kind: "mine" }
	| { kind: "handback"; notes: string }
	| { kind: "ask-client"; question: string }
	/**
	 * Recognised as an ask, but the question is not usable as written
	 * (PON-221) — a fragment, the wrong person, or nothing at all. Answered
	 * on the mirror with the syntax; nothing reaches the client.
	 */
	| { kind: "ask-client-unclear"; draft: string }
	| { kind: "iterate"; instruction: string }
	/**
	 * Arrived with no instruction — a bare delegation (PON-211).
	 *
	 * This used to be a silent no-op: a delegation carries no comment, so the
	 * body was empty, and we returned without a word. Delegating to the agent
	 * is the most natural way to pick a mirror up, and it did nothing at all.
	 * Now it means "I am taking this" — claim it and say what it is.
	 */
	| { kind: "orient" };

/**
 * Asking the client, in plain language (PON-221).
 *
 * `ask client: …` still works, but a reviewer mid-review writes "can you ask
 * the client whether they want the totals rounded" — and being told that is
 * not the magic phrase is exactly the kind of friction that makes a feature
 * go unused.
 *
 * The word **client** is required, deliberately. This is the one action that
 * reaches the tenant's own thread, so the asymmetry matters: failing to
 * recognise an ask costs a re-phrase, while misreading an internal
 * instruction as one puts operator words in front of a client. "ask them",
 * "check with them" and similar are NOT matched — "them" is ambiguous in a
 * thread that also talks about users, reviewers and maintainers.
 *
 * `client` must also END there: `(?![-\w])` is what stops "ask the
 * client-facing team to review the copy" from being read as an ask and
 * sending the client the words "facing team to review the copy". The first
 * draft of this pattern used `\b[:,-]?` and did exactly that — the hyphen it
 * accepted as a separator is the same hyphen that starts a compound noun.
 * A trailing separator is `:` or `,` only.
 */
const ASK_CLIENT =
	/^(?:(?:can|could|would|please)\s+(?:you\s+)?)?(?:ask|check\s+with|confirm\s+with|query)\s+(?:the\s+)?client(?![-\w])\s*([:,])?\s*([\s\S]*)$/i;
const HANDBACK = /^back\s+to\s+you\b[:,-]?\s*([\s\S]*)$/i;
/**
 * "mine" must be the WHOLE message. A bare "mine" is unambiguous; "mine is
 * a different approach — try X" is a work request, and reading its first
 * word as a handover would silently stop the agent mid-iteration.
 */
const MINE =
	/^(mine|i'?ll\s+take\s+(this|it)(\s+myself)?|taking\s+(this|it)(\s+myself)?)\s*[.!]?$/i;

/**
 * Classify a message on a mirror thread.
 *
 * Order matters: the specific verbs are tested before the catch-all, and the
 * catch-all is `iterate` rather than a refusal — that inversion IS the
 * feature. An empty body is not work, so it stays a no-op for the caller to
 * refuse.
 */
export function classifyMirrorIntent(body: string): MirrorIntent {
	const text = body.trim();
	// A delegation carries no comment. That is not nothing — it is someone
	// picking the work up.
	if (!text) return { kind: "orient" };

	const approve = /^approve\b[:,-]?\s*([\s\S]*)$/i.exec(text);
	if (approve) return { kind: "approve", notes: (approve[1] ?? "").trim() };

	const reject = /^reject\b[:,-]?\s*([\s\S]*)$/i.exec(text);
	if (reject) return { kind: "reject", feedback: (reject[1] ?? "").trim() };

	const askClient = ASK_CLIENT.exec(text);
	if (askClient) {
		const separator = askClient[1];
		const rest = (askClient[2] ?? "").trim();
		// The question is posted to the tenant VERBATIM, so it has to be
		// written the way it should arrive. The reviewer speaks about the
		// client in the third person — "ask the client whether THEY want the
		// totals rounded" — while the message is addressed TO them, so
		// forwarding his phrasing as-is sends a fragment in the wrong person:
		// "for the logo files", "whether they want the totals rounded". No
		// pattern fixes that, because the pronoun is the problem.
		//
		// So a self-contained question is required: one written after `:` or
		// `,`, or anything ending in a question mark. Plain-language TRIGGERS
		// still work — no keyword to remember — the question itself just has
		// to be his own words for the client. Anything else is answered with
		// the syntax rather than guessed at.
		const selfContained = Boolean(separator) || rest.endsWith("?");
		if (rest.length > 0 && selfContained)
			return { kind: "ask-client", question: rest };
		return { kind: "ask-client-unclear", draft: rest };
	}

	const handback = HANDBACK.exec(text);
	if (handback) return { kind: "handback", notes: (handback[1] ?? "").trim() };

	if (MINE.test(text)) return { kind: "mine" };

	return { kind: "iterate", instruction: text };
}

/**
 * The instruction block for an operator turn.
 *
 * Intrinsic beats enforced (CLAUDE.local.md): the session is TOLD it is on an
 * internal thread and that the client cannot see it, rather than having that
 * fact policed after the fact. Structure already guarantees the silence — the
 * client's tracker is not reachable from this session — so this block exists
 * to make the model's *choices* match the situation: no client-facing
 * summaries, no marking the PR ready, no destructive git.
 *
 * Operator-surface text: it is never posted to a tenant, so it deliberately
 * speaks plainly about branches, PRs and review.
 */
export function buildOperatorSessionBlock(input: {
	issueIdentifier?: string;
	branchName?: string;
	resumedAfterOperatorEdits: boolean;
}): string {
	const ident = input.issueIdentifier ?? "this issue";
	return `

<operator_working_session>
You are continuing your work on ${ident}, but this thread is NOT the client's
issue — it is the internal review thread, and the person writing here is the
reviewer at Ponte Digital. The client cannot see anything in this thread.

If you are being asked to change something, work exactly as you did before,
in the same worktree and on the same branch, and commit and push as usual${input.branchName ? ` (branch \`${input.branchName}\`)` : ""}.
If you are being asked a question, answer it and leave the branch alone — see
the rule above about which this is.

Rules for this thread:
- Talk to the reviewer directly. They are technical: name files, show diffs,
  explain trade-offs. The client-facing register does not apply here.
- Do NOT post or write anything addressed to the client, and do not produce a
  completion summary claiming the work is delivered. Delivery is the
  reviewer's action, not yours.
- The pull request STAYS A DRAFT. Do not mark it ready for review under any
  circumstances — that is what the reviewer's approval does.
- If you need something only the client can answer, say so and stop. Do not
  contact them; the reviewer decides what reaches the client.

Git safety — the reviewer may have committed to this branch from their own
machine, and their work must never be lost:
- Never run \`git reset --hard\`, \`git checkout -- .\`, \`git clean -fd\`, or any
  form of force push (\`--force\`, \`-f\`, \`--force-with-lease\`).
- Push normally. If a push is rejected as non-fast-forward, integrate with
  \`git pull --rebase\` and push again; if that cannot be done cleanly, stop and
  say so rather than forcing.${
		input.resumedAfterOperatorEdits
			? `
- The reviewer has just handed the branch back after working on it themselves.
  START by running \`git pull --ff-only\` (or fetch and rebase) so you are on
  top of their commits, and read what they changed before doing anything else.`
			: ""
	}
</operator_working_session>`;
}

/**
 * The instruction block for the FIRST implementation run, started from a
 * queued mirror (PON-225).
 *
 * Same thread and same silence as an operator turn, one difference that
 * changes the whole shape: this run's final response IS the summary the
 * client receives. `buildOperatorSessionBlock` forbids exactly that — it is
 * written for a reviewer conversation after the work exists — so reusing it
 * here would produce a turn whose closing text must never reach a client,
 * which is the one text this run has to get right.
 *
 * The two registers coexist deliberately: narration is for the reviewer
 * (technical, files, trade-offs), the closing summary is for the client
 * (deliverable framing, no internals). That is the same split a client-side
 * implementation session already runs under; only the audience of the
 * narration moved.
 */
export function buildMirrorImplementationBlock(input: {
	issueIdentifier?: string;
	branchName?: string;
	clientScope?: string;
	instruction?: string;
}): string {
	const ident = input.issueIdentifier ?? "the client's issue";
	return `

<mirror_implementation_session>
This is the working thread for ${ident}. It is INTERNAL: the person reading is
the reviewer at Ponte Digital, and the client cannot see anything here. The
client has approved the scope below and is waiting; nothing reaches them until
the reviewer releases it.
${
	input.clientScope
		? `
The scope the client approved:

${input.clientScope}
`
		: ""
}
Do the work:
- Implement it in this worktree, on the branch already checked out${input.branchName ? ` (\`${input.branchName}\`)` : ""}. Do not create another branch.
- Commit and push to the client's repository as you normally would, and open a
  pull request there as a DRAFT. Leave it a draft — marking it ready is the
  reviewer's action at release, never yours.
- Verify your work the way you would on any change: build it, run the tests,
  and say what you actually ran.
${input.instruction ? `\nThe reviewer added: ${input.instruction}\n` : ""}
Talk to the reviewer WHILE you work. They are technical — name files, show
trade-offs, flag anything you are unsure about, ask them what you need to
ask. All of that belongs in the messages you send as you go, and the client
never sees any of it.

When the work is done, and BEFORE you write your final message, record your
hand-off to the reviewer with the record_operator_note tool. It is the last
thing they read before opening the diff, so write what a colleague would want
who is about to review your branch and cannot see this conversation:

- what changed and why, file by file — the reasoning, not a list of names
- how to check it on the preview: what to click, what they should see, and
  which test login to use for each thing worth trying
- anything you decided that they might decide differently, and anything you
  could not verify or need them to rule on

Facts they can read off the pull request — the commit, the file list, the
counts — are added around your note automatically. Do not spend the note
repeating them.

Your LAST message is different, and this is the one thing in this block to
get right. It is not a report to the reviewer. It is held, and on release it
is posted to the CLIENT, word for word, as the whole of what they receive.
Anything addressed to the reviewer in it reaches the wrong person — a
"here's the state" opener, a heading like "for you", a commit hash, a branch
name, a file path, a note about what you could not check: the client reads
all of it, and none of it was written for them.

So: say everything you have to say to the reviewer BEFORE you finish. Then
write the last message to the client, and to nobody else:
- Their language, not ours: what now works, and how they can see it working.
- No file names, no paths, no commit hashes, no branch names, no mechanics,
  no mention of this thread or of any review.
- Write the pull request URL and the preview URL out in full. They are read
  back out of this text to build the client's links — a shortened or
  paraphrased URL is a link they do not get.
- Describe what is actually true of the branch as it stands now.
- Do not include a second version of it, a heading introducing it, or
  anything after it. The message IS the summary.

If you need something only the client can answer, say so to the reviewer and
stop. Never contact the client yourself: the reviewer decides what reaches
them.

Git safety — the reviewer may commit to this branch from their own machine:
never \`git reset --hard\`, \`git checkout -- .\`, \`git clean -fd\`, or any force
push. If a push is rejected as non-fast-forward, integrate with
\`git pull --rebase\` and push again; if that cannot be done cleanly, stop and
say so rather than forcing.
</mirror_implementation_session>`;
}

/**
 * Destructive git, denied for operator sessions (PON-208, R9).
 *
 * Be honest about what this is: a guardrail, not a boundary. The tool layer
 * is not the OS (the PON-205 lesson), and a determined session can reach git
 * other ways. The actual guarantee that the operator's commits survive is
 * that the app pushes with an ordinary push and GitHub rejects a
 * non-fast-forward — this list, plus the instruction block, exist so the
 * model does not spend a turn trying.
 */
export const OPERATOR_GIT_DENY = [
	"Bash(git push --force*)",
	"Bash(git push -f*)",
	"Bash(git push --force-with-lease*)",
	"Bash(git reset --hard*)",
	"Bash(git clean -fd*)",
	"Bash(git checkout -- *)",
];

export class OperatorSessionRegistry {
	/** mirror agent-session id → link. The surface is the key: activities
	 * arrive addressed by it, and that is the hot path. */
	private byMirrorSession = new Map<string, OperatorSessionLink>();

	/** Restore from persisted state. Replaces whatever is held. */
	restore(links: OperatorSessionLink[] | undefined): void {
		this.byMirrorSession.clear();
		for (const link of links ?? []) {
			this.byMirrorSession.set(link.mirrorSessionId, link);
		}
	}

	serialize(): OperatorSessionLink[] {
		return [...this.byMirrorSession.values()];
	}

	register(link: OperatorSessionLink): void {
		this.byMirrorSession.set(link.mirrorSessionId, link);
	}

	get(mirrorSessionId: string): OperatorSessionLink | undefined {
		return this.byMirrorSession.get(mirrorSessionId);
	}

	/**
	 * Is this session an operator session?
	 *
	 * The question every exemption asks. It must be answerable from the
	 * session id alone — the callers (quietness, the scope gate, the
	 * verification gate) have nothing else in hand.
	 */
	isOperatorSession(sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.byMirrorSession.has(sessionId);
	}

	/** The live operator session for a client issue, if one is running. */
	forClientIssue(clientIssueId: string): OperatorSessionLink | undefined {
		for (const link of this.byMirrorSession.values()) {
			if (link.clientIssueId === clientIssueId) return link;
		}
		return undefined;
	}

	/**
	 * The client session whose conversation this operator session continues.
	 * Used for the claude-session-id write-back: an operator turn advances
	 * the id, and the client record must follow or the two forks diverge.
	 */
	clientSessionIdFor(mirrorSessionId: string): string | undefined {
		return this.byMirrorSession.get(mirrorSessionId)?.clientSessionId;
	}

	release(mirrorSessionId: string): void {
		this.byMirrorSession.delete(mirrorSessionId);
	}

	/** Drop every link for a client issue — it reached a terminal state. */
	releaseForClientIssue(clientIssueId: string): void {
		for (const [id, link] of this.byMirrorSession) {
			if (link.clientIssueId === clientIssueId) this.byMirrorSession.delete(id);
		}
	}
}
