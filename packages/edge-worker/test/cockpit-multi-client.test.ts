import { describe, expect, it } from "vitest";
import {
	buildMirrorTitle,
	ClientRegistry,
	teamKeyOf,
} from "../src/client-registry.js";
import {
	computeRoundRobinOrder,
	stateRankOf,
} from "../src/operator-ordering.js";

/**
 * PON-207: the cockpit model, proven against a shape we do not have yet.
 *
 * One tenant hides every mistake this model exists to prevent, so the fixture
 * is deliberately the awkward case: two clients that both use the team key
 * `ACM`, a client working two teams across the same workspace, a client with
 * two lanes, and a queued issue whose position has to survive into the order.
 */

const ACME_WS = "ws-acme";
const BOREALIS_WS = "ws-borealis";

const registry = new ClientRegistry([
	{
		id: "acme",
		displayName: "Acme Corp",
		workspaces: [ACME_WS],
		teams: ["ACM", "ACMOPS"],
		lanes: 2,
		reviewerId: "reviewer-harold",
	},
	{
		id: "borealis",
		displayName: "Borealis Ltd",
		// Same team KEY as Acme, different workspace. This is the case the
		// issue prefix cannot distinguish.
		workspaces: [BOREALIS_WS],
		lanes: 1,
		reviewerId: "reviewer-sam",
	},
]);

describe("PON-207 · client identity", () => {
	it("two clients using the same team key stay unambiguous", () => {
		const acme = registry.resolveFor(ACME_WS, "ACM");
		const borealis = registry.resolveFor(BOREALIS_WS, "ACM");

		expect(acme.id).toBe("acme");
		expect(borealis.id).toBe("borealis");

		// The prefix is identical; the client label is what tells them apart.
		expect(
			buildMirrorTitle({
				client: acme,
				issueIdentifier: "ACM-13",
				teamKey: "ACM",
				title: "Dashboard feels slow",
			}),
		).toBe("Acme Corp · ACM · ACM-13 — Dashboard feels slow");
		expect(
			buildMirrorTitle({
				client: borealis,
				issueIdentifier: "ACM-13",
				teamKey: "ACM",
				title: "Dashboard feels slow",
			}),
		).toBe("Borealis Ltd · ACM-13 — Dashboard feels slow");
	});

	it("shows the team only for a client that has more than one", () => {
		// Acme works two teams, so the chip earns its place. Borealis has one,
		// where a team chip would be noise.
		expect(registry.resolveFor(ACME_WS, "ACMOPS").multiTeam).toBe(true);
		expect(registry.resolveFor(BOREALIS_WS, "ACM").multiTeam).toBe(false);
	});

	it("survives a workspace or team rename — identity is config, not Linear", () => {
		// Nothing here reads a Linear workspace or team NAME, so a client
		// renaming either changes nothing about how their work is identified.
		const before = registry.resolveFor(ACME_WS, "ACM").displayName;
		expect(before).toBe("Acme Corp");
		expect(teamKeyOf("ACM-13")).toBe("ACM");
		expect(teamKeyOf("ACMOPS-4")).toBe("ACMOPS");
	});

	it("names work it cannot place rather than dropping it", () => {
		const unknown = registry.resolveFor("ws-nobody-configured", "XYZ");
		expect(unknown.id).toBe("unassigned");
		expect(unknown.displayName).toBe("Unassigned client");
	});

	it("routes each client's mirrors to its own reviewer", () => {
		expect(registry.resolveFor(ACME_WS, "ACM").reviewerId).toBe(
			"reviewer-harold",
		);
		expect(registry.resolveFor(BOREALIS_WS, "ACM").reviewerId).toBe(
			"reviewer-sam",
		);
	});
});

describe("PON-207 · working order", () => {
	/** Build an ordering item the way CockpitMirror does. */
	const item = (
		issueId: string,
		workspaceId: string,
		teamKey: string,
		state: string,
		seq: number,
	) => {
		const client = registry.resolveFor(workspaceId, teamKey);
		return {
			issueId,
			tenantWorkspaceId: workspaceId,
			stateRank: stateRankOf(state),
			seq,
			clientId: client.id,
			lanes: client.lanes,
		};
	};

	it("merges a client's teams into ONE queue", () => {
		// Acme works ACM and ACMOPS. They bought lanes, not teams: their work
		// is one sequence, ordered by urgency, regardless of which team it is
		// filed in.
		const order = computeRoundRobinOrder([
			item("a-ops", ACME_WS, "ACMOPS", "active", 0),
			item("a-dev", ACME_WS, "ACM", "in-verification", 1),
		]);
		// in-verification outranks active even though it was filed second and
		// sits in the other team.
		expect(order).toEqual(["a-dev", "a-ops"]);
	});

	it("gives a two-lane client twice the turns", () => {
		const order = computeRoundRobinOrder([
			item("a1", ACME_WS, "ACM", "active", 0),
			item("a2", ACME_WS, "ACM", "active", 1),
			item("a3", ACME_WS, "ACM", "active", 2),
			item("a4", ACME_WS, "ACM", "active", 3),
			item("b1", BOREALIS_WS, "ACM", "active", 4),
			item("b2", BOREALIS_WS, "ACM", "active", 5),
		]);
		// Acme (2 lanes) takes two turns per cycle, Borealis (1 lane) one.
		expect(order).toEqual(["a1", "a2", "b1", "a3", "a4", "b2"]);
	});

	it("keeps a queued issue's client-chosen position", () => {
		const order = computeRoundRobinOrder([
			item("b-queued-2", BOREALIS_WS, "ACM", "queued (#2)", 0),
			item("b-queued-1", BOREALIS_WS, "ACM", "queued (#1)", 1),
			item("b-active", BOREALIS_WS, "ACM", "active", 2),
		]);
		// Active first (it is running), then the client's own queue order —
		// position 1 before position 2, despite being seen second.
		expect(order).toEqual(["b-active", "b-queued-1", "b-queued-2"]);
	});

	it("puts what the operator is blocking first, per client", () => {
		const order = computeRoundRobinOrder([
			item("a-active", ACME_WS, "ACM", "active", 0),
			item("a-verify", ACME_WS, "ACMOPS", "in-verification", 1),
			item("b-active", BOREALIS_WS, "ACM", "active", 2),
			item("b-verify", BOREALIS_WS, "ACM", "in-verification", 3),
		]);
		// Acme has two lanes, so it opens with both of its items — its
		// in-verification first because that is where we are the blocker.
		expect(order).toEqual(["a-verify", "a-active", "b-verify", "b-active"]);
	});

	it("one client's work never lands in another's sequence", () => {
		const order = computeRoundRobinOrder([
			item("a1", ACME_WS, "ACM", "active", 0),
			item("b1", BOREALIS_WS, "ACM", "active", 1),
		]);
		// Both are "ACM-n" issues. Isolation holds because grouping keys on
		// the client, never on the issue prefix.
		expect(order).toHaveLength(2);
		expect(new Set(order)).toEqual(new Set(["a1", "b1"]));
	});

	it("behaves exactly as before when no client is configured", () => {
		const empty = new ClientRegistry(undefined);
		expect(empty.configured).toBe(false);
		const order = computeRoundRobinOrder([
			{ issueId: "x1", tenantWorkspaceId: "ws-a", stateRank: 3, seq: 0 },
			{ issueId: "y1", tenantWorkspaceId: "ws-b", stateRank: 3, seq: 1 },
			{ issueId: "x2", tenantWorkspaceId: "ws-a", stateRank: 3, seq: 2 },
		]);
		// Per-workspace round-robin, one turn each: the pre-PON-207 rule.
		expect(order).toEqual(["x1", "y1", "x2"]);
	});
});
