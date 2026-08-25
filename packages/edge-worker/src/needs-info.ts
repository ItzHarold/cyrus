/**
 * Needs-info mid-work (PON-172 / client-flow R6).
 *
 * When a session is blocked on something only the client can supply, it asks
 * on the client's issue — deliverable-framed, one ask with everything needed
 * — and the lane releases while the wait lasts. Like the scope gate, the
 * behaviour itself is intrinsic (a prompt rule); the machinery only does
 * bookkeeping: a distinct lane-release reason, a cockpit state, and a
 * persisted record so the wait is never invisible (PON-150's lesson).
 *
 * Recognition is by the EXACT canonical header, same rationale as the scope
 * gate's exact-label rule: an unrelated elicitation must never be mistaken
 * for a needs-info ask, because that changes what the cockpit reports.
 */

import type { AskUserQuestion } from "cyrus-core";

/** Canonical question header the rule block instructs the session to use. */
export const NEEDS_INFO_HEADER = "Missing info";

/** Does this AskUserQuestion look like a needs-info ask? Exact header only. */
export function isNeedsInfoQuestion(question: AskUserQuestion): boolean {
	return normalize(question.header ?? "") === normalize(NEEDS_INFO_HEADER);
}

/**
 * The intrinsic half: an always-on system-prompt rule. Appended alongside
 * the client-surface rules on every new session AND resume.
 */
export function buildNeedsInfoRuleBlock(): string {
	return `

<needs_info_rules>
If, mid-implementation, you are blocked on something only the client can supply — a credential name, a copy decision, an acceptance detail — ask on the issue with the AskUserQuestion tool, and set that question's header to exactly "${NEEDS_INFO_HEADER}". Never use that header on any other question. Rules:

- Ask once, with everything you need in one question — not a drip of follow-ups.
- Frame every item in terms of the deliverable ("To finish the export you'll receive, I need: …"), never in terms of your implementation.
- Only client-side inputs qualify. Anything you can resolve by reading the repository, and every internal or technical decision, is yours — never ask the client those.
- Before the issue's scope is approved, missing information is scope discussion and goes through the scope-confirmation flow instead — this rule applies mid-implementation only.

While you wait, the work pauses safely; when the answer arrives you continue exactly where you stopped, with the answer as context.
</needs_info_rules>`;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}
