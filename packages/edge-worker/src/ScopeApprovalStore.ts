/**
 * Per-issue scope-approval state (PON-150).
 *
 * The scope-confirm gate is intrinsic — a prompt step, not an interceptor.
 * This store is the mechanical bookkeeping around it: which issues have an
 * outstanding scope reading, and when the client approved. `approvedAt` is
 * the SLA clock start, so it is written exactly once and never moved.
 *
 * Keyed by issue id, not session id: a session can die and be replaced; the
 * approval belongs to the issue.
 */

import type { SerializedScopeApprovalRecord } from "cyrus-core";

export type ScopeApprovalRecord = SerializedScopeApprovalRecord;

/** Context recorded alongside a proposal, for the queryable list. */
export interface ScopeProposalContext {
	workspaceId?: string;
	issueIdentifier?: string;
}

export class ScopeApprovalStore {
	private records = new Map<string, ScopeApprovalRecord>();

	/** True when the issue's scope has been explicitly approved. */
	isApproved(issueId: string): boolean {
		return this.records.get(issueId)?.state === "approved";
	}

	get(issueId: string): ScopeApprovalRecord | undefined {
		return this.records.get(issueId);
	}

	/**
	 * A confirmation elicitation was posted for this issue. First call
	 * creates the record (this stamps `proposedAt`); later calls — the
	 * re-ask after a revision — flip the state back to awaiting but keep
	 * `proposedAt`, which marks the FIRST proposal.
	 *
	 * A no-op on an approved issue: approval is terminal.
	 */
	recordProposed(issueId: string, context?: ScopeProposalContext): void {
		const existing = this.records.get(issueId);
		if (existing) {
			if (existing.state === "approved") return;
			existing.state = "awaiting";
			if (context?.workspaceId) existing.workspaceId = context.workspaceId;
			if (context?.issueIdentifier)
				existing.issueIdentifier = context.issueIdentifier;
			return;
		}
		this.records.set(issueId, {
			state: "awaiting",
			proposedAt: new Date().toISOString(),
			...(context?.workspaceId ? { workspaceId: context.workspaceId } : {}),
			...(context?.issueIdentifier
				? { issueIdentifier: context.issueIdentifier }
				: {}),
		});
	}

	/**
	 * The client approved. Returns true when this call recorded the approval,
	 * false when the issue was already approved — the caller uses that to log
	 * and persist only on the real transition, so a queue-replayed answer
	 * webhook cannot move the SLA clock.
	 *
	 * Tolerates a missing record (a crash between posting the elicitation and
	 * persisting the proposal): the approval still lands.
	 */
	recordApproved(issueId: string, context?: ScopeProposalContext): boolean {
		const existing = this.records.get(issueId);
		if (existing?.state === "approved") return false;
		const now = new Date().toISOString();
		this.records.set(issueId, {
			state: "approved",
			proposedAt: existing?.proposedAt ?? now,
			approvedAt: now,
			...(existing?.revisions !== undefined
				? { revisions: existing.revisions }
				: {}),
			// The operator note survives approval — it is the record of what
			// the operator approved against (PON-169).
			...(existing?.operatorNote !== undefined
				? {
						operatorNote: existing.operatorNote,
						operatorNoteAt: existing.operatorNoteAt,
					}
				: {}),
			// So does the client-facing scope text (PON-170): approval is the
			// moment it becomes "what the client approved".
			...(existing?.clientScope !== undefined
				? { clientScope: existing.clientScope }
				: {}),
			...(existing?.clientScopePosted !== undefined
				? { clientScopePosted: existing.clientScopePosted }
				: {}),
			workspaceId: context?.workspaceId ?? existing?.workspaceId,
			issueIdentifier: context?.issueIdentifier ?? existing?.issueIdentifier,
		});
		return true;
	}

	/**
	 * The client asked for a revised reading. No-op on an approved issue —
	 * and on an issue already in `revised`: a real second revision can only
	 * follow a re-ask (which flips the state back to awaiting), so a revise
	 * landing on `revised` is a replayed or duplicate webhook, and counting
	 * it would inflate `revisions`. Returns true when a revision was recorded.
	 */
	recordRevised(issueId: string): boolean {
		const existing = this.records.get(issueId);
		if (existing?.state === "approved") return false;
		if (existing?.state === "revised") return false;
		if (!existing) {
			// Same crash-tolerance as recordApproved: the revision still lands.
			this.records.set(issueId, {
				state: "revised",
				proposedAt: new Date().toISOString(),
				revisions: 1,
			});
			return true;
		}
		existing.state = "revised";
		existing.revisions = (existing.revisions ?? 0) + 1;
		return true;
	}

	/**
	 * Record the session's internal reading for the operator (PON-169).
	 * Latest note replaces the previous one — a revised scope re-records.
	 *
	 * The note may arrive BEFORE the confirmation elicitation is posted
	 * (the gate instructs note-first, so the mirror carries the reading by
	 * the time the client sees the ask): a missing record is created as
	 * awaiting. `recordProposed` keeps the earliest `proposedAt`, so this
	 * only ever moves the proposal timestamp seconds early, never late.
	 * Allowed after approval too — a mid-work update stays visible.
	 */
	recordOperatorNote(
		issueId: string,
		note: string,
		clientScope?: string,
	): void {
		const existing = this.records.get(issueId);
		const now = new Date().toISOString();
		if (existing) {
			existing.operatorNote = note;
			existing.operatorNoteAt = now;
			if (clientScope !== undefined) existing.clientScope = clientScope;
			return;
		}
		this.records.set(issueId, {
			state: "awaiting",
			proposedAt: now,
			operatorNote: note,
			operatorNoteAt: now,
			...(clientScope !== undefined ? { clientScope } : {}),
		});
	}

	/**
	 * The client scope reached the client thread (PON-188). Records the exact
	 * text posted, which is what makes the post idempotent per proposal: a
	 * revision carries different text and posts again, a replay carries the
	 * same text and does not.
	 *
	 * Only ever called after a successful post, so a record showing
	 * `clientScopePosted === clientScope` means the client can read it.
	 */
	markClientScopePosted(issueId: string, text: string): void {
		const existing = this.records.get(issueId);
		if (!existing) return;
		existing.clientScopePosted = text;
	}

	/** The issue reached a terminal state — its gate record is done. */
	remove(issueId: string): boolean {
		return this.records.delete(issueId);
	}

	/**
	 * Issues whose gate is open — awaiting or revised. This is the "sits
	 * forever and nobody notices" guard: the list exists independently of the
	 * operator cockpit.
	 */
	listPending(): Array<{ issueId: string } & ScopeApprovalRecord> {
		const out: Array<{ issueId: string } & ScopeApprovalRecord> = [];
		for (const [issueId, record] of this.records) {
			if (record.state !== "approved") out.push({ issueId, ...record });
		}
		return out;
	}

	serialize(): Record<string, ScopeApprovalRecord> {
		return Object.fromEntries(
			[...this.records.entries()].map(([id, r]) => [id, { ...r }]),
		);
	}

	restore(records: Record<string, ScopeApprovalRecord> | undefined): void {
		this.records.clear();
		if (!records) return;
		for (const [issueId, record] of Object.entries(records)) {
			this.records.set(issueId, { ...record });
		}
	}

	get size(): number {
		return this.records.size;
	}
}
