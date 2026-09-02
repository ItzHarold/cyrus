import { describe, expect, it } from "vitest";
import {
	computeRoundRobinOrder,
	type OperatorItem,
} from "../src/operator-ordering.js";

/**
 * TENANT ISOLATION invariant (2026-09-02).
 *
 * The tenant (workspace) is the isolation boundary. The cross-tenant
 * round-robin order exists only as the operator's read-only "suggested next"
 * attention view — a suggestion, never a gate, and never a source of
 * cross-tenant text. These assertions pin that: the suggestion is a pure
 * function, and a tenant's own order is independent of every other tenant.
 */

// Deterministic pseudo-random boards — Date.now()/Math.random() are avoided so
// the same seeds reproduce, and workflow-safe.
function board(seed: number): OperatorItem[] {
	let s = (seed * 2654435761) & 0x7fffffff;
	const rnd = () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s / 0x7fffffff;
	};
	const tenants = ["ws-alpha", "ws-bravo", "ws-charlie", "ws-delta"];
	const n = 3 + Math.floor(rnd() * 14);
	const items: OperatorItem[] = [];
	for (let i = 0; i < n; i++) {
		const t = tenants[Math.floor(rnd() * tenants.length)] as string;
		items.push({
			issueId: `${t}#${i}`,
			tenantWorkspaceId: t,
			stateRank: 1 + Math.floor(rnd() * 5),
			seq: i,
		});
	}
	return items;
}

const tenantOf = (issueId: string): string => issueId.split("#")[0] as string;

describe("TENANT ISOLATION — the cross-tenant order is a read-only suggestion", () => {
	it("(b) computeRoundRobinOrder is a pure function: deterministic and non-mutating", () => {
		for (let seed = 1; seed <= 60; seed++) {
			const items = board(seed);
			const snapshot = JSON.stringify(items);
			const first = computeRoundRobinOrder(items);
			const second = computeRoundRobinOrder(items);
			// Same input → same output.
			expect(second).toEqual(first);
			// The input is never mutated — a suggestion changes nothing.
			expect(JSON.stringify(items)).toBe(snapshot);
		}
	});

	it("(c) removing every other tenant leaves a tenant's own order identical", () => {
		for (let seed = 1; seed <= 60; seed++) {
			const items = board(seed);
			const full = computeRoundRobinOrder(items);
			const tenants = [...new Set(items.map((i) => i.tenantWorkspaceId))];
			for (const t of tenants) {
				const ownWithinFull = full.filter((id) => tenantOf(id) === t);
				const ownAlone = computeRoundRobinOrder(
					items.filter((i) => i.tenantWorkspaceId === t),
				);
				// A tenant's items keep the exact same relative order whether or
				// not any other tenant is on the board — no other tenant's state
				// shifts this tenant's ranking.
				expect(ownWithinFull).toEqual(ownAlone);
			}
		}
	});

	it("(a) the order references only its own items — every issueId in the result is a real input item", () => {
		// The ordering itself carries no foreign construct: it only permutes the
		// items it was given (it invents no cross-tenant token). Combined with the
		// per-tenant rank/annotation in CockpitMirror, no tenant's surface can
		// name another tenant's work.
		for (let seed = 1; seed <= 60; seed++) {
			const items = board(seed);
			const ids = new Set(items.map((i) => i.issueId));
			const order = computeRoundRobinOrder(items);
			expect(order).toHaveLength(items.length);
			for (const id of order) expect(ids.has(id)).toBe(true);
		}
	});
});
