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
	const byTenant = new Map<string, OperatorItem[]>();
	for (const item of items) {
		const list = byTenant.get(item.tenantWorkspaceId) ?? [];
		list.push(item);
		byTenant.set(item.tenantWorkspaceId, list);
	}
	for (const list of byTenant.values()) {
		list.sort((a, b) => a.stateRank - b.stateRank || a.seq - b.seq);
	}
	const tenants = [...byTenant.entries()].sort(
		(a, b) =>
			Math.min(...a[1].map((item) => item.seq)) -
			Math.min(...b[1].map((item) => item.seq)),
	);
	const out: string[] = [];
	for (let cycle = 0; out.length < items.length; cycle++) {
		for (const [, list] of tenants) {
			const item = list[cycle];
			if (item) out.push(item.issueId);
		}
	}
	return out;
}
