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

const ASK_CLIENT = /^ask[\s-]+client\b[:,-]?\s*([\s\S]*)$/i;
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
	if (askClient)
		return { kind: "ask-client", question: (askClient[1] ?? "").trim() };

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

Work exactly as you did before, in the same worktree and on the same branch,
and commit and push your changes as usual${input.branchName ? ` (branch \`${input.branchName}\`)` : ""}.

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
