import { describe, expect, it, vi } from "vitest";
import { isForeignCockpitMirror } from "../src/CockpitMirror.js";
import {
	hoursWaiting,
	newlyStalled,
	renderWaitingRoom,
	ScopeWaitingRoom,
	WAITING_ROOM_TITLE,
} from "../src/scope-waiting-room.js";

/**
 * Pre-approval visibility (PON-219).
 *
 * The cockpit contains only approved work, which removes the place an operator
 * could notice that a scope conversation had gone quiet. This is the
 * replacement: one issue, outside the work board, that exists only while
 * something is actually waiting.
 */

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as never;

describe("the waiting list", () => {
	const clientName = (ws?: string) =>
		ws === "ws-acme" ? "Acme Corp" : undefined;

	it("says plainly that none of this is work yet", () => {
		// The whole point of the change is that unapproved work is not in the
		// queue. A list that reads like a queue would undo it.
		const body = renderWaitingRoom(
			[
				{
					issueId: "i1",
					issueIdentifier: "ACM-7",
					workspaceId: "ws-acme",
					proposedAt: hoursAgo(1),
				},
			],
			{ now: NOW, stallAfterHours: 4, clientName },
		);
		expect(body).toContain("not work yet");
		expect(body).toContain("ACM-7");
		expect(body).toContain("Acme Corp");
	});

	it("marks the ones that have gone quiet, and only those", () => {
		const body = renderWaitingRoom(
			[
				{ issueId: "fresh", issueIdentifier: "ACM-1", proposedAt: hoursAgo(1) },
				{ issueId: "stale", issueIdentifier: "ACM-2", proposedAt: hoursAgo(9) },
			],
			{ now: NOW, stallAfterHours: 4, clientName },
		);
		const fresh = body.split("\n").find((l) => l.includes("ACM-1")) ?? "";
		const stale = body.split("\n").find((l) => l.includes("ACM-2")) ?? "";
		expect(fresh).not.toContain("⏳");
		expect(stale).toContain("⏳");
		expect(stale).toContain("9h");
	});

	it("distinguishes a revision from a first ask", () => {
		// A revision is still the client's turn, but it is a different
		// conversation — worth seeing which one has been re-asked.
		const body = renderWaitingRoom(
			[
				{
					issueId: "i",
					issueIdentifier: "ACM-3",
					proposedAt: hoursAgo(2),
					state: "revised",
				},
			],
			{ now: NOW, stallAfterHours: 4, clientName },
		);
		expect(body).toContain("revision sent");
	});

	it("shows a mid-work question as needing an answer, not as a scope conversation", () => {
		const body = renderWaitingRoom(
			[
				{
					issueId: "i",
					issueIdentifier: "ACM-9",
					proposedAt: hoursAgo(1),
					state: "needs-info",
				},
			],
			{ now: NOW, stallAfterHours: 4, clientName },
		);
		expect(body).toContain("answer needed mid-work");
		expect(body).not.toContain("awaiting reply");
	});

	it("survives a record with no timestamp rather than rendering NaN", () => {
		const body = renderWaitingRoom(
			[{ issueId: "i", issueIdentifier: "ACM-4" }],
			{
				now: NOW,
				stallAfterHours: 4,
				clientName,
			},
		);
		expect(body).not.toContain("NaN");
		expect(hoursWaiting({ issueId: "i" }, NOW)).toBeUndefined();
		expect(
			hoursWaiting({ issueId: "i", proposedAt: "not a date" }, NOW),
		).toBeUndefined();
	});
});

describe("stall announcements", () => {
	it("announces a conversation once, not on every tick", () => {
		const entries = [
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(9) },
		];
		const announced = new Set<string>();
		const first = newlyStalled(entries, announced, {
			now: NOW,
			stallAfterHours: 4,
		});
		expect(first).toHaveLength(1);
		announced.add("i");
		expect(
			newlyStalled(entries, announced, { now: NOW, stallAfterHours: 4 }),
		).toHaveLength(0);
	});

	it("says nothing about a conversation that is still fresh", () => {
		expect(
			newlyStalled([{ issueId: "i", proposedAt: hoursAgo(1) }], new Set(), {
				now: NOW,
				stallAfterHours: 4,
			}),
		).toHaveLength(0);
	});
});

describe("the room's title cannot be mistaken for a mirror", () => {
	it("is not adopted or closed by boot reconciliation", () => {
		// Reconcile scans the cockpit TEAM and closes anything mirror-shaped
		// that matches nothing live. The room lives in that team, so a title
		// that looked like a mirror would be silently closed on the next boot.
		expect(isForeignCockpitMirror(WAITING_ROOM_TITLE)).toBe(false);
		// Sanity: the check does recognise both real mirror shapes.
		expect(isForeignCockpitMirror("[ACM-7] Revenue totals")).toBe(true);
		expect(isForeignCockpitMirror("Acme Corp · ACM-7 — Revenue totals")).toBe(
			true,
		);
	});
});

describe("the room itself", () => {
	function makeRoom(responses: Array<Record<string, unknown>>) {
		const calls: Array<{ query: string; variables: Record<string, unknown> }> =
			[];
		const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body);
			calls.push({ query: body.query, variables: body.variables });
			return { json: async () => ({ data: responses.shift() ?? {} }) };
		});
		vi.stubGlobal("fetch", fetchMock);
		const room = new ScopeWaitingRoom(
			{
				getConfig: () => ({ linearWorkspaceId: "cockpit", teamId: "team-1" }),
				getToken: () => "tok",
				getClientName: () => "Acme Corp",
				stallAfterHours: () => 4,
				now: () => NOW,
			},
			logger,
		);
		return { room, calls };
	}

	it("reuses a CLOSED room instead of minting another", async () => {
		// The room closes when nothing is waiting and reopens when something
		// is. Searching only open issues meant every cycle created a fresh
		// one — four closed copies of the same room piled up on the board in
		// a single day.
		const { room, calls } = makeRoom([
			{
				team: {
					issues: {
						nodes: [
							{
								id: "room-old",
								title: WAITING_ROOM_TITLE,
								state: { type: "completed" },
							},
						],
					},
				},
			},
			{
				team: { states: { nodes: [{ id: "state-todo", type: "unstarted" }] } },
			},
			{ issueUpdate: { success: true } },
			{ issueUpdate: { success: true } },
		]);

		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);

		expect(calls.find((c) => c.query.includes("issueCreate"))).toBeUndefined();
		// And it is put back into a working state, or the board would say
		// "nothing is waiting" while listing conversations that are.
		const reopen = calls.find(
			(c) => c.query.includes("issueUpdate") && c.variables.s === "state-todo",
		);
		expect(reopen).toBeDefined();
		expect(reopen?.variables.id).toBe("room-old");
	});

	it("never resurrects a CANCELED room — it mints a fresh one", async () => {
		// Cancellation is a human saying this copy is dead, usually while
		// tidying duplicates. Reusing it puts the live list of waiting
		// conversations inside an issue the board shows as abandoned, and the
		// tidying itself makes the canceled copy the most recently updated —
		// so the cleanup would elect the corpse.
		const { room, calls } = makeRoom([
			{
				team: {
					issues: {
						nodes: [
							{
								id: "room-dead",
								title: WAITING_ROOM_TITLE,
								state: { type: "canceled" },
							},
						],
					},
				},
			},
			{ issueCreate: { success: true, issue: { id: "room-new" } } },
			{ issueUpdate: { success: true } },
		]);

		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);

		expect(calls.find((c) => c.query.includes("issueCreate"))).toBeDefined();
		expect(
			calls.find((c) => JSON.stringify(c.variables).includes("room-dead")),
		).toBeUndefined();
	});

	it("still prefers an OPEN room when both exist", async () => {
		const { room, calls } = makeRoom([
			{
				team: {
					issues: {
						nodes: [
							{
								id: "room-closed",
								title: WAITING_ROOM_TITLE,
								state: { type: "canceled" },
							},
							{
								id: "room-open",
								title: WAITING_ROOM_TITLE,
								state: { type: "unstarted" },
							},
						],
					},
				},
			},
			{
				team: { states: { nodes: [{ id: "state-todo", type: "unstarted" }] } },
			},
			{ issueUpdate: { success: true } },
			{ issueUpdate: { success: true } },
		]);

		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);

		const writes = calls.filter((c) => c.query.includes("issueUpdate"));
		expect(writes.every((w) => w.variables.id === "room-open")).toBe(true);
		// An open room is not reopened: no state write, no states query.
		expect(writes.some((w) => (w.variables as { s?: string }).s)).toBe(false);
		expect(calls.some((c) => c.query.includes("states(first:30)"))).toBe(false);
	});

	it("creates the room OUTSIDE the project, so it is never in the work queue", async () => {
		// This is the whole design decision in one assertion: the operator's
		// board is the project board.
		const { room, calls } = makeRoom([
			{ team: { issues: { nodes: [] } } },
			{ issueCreate: { issue: { id: "room-1" } } },
		]);
		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);

		const create = calls.find((c) => c.query.includes("issueCreate"));
		expect(create).toBeDefined();
		const input = create?.variables.input as Record<string, unknown>;
		expect(input.teamId).toBe("team-1");
		expect(input.projectId).toBeUndefined();
		expect(input.title).toBe(WAITING_ROOM_TITLE);
	});

	it("adopts an existing room rather than minting a second one", async () => {
		// A restart loses the id. Trusting our own map here is the exact
		// mistake that produced duplicate mirror threads.
		const { room, calls } = makeRoom([
			{
				team: {
					issues: {
						nodes: [
							{
								id: "room-existing",
								title: WAITING_ROOM_TITLE,
								state: { type: "started" },
							},
						],
					},
				},
			},
			{ issueUpdate: { success: true } },
		]);
		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);

		expect(calls.find((c) => c.query.includes("issueCreate"))).toBeUndefined();
		const update = calls.find((c) => c.query.includes("issueUpdate"));
		expect(update?.variables.id).toBe("room-existing");
	});

	it("reopens into Backlog, not Todo, so the room stays out of the work views (v3.1, requirement C)", async () => {
		const { room, calls } = makeRoom([
			{
				team: {
					issues: {
						nodes: [
							{
								id: "room-old",
								title: WAITING_ROOM_TITLE,
								state: { type: "completed" },
							},
						],
					},
				},
			},
			{
				team: {
					states: {
						nodes: [
							{ id: "state-todo", type: "unstarted" },
							{ id: "state-backlog", type: "backlog" },
						],
					},
				},
			},
			{ issueUpdate: { success: true } },
			{ issueUpdate: { success: true } },
		]);

		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);

		const reopen = calls.find(
			(c) =>
				c.query.includes("issueUpdate") &&
				(c.variables as { s?: string }).s !== undefined,
		);
		expect((reopen?.variables as { s?: string }).s).toBe("state-backlog");
	});

	it("closes to the state named Done, not to the first completed state it finds (v3.1, requirement C)", async () => {
		// Cockpit teams have two completed states, Delivered and Done. A
		// closed waiting room in "Delivered" reads as a delivery on the board.
		const { room, calls } = makeRoom([
			{ team: { issues: { nodes: [] } } },
			{ issueCreate: { issue: { id: "room-1" } } },
			{ issueUpdate: { success: true } },
			{
				team: {
					states: {
						nodes: [
							{ id: "state-delivered", type: "completed", name: "Delivered" },
							{ id: "state-done", type: "completed", name: "Done" },
						],
					},
				},
			},
			{ issueUpdate: { success: true } },
		]);
		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);
		await room.sync([]);

		const close = calls
			.filter((c) => c.query.includes("issueUpdate"))
			.find((c) => (c.variables as { s?: string }).s !== undefined);
		expect((close?.variables as { s?: string }).s).toBe("state-done");
	});

	it("closes itself when nothing is waiting", async () => {
		const { room, calls } = makeRoom([
			{ team: { issues: { nodes: [] } } },
			{ issueCreate: { issue: { id: "room-1" } } },
			{ issueUpdate: { success: true } },
			{
				team: { states: { nodes: [{ id: "state-done", type: "completed" }] } },
			},
			{ issueUpdate: { success: true } },
		]);
		await room.sync([
			{ issueId: "i", issueIdentifier: "ACM-7", proposedAt: hoursAgo(1) },
		]);
		await room.sync([]);

		const close = calls
			.filter((c) => c.query.includes("issueUpdate"))
			.find((c) => (c.variables as { s?: string }).s === "state-done");
		expect(close).toBeDefined();
	});

	it("empties its list before it closes, so a closed room never shows a stale row", async () => {
		// Live: CKP-21 was Delivered (closed) for a day while its description
		// still read "FRO-64 · awaiting reply · 0h". The state said nothing
		// was waiting; the body said something was. The reset comes before
		// the state change, so a failed close still leaves an honest body.
		const { room, calls } = makeRoom([
			{ team: { issues: { nodes: [] } } },
			{ issueCreate: { issue: { id: "room-1" } } },
			{ issueUpdate: { success: true } },
			{
				team: { states: { nodes: [{ id: "state-done", type: "completed" }] } },
			},
			{ issueUpdate: { success: true } },
		]);
		await room.sync([
			{ issueId: "i", issueIdentifier: "FRO-64", proposedAt: hoursAgo(0) },
		]);
		await room.sync([]);

		const updates = calls.filter((c) => c.query.includes("issueUpdate"));
		const reset = updates.findIndex((c) =>
			String(
				(c.variables as { input?: { description?: string } }).input
					?.description ?? "",
			).startsWith("Nothing waiting"),
		);
		const close = updates.findIndex(
			(c) => (c.variables as { s?: string }).s === "state-done",
		);
		expect(reset).toBeGreaterThanOrEqual(0);
		expect(close).toBeGreaterThanOrEqual(0);
		expect(reset).toBeLessThan(close);
		expect(
			(updates[reset].variables as { input: { description: string } }).input
				.description,
		).not.toContain("FRO-64");
	});

	it("does not open a room when nothing is waiting in the first place", async () => {
		// An empty room is clutter, and clutter on a surface that exists to be
		// noticed is what stops it being noticed.
		const { room, calls } = makeRoom([]);
		await room.sync([]);
		expect(calls).toHaveLength(0);
	});

	it("never throws, whatever Linear says", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network");
			}),
		);
		const room = new ScopeWaitingRoom(
			{
				getConfig: () => ({ linearWorkspaceId: "cockpit", teamId: "team-1" }),
				getToken: () => "tok",
				getClientName: () => undefined,
				stallAfterHours: () => 4,
				now: () => NOW,
			},
			logger,
		);
		await expect(
			room.sync([{ issueId: "i", proposedAt: hoursAgo(1) }]),
		).resolves.toBeUndefined();
	});
});

describe("a restart does not re-announce what was already quiet", () => {
	it("stays silent on the first sync, then announces new stalls", async () => {
		// `announced` is in-memory. Without this, every boot comments again on
		// every conversation that was already stalled — which trains the
		// operator to ignore the one surface built to be noticed.
		const calls: Array<{ query: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: string, init: { body: string }) => {
				const body = JSON.parse(init.body);
				calls.push({ query: body.query });
				if (body.query.includes("team(id:$id){ issues"))
					return {
						json: async () => ({ data: { team: { issues: { nodes: [] } } } }),
					};
				return {
					json: async () => ({
						data: { issueCreate: { issue: { id: "room-1" } } },
					}),
				};
			}),
		);
		const room = new ScopeWaitingRoom(
			{
				getConfig: () => ({ linearWorkspaceId: "cockpit", teamId: "team-1" }),
				getToken: () => "tok",
				getClientName: () => "Acme Corp",
				stallAfterHours: () => 4,
				now: () => NOW,
			},
			logger,
		);

		// Boot: one conversation already long stalled.
		await room.sync([
			{ issueId: "old", issueIdentifier: "ACM-1", proposedAt: hoursAgo(30) },
		]);
		expect(calls.some((c) => c.query.includes("commentCreate"))).toBe(false);

		// A second one crosses the line while we are up — that IS a transition.
		await room.sync([
			{ issueId: "old", issueIdentifier: "ACM-1", proposedAt: hoursAgo(30) },
			{ issueId: "new", issueIdentifier: "ACM-2", proposedAt: hoursAgo(5) },
		]);
		expect(calls.some((c) => c.query.includes("commentCreate"))).toBe(true);
	});
});
