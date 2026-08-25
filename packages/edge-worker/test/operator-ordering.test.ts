import { describe, expect, it } from "vitest";
import {
	computeRoundRobinOrder,
	type OperatorItem,
	stateRankOf,
} from "../src/operator-ordering.js";

function item(
	issueId: string,
	tenant: string,
	seq: number,
	stateRank = 3,
): OperatorItem {
	return { issueId, tenantWorkspaceId: tenant, seq, stateRank };
}

describe("operator ordering (PON-173)", () => {
	describe("stateRankOf", () => {
		it("puts in-verification first — the operator is the blocker there", () => {
			const ranks = [
				"in-verification",
				"needs-info",
				"awaiting-scope-confirm",
				"active",
				"queued",
				"delivered",
			].map(stateRankOf);
			expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
		});

		it("queued keeps the client's own position ordering", () => {
			expect(stateRankOf("queued (#1)")).toBeLessThan(
				stateRankOf("queued (#2)"),
			);
			expect(stateRankOf("queued (#2)")).toBeLessThan(stateRankOf("delivered"));
		});
	});

	describe("computeRoundRobinOrder", () => {
		it("interleaves tenants A1 B1 C1 A2 B2 A3", () => {
			const order = computeRoundRobinOrder([
				item("A1", "A", 0),
				item("A2", "A", 1),
				item("A3", "A", 2),
				item("B1", "B", 3),
				item("B2", "B", 4),
				item("C1", "C", 5),
			]);
			expect(order).toEqual(["A1", "B1", "C1", "A2", "B2", "A3"]);
		});

		it("a single tenant keeps its own order (identity)", () => {
			const order = computeRoundRobinOrder([
				item("A2", "A", 1),
				item("A1", "A", 0),
				item("A3", "A", 2),
			]);
			expect(order).toEqual(["A1", "A2", "A3"]);
		});

		it("within a tenant, urgency outranks age", () => {
			const order = computeRoundRobinOrder([
				item("A-old-active", "A", 0, stateRankOf("active")),
				item("A-new-verify", "A", 1, stateRankOf("in-verification")),
			]);
			expect(order).toEqual(["A-new-verify", "A-old-active"]);
		});

		it("a tenant joining shifts nothing within other tenants' sequences", () => {
			const base = [item("A1", "A", 0), item("A2", "A", 1)];
			const before = computeRoundRobinOrder(base);
			const after = computeRoundRobinOrder([...base, item("B1", "B", 2)]);
			// A's relative order is unchanged; B1 slots into the first cycle.
			expect(after.filter((id) => id.startsWith("A"))).toEqual(before);
			expect(after).toEqual(["A1", "B1", "A2"]);
		});

		it("a tenant leaving collapses cleanly", () => {
			const order = computeRoundRobinOrder([
				item("A1", "A", 0),
				item("A2", "A", 1),
				item("C1", "C", 5),
			]);
			expect(order).toEqual(["A1", "C1", "A2"]);
		});

		it("is deterministic and covers every item exactly once (property)", () => {
			// Pseudo-random but seeded by construction: 4 tenants, 40 items.
			const tenants = ["A", "B", "C", "D"];
			const items: OperatorItem[] = [];
			for (let i = 0; i < 40; i++) {
				items.push(
					item(
						`${tenants[i % 4]}-${i}`,
						tenants[i % 4] as string,
						(i * 7) % 40,
						(i * 3) % 5,
					),
				);
			}
			const a = computeRoundRobinOrder(items);
			const b = computeRoundRobinOrder([...items].reverse());
			expect(a).toEqual(b); // input order never matters
			expect(new Set(a).size).toBe(40);
			// Fairness: in any prefix, no tenant leads another by more than
			// one item (until a tenant runs out).
			const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
			for (const id of a.slice(0, 20)) {
				counts[id[0] as string] = (counts[id[0] as string] ?? 0) + 1;
			}
			const values = Object.values(counts);
			expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
		});

		it("empty input yields empty output", () => {
			expect(computeRoundRobinOrder([])).toEqual([]);
		});
	});
});
