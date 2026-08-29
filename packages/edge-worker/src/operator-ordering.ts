/**
 * Fair cross-tenant operator ordering (PON-173 / client-flow R4).
 *
 * Execution is already per-tenant serialized (lanes); this orders the
 * OPERATOR's attention across tenants: companies interleave round-robin,
 * each contributing in its own order — A1, B1, C1, A2, B2 …
 *
 * Pure functions only. The cockpit applies the result as Linear sortOrder
 * on the mirrors (written, never read back — derived-view rules intact).
 */

export interface OperatorItem {
	issueId: string;
	tenantWorkspaceId: string;
	/** Lower = more urgent within its tenant (see stateRankOf) */
	stateRank: number;
	/** Stable within-tenant tiebreak — insertion sequence */
	seq: number;
	/**
	 * The CLIENT this work is for (PON-207). A client may hold several
	 * workspaces and several teams; all of it is one queue, because the
	 * client experiences one queue. Absent falls back to the workspace, which
	 * is the pre-PON-207 behaviour.
	 */
	clientId?: string;
	/**
	 * Lanes the client bought. A two-lane client takes two turns per cycle —
	 * they are paying for twice the attention, so they get it. Absent = 1.
	 */
	lanes?: number;
}

/**
 * Urgency of a mirror state for the operator. In-verification is
 * first-class — it is the one state where the operator IS the blocker.
 */
export function stateRankOf(state: string): number {
	const base = state.replace(/ \(#\d+\)$/, "");
	switch (base) {
		case "in-verification":
			return 0;
		case "needs-info":
			return 1;
		case "awaiting-scope-confirm":
			return 2;
		case "active":
			return 3;
		case "queued": {
			// Queued items keep the client's own ordering via the position.
			const position = / \(#(\d+)\)$/.exec(state)?.[1];
			return 4 + (position ? Number(position) / 1000 : 0);
		}
		case "delivered":
			return 6;
		default:
			return 7;
	}
}

/**
 * Round-robin interleave: one item per tenant per cycle, each tenant's
 * items in (stateRank, seq) order. Tenants take turns in a fixed order —
 * oldest head item first — so the result is deterministic, and a tenant
 * joining or leaving shifts nothing within any other tenant's sequence.
 * One tenant = its own order unchanged.
 */
export function computeRoundRobinOrder(items: OperatorItem[]): string[] {
	// Group by CLIENT where one is known, else by workspace. A client with
	// two teams is one queue: they bought lanes, not teams.
	const byClient = new Map<string, OperatorItem[]>();
	const lanesOf = new Map<string, number>();
	for (const item of items) {
		const key = item.clientId ?? item.tenantWorkspaceId;
		const list = byClient.get(key) ?? [];
		list.push(item);
		byClient.set(key, list);
		// Lanes are a property of the client; take the largest seen so a
		// stale item cannot shrink a client's share.
		lanesOf.set(key, Math.max(lanesOf.get(key) ?? 1, item.lanes ?? 1));
	}
	for (const list of byClient.values()) {
		list.sort((a, b) => a.stateRank - b.stateRank || a.seq - b.seq);
	}
	const clients = [...byClient.entries()].sort(
		(a, b) =>
			Math.min(...a[1].map((item) => item.seq)) -
			Math.min(...b[1].map((item) => item.seq)),
	);
	// Each client takes `lanes` turns per cycle. Cursors rather than an
	// index, because turns per client now differ.
	const cursor = new Map<string, number>();
	const out: string[] = [];
	let progressed = true;
	while (out.length < items.length && progressed) {
		progressed = false;
		for (const [key, list] of clients) {
			const turns = lanesOf.get(key) ?? 1;
			let at = cursor.get(key) ?? 0;
			for (let taken = 0; taken < turns; taken++) {
				const item = list[at];
				if (!item) break;
				out.push(item.issueId);
				at += 1;
				progressed = true;
			}
			cursor.set(key, at);
		}
	}
	return out;
}
