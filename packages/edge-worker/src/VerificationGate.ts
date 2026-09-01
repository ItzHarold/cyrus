/**
 * Verify-before-client-sees (PON-152): when a session completes in a
 * verification-gated workspace, the client-facing completion summary is
 * suppressed and held here until the operator approves — the client is not
 * TOLD the work exists until a human looked at it.
 *
 * The one rule that never bends (decided 2026-08-21): NEVER auto-release.
 * Nothing in this module marks a PR ready or posts a client summary on a
 * timer. The escalation ladder makes a stuck record loud — a second
 * notification, then an honest delay note — but delivery is always a human
 * action.
 */

import type { SerializedVerificationRecord } from "cyrus-core";

export type VerificationRecord = SerializedVerificationRecord;

const GITHUB_PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Pull the PR links out of a completion summary. */
export function extractPullRequestUrls(text: string): string[] {
	return [...new Set(text.match(GITHUB_PR_URL) ?? [])];
}

export class VerificationGate {
	private records = new Map<string, VerificationRecord>();

	/**
	 * A gated session produced a completion summary. Overwrites on a
	 * Stop-hook continuation's later result — the LAST summary is the one
	 * that ships. Keeps the first completedAt: the ladder clock starts when
	 * work first finished, not when the last continuation ended.
	 */
	recordPending(
		issueId: string,
		entry: {
			workspaceId: string;
			issueIdentifier?: string;
			sessionId: string;
			summary: string;
			isError: boolean;
		},
	): void {
		const existing = this.records.get(issueId);
		this.records.set(issueId, {
			state: "in-verification",
			completedAt:
				existing?.state === "in-verification"
					? existing.completedAt
					: new Date().toISOString(),
			workspaceId: entry.workspaceId,
			issueIdentifier: entry.issueIdentifier ?? existing?.issueIdentifier,
			sessionId: entry.sessionId,
			summary: entry.summary,
			isError: entry.isError,
			// PON-238: the pull request is a fact about the WORK, not about
			// the run that last described it. These are scraped out of the
			// summary's prose, so a rewrite that legitimately writes no URLs
			// (a regeneration only restates what was already built) produced a
			// record with no PR — nothing to mark ready, no merge path for the
			// client, and no head for the staleness check to resolve. Carry
			// the last known set when this summary names none.
			prUrls:
				extractPullRequestUrls(entry.summary).length > 0
					? extractPullRequestUrls(entry.summary)
					: (existing?.prUrls ?? this.carriedPrUrls.get(issueId) ?? []),
			// A rework run's hold keeps the merge watch: the pull request the
			// client was told about is still theirs to merge, at any moment.
			...(existing?.mergeWatch ? { mergeWatch: existing.mergeWatch } : {}),
			...(existing?.escalatedAt ? { escalatedAt: existing.escalatedAt } : {}),
			...(existing?.delayNotedAt
				? { delayNotedAt: existing.delayNotedAt }
				: {}),
		});
	}

	get(issueId: string): VerificationRecord | undefined {
		return this.records.get(issueId);
	}

	/**
	 * Remember the PR head the held summary describes (PON-210).
	 *
	 * Write-once per summary, deliberately. The mirror is recomposed on a
	 * refresh clock and on boot as well as on a real transition, so a setter
	 * that overwrote would quietly re-point the record at whatever the head
	 * is NOW — which is the staleness we are trying to detect, erased by the
	 * act of looking for it. `recordPending` rebuilds the record and drops
	 * this field, so a genuinely new summary re-captures.
	 */
	recordCapturedHead(issueId: string, headSha: string | undefined): void {
		const record = this.records.get(issueId);
		if (!record || record.state !== "in-verification") return;
		// First ATTEMPT wins, not first success. A lookup that failed at
		// capture time must leave staleness unknown rather than leaving the
		// slot open for a later refresh tick to fill with a head that already
		// carries the reviewer's commits.
		if (record.capturedHeadResolved) return;
		record.capturedHeadResolved = true;
		if (headSha) record.capturedHeadSha = headSha;
	}

	/**
	 * The reviewer has been told this head is stale (PON-210).
	 *
	 * Keyed by the head they were warned about, not a boolean: if the code
	 * moves again after the warning, the next approve warns again rather than
	 * silently shipping a summary that is stale in a NEW way.
	 */
	noteStaleWarned(issueId: string, headSha: string): void {
		const record = this.records.get(issueId);
		if (!record) return;
		record.staleNotifiedForSha = headSha;
	}

	/** True while a completion sits unapproved. */
	/** Issues whose work is held awaiting a reviewer (PON-212 refresh clock). */
	pendingIssueIds(): string[] {
		return [...this.records.entries()]
			.filter(([, r]) => r.state === "in-verification")
			.map(([issueId]) => issueId);
	}

	isPending(issueId: string): boolean {
		return this.records.get(issueId)?.state === "in-verification";
	}

	/**
	 * The operator approved and the summary was delivered. The record stays
	 * (state `delivered`) until the issue reaches a terminal state, so a
	 * replayed approval cannot deliver twice. Returns false when there was
	 * nothing pending — the caller treats that as "nothing to do", never as
	 * an error to retry.
	 */
	markDelivered(issueId: string): boolean {
		const record = this.records.get(issueId);
		if (!record || record.state !== "in-verification") return false;
		record.state = "delivered";
		record.deliveredAt = new Date().toISOString();
		return true;
	}

	/**
	 * The client confirmed a change to delivered work (v3.1). The record
	 * stays — the pull request, the merge watch, the history — but it is no
	 * longer "delivered": the next completion of the rework run is held for
	 * verification exactly like a first pass, and `approve:` refuses until
	 * it is. Before this the record stayed delivered, the rework run's
	 * completion hit the delivered early-return and was never held, and
	 * `approve:` answered "Already delivered".
	 */
	reopenForRework(issueId: string): boolean {
		const record = this.records.get(issueId);
		if (!record || record.state !== "delivered") return false;
		record.state = "rework";
		record.reworkRequestedAt = new Date().toISOString();
		return true;
	}

	listRework(): Array<{ issueId: string } & VerificationRecord> {
		const out: Array<{ issueId: string } & VerificationRecord> = [];
		for (const [issueId, record] of this.records) {
			if (record.state === "rework") out.push({ issueId, ...record });
		}
		return out;
	}

	/**
	 * Name the pull request whose merge ends this cycle (PON-233).
	 *
	 * Set once, at delivery, from the own-repo selection rather than from
	 * the summary's free text. Write-once for the same reason the captured
	 * head is: a later re-derivation could point the watch at a different
	 * PR than the one the client was handed.
	 */
	setMergeWatch(
		issueId: string,
		pr: { owner: string; repo: string; number: number },
	): void {
		const record = this.records.get(issueId);
		if (!record || record.mergeWatch) return;
		record.mergeWatch = pr;
	}

	/**
	 * The client merged. Write-once — the poller runs every few minutes and
	 * must not re-close a cycle it already closed.
	 */
	markMerged(issueId: string, mergeCommitSha?: string): boolean {
		const record = this.records.get(issueId);
		if (!record || record.mergedAt) return false;
		record.mergedAt = new Date().toISOString();
		if (mergeCommitSha) record.mergeCommitSha = mergeCommitSha;
		return true;
	}

	/**
	 * Delivered work whose pull request is still open (PON-233).
	 *
	 * The client-review phase. Deliberately keyed on `delivered` plus an
	 * unset `mergedAt` rather than on a new record state: four behaviours
	 * key on the literal "delivered" — the delivered-thread request block,
	 * the link-hold release, follow-up posting, and the double-delivery
	 * guard — and none of them should change because a cycle now ends at a
	 * merge rather than at delivery.
	 */
	awaitingMergeIssueIds(): string[] {
		// Any state: a pull request the client has been told about is theirs
		// to merge at any moment, rework or re-verification included.
		return [...this.records.entries()]
			.filter(([, r]) => r.mergeWatch && !r.mergedAt)
			.map(([issueId]) => issueId);
	}

	/**
	 * The operator rejected — the work goes back to the agent. The record is
	 * removed entirely: the next completion creates a fresh one (fresh
	 * ladder clock included).
	 */
	reject(issueId: string): VerificationRecord | undefined {
		const record = this.records.get(issueId);
		if (!record || record.state !== "in-verification") return undefined;
		// PON-238: the record is about to be deleted, and the rewrite that
		// replaces it may describe the same pull request without naming it.
		// Keep the link so the client still gets a merge path. In-memory
		// only: a restart between the rejection and the rewrite's completion
		// loses it, which degrades to the old behaviour rather than to
		// anything worse.
		if (record.prUrls?.length) {
			this.carriedPrUrls.set(issueId, record.prUrls);
		}
		this.records.delete(issueId);
		return record;
	}

	/** Last known PR links per issue, surviving a rejection (PON-238). */
	private carriedPrUrls = new Map<string, string[]>();

	/** Terminal issue: the record is done regardless of state. */
	remove(issueId: string): boolean {
		return this.records.delete(issueId);
	}

	/** One-shot escalation bookkeeping. Returns true on the first marking. */
	markEscalated(issueId: string): boolean {
		const record = this.records.get(issueId);
		if (!record || record.escalatedAt) return false;
		record.escalatedAt = new Date().toISOString();
		return true;
	}

	markDelayNoted(issueId: string): boolean {
		const record = this.records.get(issueId);
		if (!record || record.delayNotedAt) return false;
		record.delayNotedAt = new Date().toISOString();
		return true;
	}

	listPending(): Array<{ issueId: string } & VerificationRecord> {
		const out: Array<{ issueId: string } & VerificationRecord> = [];
		for (const [issueId, record] of this.records) {
			if (record.state === "in-verification") out.push({ issueId, ...record });
		}
		return out;
	}

	serialize(): Record<string, VerificationRecord> {
		return Object.fromEntries(
			[...this.records.entries()].map(([id, r]) => [id, { ...r }]),
		);
	}

	restore(records: Record<string, VerificationRecord> | undefined): void {
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
