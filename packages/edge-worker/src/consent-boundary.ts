/**
 * Where consent falls in the mirror thread (PON-216).
 *
 * Harold approved ACM-19's scope and found the cockpit already showing work
 * done on it. Reconciled from the journal and Git, nothing had run: approval
 * at 22:11:03, worktree at 22:14:29, commit at 22:14:34. What he saw was the
 * scope session's own PLAN — a checklist containing "Verify and open the pull
 * request" — redirected to the mirror by PON-212 and timestamped before
 * consent.
 *
 * The design call was to keep that narration rather than suppress it: the
 * agent's reading of the repository is useful to a reviewer, and hiding it to
 * avoid a misreading trades information for comfort. So the work is to make
 * the boundary legible instead — an unmissable marker at the consent line, and
 * a plan that reads as a proposal at the point where it renders.
 */

/**
 * The marker posted into the mirror thread at the moment of approval.
 *
 * Deliberately heavy. A reviewer scrolling a 28-activity thread has to hit
 * this without looking for it, and the two halves have to be nameable without
 * reading further: everything above is reading, everything below is work.
 */
export const CONSENT_MARKER = [
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"## ✋ THE CLIENT APPROVED THE SCOPE HERE",
	"",
	"**Above this line** — the agent reading the repository to write the scope it asked them to approve. Its plan is part of that reading: a proposal, not work done.",
	"",
	"**Below this line** — the implementation they consented to.",
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
].join("\n");

/** The same fact, for the mirror description — where a reviewer looks first. */
export const CONSENT_DESCRIPTION_NOTE =
	"> Narration in the thread timestamped before that is the agent reading the repository to write the scope, and its plan is a proposal. The consent line is marked in the thread.";

/**
 * A plan, as the runners render one: lines led by a status emoji.
 *
 * Both shapes exist — TodoWrite emits `⏳ item` per line, the Task tools emit
 * `⏳ **subject**` — and the false-positive cost is asymmetric. Mislabeling a
 * plan as a proposal when it is one is free; labeling ordinary narration as a
 * proposal is noise that teaches a reviewer to ignore the label. So this
 * requires EVERY non-empty line to be a checklist item, not merely one.
 */
// Alternation, not a character class: 🗑️ is two code points (the trash can
// plus a variation selector), and a class would silently match either half.
const PLAN_LINE = /^(?:⏳|🔄|✅|🗑️)/u;

export function looksLikePlan(body: string): boolean {
	const lines = body
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return false;
	return lines.every((line) => PLAN_LINE.test(line));
}

/**
 * Label a plan that renders before consent.
 *
 * "Verify and open the pull request" in a checklist is what triggered this:
 * read cold, with no marker, a to-do list about opening a PR is
 * indistinguishable from a report that one was opened.
 */
export function labelPlanAsProposal(body: string): string {
	if (!looksLikePlan(body)) return body;
	return `**Proposed plan — not yet approved, nothing here has been done:**\n\n${body}`;
}
