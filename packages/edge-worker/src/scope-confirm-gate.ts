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

/**
 * The client-facing scope goes INSIDE the confirmation elicitation (PON-196).
 *
 * Three surfaces have now been tried. As narration it was suppressed and the
 * client was asked to approve nothing (PON-188). As a comment it was readable
 * but left a comment trail on the client's thread (PON-192). An elicitation is
 * never collapsed, always visible in the panel, reads standalone in an email,
 * and leaves nothing behind — so the scope travels in the ask itself.
 *
 * The client half is Outcome and You-will-receive. Interpretations are
 * operator material: they go to the mirror through the operator note, not to
 * the client. The gate block says so, and this strips them if a session sends
 * them anyway — the recorded `clientScope` keeps the full text for the brief.
 */
export function buildScopeAskBody(
	clientScope: string,
	issue?: { identifier?: string; title?: string },
): string {
	const clientHalf = stripOperatorSections(clientScope).trim();
	const subject = issue?.identifier
		? issue.title
			? `${issue.identifier} — ${issue.title}`
			: issue.identifier
		: "this issue";
	return `This is the scope for ${subject}.\n\n${clientHalf}\n\nProceed?`;
}

/**
 * Cut an "Interpreted"/"Assumptions" section and everything after it. The gate
 * mandates the section order, so the section header is the honest boundary —
 * and cutting to the end rather than to the next header means a trailing
 * operator aside cannot survive by omitting one.
 */
function stripOperatorSections(text: string): string {
	const match = text.match(
		/^\s*(?:\*\*|##+\s*)?(interpreted|interpretations?|assumptions?)\b/im,
	);
	return match?.index === undefined ? text : text.slice(0, match.index);
}

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
2. Record your INTERNAL reading with the record_operator_note tool: implementation approach, the files and areas you expect to touch, risks, and — importantly — every interpretation and assumption you made. Full technical detail. This goes to the operator only and is never shown on the issue, so the interpretations belong HERE, not in the client text. Pass the client-facing scope as the tool's client_scope input. If the issue is genuinely ambiguous about what the client wants, resolve that first with the AskUserQuestion tool, then record the note.
3. Write client_scope as exactly two sections and nothing else: **Outcome** — what will exist and work when this is done, in the client's own terms; **You will receive** — where they will see it working and what they will get to merge. Keep it tight: this is the whole thing the client reads, and they read it inside the question. No implementation detail anywhere in it — no file names, no code areas, no approach, no technical steps — and no interpretations or assumptions section; those go in the operator note. Never post this text yourself, in a comment or anywhere else.
4. Ask for confirmation with the AskUserQuestion tool — exactly one question, with these options in this order: "${SCOPE_APPROVE_LABEL}", "${SCOPE_REVISE_LABEL}", "${SCOPE_CANCEL_LABEL}". Use those labels exactly, and never use the label "${SCOPE_APPROVE_LABEL}" on any other question.

   Your question text is REPLACED by the scope itself — the client sees the scope you recorded, followed by "Proceed?", followed by your options — so put nothing load-bearing in the question field and never refer to a scope posted "above" or "in a comment": there is no comment, and the scope is inside the ask.

   The option descriptions are yours and they must stand on their own. Assume the client reads them in an email with no surrounding text: each one says what happens if it is chosen, in one sentence.
5. Act on the answer:
   - "${SCOPE_APPROVE_LABEL}": the work is accepted into the queue. Post exactly one short confirmation in the client's terms — the work is accepted and they will hear back when there is something to review — then end your turn. Do not start implementing and do not ask again: implementation is scheduled separately and never begins in this conversation.
   - "${SCOPE_REVISE_LABEL}": incorporate the reply, re-record the operator note AND the revised client_scope, then ask again — the new ask carries the revised scope inline, which is how the client sees the revision.
   - "${SCOPE_CANCEL_LABEL}": post one short comment acknowledging the cancellation and stop.
   - Anything else is not an approval. Treat it as context, update the note, post a revised deliverable-framed scope, and ask again. Never start implementing without an explicit "${SCOPE_APPROVE_LABEL}".

Make no changes to the repository in this conversation, before or after approval: no file edits, no commits, no branches beyond the pre-created worktree, no PRs. Reading code, searching, and posting comments are all fine. Implementation happens in a separate working session once the work is picked up from the queue — this conversation only scopes the work and confirms it is accepted.

If this session is a side conversation on the issue (for example, it started from a mention) or is resuming after the confirmation question was already posted: answer questions freely, but the rule above still holds — nothing is implemented on this issue until its scope is approved, and any request to implement routes through that confirmation.

This gate applies once per issue. If the issue's scope was already approved in an earlier session, you will not see this block — do not re-ask.
</scope_confirm_gate>`;
}

/**
 * System prompt block for sessions on an issue whose scope is approved but
 * whose implementation is parked (PON-224): the v3 cockpit starts
 * implementation from the mirror, so the client-thread session must never
 * pick the work up itself — not on the approval turn, and not when the
 * client asks a follow-up while the work waits in the queue.
 *
 * Injected wherever the gate block would be (new sessions and resumes)
 * whenever the issue's approval record carries `implementationDeferred`.
 * Same intrinsic-over-enforced split as the gate itself: this block IS the
 * mechanism; the machinery only does bookkeeping around it.
 */
export function buildImplementationParkedBlock(): string {
	return `

<implementation_parked>
The scope for this issue is approved and the work is accepted into the queue. Implementation has not started and never starts in this conversation — it runs as a separate working session once our review team picks it up, and this thread receives the finished result when it is ready.

In this conversation: answer the client in their own terms and keep replies short. Make no changes to the repository — no file edits, no commits, no branches, no PRs. Reading code to answer a question is fine. If the client asks when the work will be done, say it is queued and they will hear from us when there is something to review; never promise a date.

If the message you are answering is the scope approval itself, reply with exactly one short confirmation that the work is accepted into their queue, then end your turn.
</implementation_parked>`;
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

/** The verdict, plus whatever the client typed alongside their choice. */
export interface ScopeConfirmReply {
	verdict: ScopeConfirmAnswer;
	note?: string;
}

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
): ScopeConfirmReply {
	const { head, note } = splitLabelAndNote(response);
	for (const opt of question.options ?? []) {
		const label = normalize(opt.label);
		if (label !== head) continue;
		return { verdict: canonicalVerdict(label), note };
	}
	return { verdict: "other" };
}

/**
 * Restart fallback: a pending elicitation does not survive a restart in
 * memory, so a canonical answer arriving with no pending question is
 * interpreted against the canonical labels alone. Exact labels only — free
 * text never approves.
 */
export function interpretCanonicalScopeAnswer(
	response: string,
): ScopeConfirmReply {
	const { head, note } = splitLabelAndNote(response);
	return { verdict: canonicalVerdict(head), note };
}

/**
 * Linear sends the option label and the person's own words as one body:
 * the label alone on the first line, then what they typed. Read as a whole
 * string it equals no label, so it fell through to "other" — a revision that
 * was never counted, and, on the approve option, an approval that never
 * happened: no `approvedAt`, no mirror, no queue, and a client waiting on
 * silence after doing exactly what they were asked (found live, 2026-08-31).
 *
 * The first line is the answer and the rest is theirs. Kept deliberately
 * narrow: the label must stand ALONE on line one, so free text never
 * approves however it begins, and a reply to a DIFFERENT elicitation still
 * cannot match — the labels are compared against the options that were
 * actually posted (PON-142's rule), and the gate itself is only recognised
 * by an exact "Approve scope" option in the first place.
 */
export function splitLabelAndNote(response: string): {
	head: string;
	note?: string;
} {
	const newline = response.indexOf("\n");
	if (newline === -1) return { head: normalize(response) };
	const note = response.slice(newline + 1).trim();
	return {
		head: normalize(response.slice(0, newline)),
		...(note ? { note } : {}),
	};
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
