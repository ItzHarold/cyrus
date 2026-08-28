/**
 * The scope-confirm gate's intrinsic half (PON-150).
 *
 * The gate is a prompt step, not an interceptor: the session is instructed —
 * always, as part of its system prompt — to post its reading of the scope and
 * stop for structured confirmation before implementing anything. The
 * machinery around it (ScopeApprovalStore, lane release reasons, answer
 * interpretation) records what happened; it does not enforce.
 *
 * The canonical option labels are load-bearing: EdgeWorker recognises the
 * confirmation elicitation by its exact "Approve scope" option, and resolves
 * the client's answer against the posted options — by the answer, never by
 * fallback (PON-142's lesson). Recognition is exact-label, not prefix: an
 * unrelated elicitation offering "Approve deletion" must never be mistaken
 * for the gate, because its answer would stamp the SLA clock (adversarial
 * review finding, 2026-08-22).
 */

import type { AskUserQuestion } from "cyrus-core";

/** Canonical option labels the gate instructs the session to use. */
export const SCOPE_APPROVE_LABEL = "Approve scope";
export const SCOPE_REVISE_LABEL = "Revise scope";
export const SCOPE_CANCEL_LABEL = "Cancel";

/**
 * System prompt block appended when the gate is pending for the session's
 * issue. Static by design — everything issue-specific the session needs is
 * already in its issue context.
 *
 * Injected on every session start AND resume while the gate is pending: a
 * restart must not remove the gate (adversarial review finding, 2026-08-22).
 * The side-conversation paragraph covers mention threads and resumed
 * sessions whose role the machinery cannot know — the model can see its own
 * transcript and applies the right one.
 */
export function buildScopeConfirmGateBlock(): string {
	return `

<scope_confirm_gate>
Scope confirmation is required on this issue before any implementation. This requirement supersedes any other instruction in this prompt to state your reading and proceed without waiting — on this issue you stop and wait for approval. It also takes precedence over the mid-work needs-info rule: until the scope is approved, missing information is scope discussion and belongs in this flow, not in a needs-info question.

Before you change any file, create any commit, or open any PR:

1. Read the issue and the relevant code.
2. Record your INTERNAL reading with the record_operator_note tool: implementation approach, the files and areas you expect to touch, risks, and every interpretation you made. Full technical detail — this goes to the operator only and is never shown on the issue. Pass the exact client-facing scope text you will post in the next step as the tool's client_scope input, so the operator later sees precisely what the client approved. If the issue is genuinely ambiguous, resolve the ambiguity first with the AskUserQuestion tool, then record the note.
3. The client_scope text you recorded IS the scope comment: it is posted to the issue for you, as a comment, the moment you ask the confirmation question. Do not post it yourself, and do not repeat it in your own messages — write it once, in client_scope, as the whole thing the client will read. Structure it as: **Outcome** — what will exist and work when this is done, in the client's own terms; **You will receive** — where they will see it working and what they will get to merge; **Interpreted** — anything you had to interpret about the outcome itself, stated so they can correct it. No implementation detail anywhere in it: no file names, no code areas, no approach, no technical steps — that is what the operator note is for.
4. Ask for confirmation with the AskUserQuestion tool — exactly one question, asking whether to proceed with the scope, with these options in this order: "${SCOPE_APPROVE_LABEL}", "${SCOPE_REVISE_LABEL}", "${SCOPE_CANCEL_LABEL}". Use those labels exactly, and never use the label "${SCOPE_APPROVE_LABEL}" on any other question.

   The question and its option descriptions must stand on their own. Assume the client sees them with no surrounding text and no memory of this thread: name the deliverable in the question itself rather than saying "the above", and make each option describe what happens if it is chosen. One sentence each is enough. The scope comment sits directly above the question, so you may point at it — but the ask must still make sense to someone who reads only the question.
5. Act on the answer:
   - "${SCOPE_APPROVE_LABEL}": proceed with the work as described. Do not ask again.
   - "${SCOPE_REVISE_LABEL}": incorporate the reply, update the operator note with your revised internal reading, post a revised deliverable-framed scope, and ask again.
   - "${SCOPE_CANCEL_LABEL}": post one short comment acknowledging the cancellation and stop.
   - Anything else is not an approval. Treat it as context, update the note, post a revised deliverable-framed scope, and ask again. Never start implementing without an explicit "${SCOPE_APPROVE_LABEL}".

Until approval, make no changes to the repository: no file edits, no commits, no branches beyond the pre-created worktree, no PRs. Reading code, searching, and posting comments are all fine.

If this session is a side conversation on the issue (for example, it started from a mention) or is resuming after the confirmation question was already posted: answer questions freely, but the rule above still holds — nothing is implemented on this issue until its scope is approved, and any request to implement routes through that confirmation.

This gate applies once per issue. If the issue's scope was already approved in an earlier session, you will not see this block — do not re-ask.
</scope_confirm_gate>`;
}

/**
 * Does this AskUserQuestion look like the gate's confirmation ask?
 * Recognised by the EXACT canonical Approve label — never by prefix.
 */
export function isScopeConfirmQuestion(question: AskUserQuestion): boolean {
	return (question.options ?? []).some(
		(opt) => normalize(opt.label) === normalize(SCOPE_APPROVE_LABEL),
	);
}

export type ScopeConfirmAnswer = "approved" | "revision" | "canceled" | "other";

/**
 * Resolve the client's reply against the posted options (never by fallback).
 * Only a reply matching the exact canonical Approve option approves;
 * the canonical Revise option asks for a revision; the canonical Cancel
 * option closes the gate. Everything else — including free text via Linear's
 * automatic "Other" option — changes nothing mechanically and flows to the
 * session as context.
 */
export function interpretScopeConfirmAnswer(
	question: AskUserQuestion,
	response: string,
): ScopeConfirmAnswer {
	const normalized = normalize(response);
	for (const opt of question.options ?? []) {
		const label = normalize(opt.label);
		if (label !== normalized) continue;
		return canonicalVerdict(label);
	}
	return "other";
}

/**
 * Restart fallback: a pending elicitation does not survive a restart in
 * memory, so a canonical answer arriving with no pending question is
 * interpreted against the canonical labels alone. Exact labels only — free
 * text never approves.
 */
export function interpretCanonicalScopeAnswer(
	response: string,
): ScopeConfirmAnswer {
	return canonicalVerdict(normalize(response));
}

function canonicalVerdict(normalized: string): ScopeConfirmAnswer {
	if (normalized === normalize(SCOPE_APPROVE_LABEL)) return "approved";
	if (normalized === normalize(SCOPE_REVISE_LABEL)) return "revision";
	if (normalized === normalize(SCOPE_CANCEL_LABEL)) return "canceled";
	return "other";
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}
