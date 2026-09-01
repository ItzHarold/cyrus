/**
 * Per-issue needs-info state (PON-172).
 *
 * Same pattern as ScopeApprovalStore: keyed by issue id (a session can die
 * and be replaced; the wait belongs to the issue), persisted so a restart
 * cannot make a client-blocking wait invisible, and listed on an admin
 * surface independent of the cockpit.
 */

import type { SerializedNeedsInfoRecord } from "cyrus-core";

export type NeedsInfoRecord = SerializedNeedsInfoRecord;

export class NeedsInfoStore {
	private records = new Map<string, NeedsInfoRecord>();

	get(issueId: string): NeedsInfoRecord | undefined {
		return this.records.get(issueId);
	}

	/** True when the issue has an unanswered needs-info ask. */
	isAwaiting(issueId: string): boolean {
		return this.records.get(issueId)?.state === "awaiting";
	}

	/**
	 * A needs-info question was posted. A re-ask replaces the question text
	 * and re-opens the record (the client may have answered a first ask and
	 * the session found one more genuinely missing item — a drip is a prompt
	 * violation, but the bookkeeping stays honest either way).
	 */
	recordAsked(
		issueId: string,
		context: {
			question: string;
			sessionId?: string;
			workspaceId?: string;
			issueIdentifier?: string;
		},
	): void {
		const existing = this.records.get(issueId);
		this.records.set(issueId, {
			state: "awaiting",
			question: context.question,
			askedAt: new Date().toISOString(),
			...(existing?.firstAskedAt
				? { firstAskedAt: existing.firstAskedAt }
				: { firstAskedAt: existing?.askedAt ?? new Date().toISOString() }),
			...(context.sessionId ? { sessionId: context.sessionId } : {}),
			...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
			...(context.issueIdentifier
				? { issueIdentifier: context.issueIdentifier }
				: {}),
		});
	}

	/**
	 * The client responded. Returns true on the real transition only, so the
	 * caller logs/persists once — a replayed webhook cannot double-report.
	 */
	recordAnswered(issueId: string): boolean {
		const existing = this.records.get(issueId);
		if (!existing || existing.state !== "awaiting") return false;
		existing.state = "answered";
		existing.answeredAt = new Date().toISOString();
		return true;
	}

	/** The issue reached a terminal state — the record is done. */
	remove(issueId: string): boolean {
		return this.records.delete(issueId);
	}

	/** Unanswered asks — the "waiting and nobody notices" guard. */
	listAwaiting(): Array<{ issueId: string } & NeedsInfoRecord> {
		const out: Array<{ issueId: string } & NeedsInfoRecord> = [];
		for (const [issueId, record] of this.records) {
			if (record.state === "awaiting") out.push({ issueId, ...record });
		}
		return out;
	}

	serialize(): Record<string, NeedsInfoRecord> {
		return Object.fromEntries(
			[...this.records.entries()].map(([id, r]) => [id, { ...r }]),
		);
	}

	restore(records: Record<string, NeedsInfoRecord> | undefined): void {
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
