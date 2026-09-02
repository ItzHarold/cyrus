/**
 * Client-facing message templates (PON-168 / R2).
 *
 * Every literal here lands on a TENANT surface. Keeping them in one module
 * is what makes the content-policy sweep total: the sweep test iterates
 * these exports (plus literal-extraction over the other registered emitting
 * modules), so a banned term in any of them is a test failure, not a
 * production incident.
 */

import type { AgentSessionPlanStep } from "cyrus-core";

export const CLIENT_MESSAGES = {
	/** PON-161: worktree creation refused at session start. */
	worktreeRefusedAtStart: (repositoryName: string) =>
		`This session could not start: the latest code for ` +
		`**${repositoryName}** could not be fetched, and starting against a ` +
		`stale copy would be worse than not starting. The operator has been ` +
		`notified — once repository access is restored, re-delegate this issue.`,

	/** PON-164: worktree creation refused on resume. */
	worktreeRefusedOnResume: (repositoryName: string) =>
		`This session could not resume: the latest code for ` +
		`**${repositoryName}** could not be fetched, and continuing against a ` +
		`stale or missing copy would be worse than stopping. The operator has ` +
		`been notified — once repository access is restored, re-delegate this issue.`,

	/** PON-164: re-creation produced no usable working copy. */
	workspaceUnpreparable: () =>
		`This session could not resume: a clean working copy of the ` +
		`repository could not be prepared. The operator has been notified — ` +
		`re-delegate this issue once the repository is healthy again.`,

	/** PON-139: undeclared workspace refusal. */
	workspaceNotConfigured: () =>
		`This workspace is not configured to run sessions on this host — its ` +
		`credential is missing or unavailable. The operator has been notified; ` +
		`once configuration is fixed, re-delegate this issue.`,

	/**
	 * PON-194: the repository picker failed to post. The raw exception used to
	 * be interpolated onto the client's thread — network stack text, GraphQL
	 * payloads, sometimes request URLs. The client gets the state; the
	 * operator gets the exception, in the journal.
	 */
	repositorySelectionUnavailable: () =>
		`This issue could not be started: we could not confirm which ` +
		`repository it belongs to. The operator has been notified — no action ` +
		`needed from you.`,

	/**
	 * PON-202: delivery is blocked on our side. Said when a push or a pull
	 * request cannot be completed — never with the reason, never with a
	 * workaround. A client asked to fetch a branch or apply a pasted diff has
	 * been handed our outage as their chore.
	 */
	deliveryBlocked: () =>
		`This one is delayed: we hit a problem on our side getting the work ` +
		`to your repository. We are fixing it and will post the pull request ` +
		`here as soon as it lands. Nothing is needed from you.`,

	/** PON-152 ladder: the honest delay note on the client's issue. */
	verificationDelayNote: () =>
		`This one is taking longer than planned — the work is in final ` +
		`verification on our side. No action needed from you; we'll post the ` +
		`result here as soon as it clears.`,

	/**
	 * PON-138: retries at session start ran out against a provider outage.
	 * Honest, client-framed, and actionable without being alarming.
	 */
	sessionStartFailed: () =>
		`We hit a temporary problem on our side starting this one, and ` +
		`automatic retries didn't get through. The operator has been ` +
		`notified. Nothing is needed from you — re-delegating the issue ` +
		`later will also restart it.`,

	/**
	 * PON-179: the one generic status a quiet client stream shows instead of
	 * working narration — liveness without the diary.
	 */
	workingStatus: () =>
		`On it. This thread will update when there's something for you to ` +
		`review or answer.`,

	/**
	 * PON-171: the delivery footer appended to the held summary when the
	 * operator approves. Sections render only when present; an empty call
	 * renders nothing.
	 */
	deliveryFooter: (
		previewUrl?: string,
		mergeUrls?: string,
		reviewNotes?: string,
		signature?: string,
	) => {
		// The preview link can carry a bypass value so it opens without an
		// account on the hosting provider. That value is yours and you can
		// regenerate it at any time — which silently kills every link already
		// sent, including this one. Better said here than discovered months
		// later on an old message, so the pull request is named as the record
		// that keeps working.
		const previewIsTemporary =
			previewUrl !== undefined &&
			/[?&]x-vercel-protection-bypass=/i.test(previewUrl);
		const lines = [
			previewUrl ? `**See it working:** ${previewUrl}` : "",
			previewIsTemporary
				? "*(That preview link works because it carries your access value. If you regenerate it, this link stops opening — the pull request below is the permanent record.)*"
				: "",
			mergeUrls ? `**To take it:** merge ${mergeUrls}` : "",
			reviewNotes ? `**Notes from our review:** ${reviewNotes}` : "",
			signature ? `**${signature}**` : "",
		].filter(Boolean);
		return lines.length ? `---\n${lines.join("\n")}` : "";
	},

	/**
	 * What to do with what you have just been given (PON-233).
	 *
	 * The cycle no longer ends at delivery — it ends when the client merges.
	 * That has to be said, or a delivered pull request sits open because
	 * nobody told them the last move was theirs. Deliberately plain about
	 * who does what: they review, they merge, and the work is theirs from
	 * that moment.
	 */
	reviewAndMerge: (testAccounts?: string) =>
		[
			`Have a look and try it. When you're happy, squash-merge the pull ` +
				`request above and it's live in your project — that merge is yours ` +
				`to make, and nothing lands in your main branch until you make it.`,
			testAccounts ? `**Sign in with:** ${testAccounts}` : "",
			`If something isn't right, or you want it to do something else, just ` +
				`reply here and tell us.`,
		]
			.filter(Boolean)
			.join("\n\n"),

	/**
	 * The close-out, posted when their merge is observed (PON-233).
	 *
	 * Short on purpose: the work is done, they did the last step, and the
	 * thread should end rather than trail off.
	 */
	mergedCloseOut: (what?: string, cycle?: string) =>
		`Merged — ${what ?? "this"} is now part of your project. Thanks for ` +
		`the review.${cycle ? ` Start to finish, ${cycle} from the go-ahead.` : ""} ` +
		`If anything about it needs changing later, open a new request and ` +
		`we'll pick it up.`,
} as const;

/**
 * The client-facing lifecycle plan (v3.1).
 *
 * Linear renders an agent session's `plan` as a numbered step list at the top
 * of the thread. A CLIENT session must never show the model's internal task
 * list there — that is the reviewer's surface, kept on the mirror. It shows
 * this fixed four-step lifecycle instead, and step status is driven by the
 * STATE MACHINE, never by the model: the phase is decided by where the issue
 * is (scope agreed → building → delivered → merged), not by what the session
 * happens to be doing. The strings are client language and pass the
 * content-policy sweep like every other export in this module.
 */
export type ClientLifecyclePhase =
	| "scoping"
	| "agreed"
	| "building"
	| "review"
	| "merged";

const CLIENT_LIFECYCLE_STEPS = [
	"Scope agreed",
	"In development",
	"Ready for your review",
	"Merged",
] as const;

// Explicit per-phase status for each of the four steps — spelled out rather
// than derived, so the surface a client sees can be read straight off the code.
const CLIENT_LIFECYCLE_STATUS: Record<
	ClientLifecyclePhase,
	Array<AgentSessionPlanStep["status"]>
> = {
	scoping: ["inProgress", "pending", "pending", "pending"],
	agreed: ["completed", "pending", "pending", "pending"],
	building: ["completed", "inProgress", "pending", "pending"],
	review: ["completed", "completed", "inProgress", "pending"],
	merged: ["completed", "completed", "completed", "completed"],
};

export function buildClientLifecyclePlan(
	phase: ClientLifecyclePhase,
): AgentSessionPlanStep[] {
	const status = CLIENT_LIFECYCLE_STATUS[phase];
	return CLIENT_LIFECYCLE_STEPS.map((content, i) => ({
		content,
		status: status[i] ?? "pending",
	}));
}
