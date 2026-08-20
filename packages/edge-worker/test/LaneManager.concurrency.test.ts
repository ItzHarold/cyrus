import { describe, expect, it } from "vitest";
import { LaneManager } from "../src/LaneManager.js";

/**
 * Lane behaviour at N > 1 (PON-139).
 *
 * These exist because the existing 44 lane and revocation tests all run at N=1
 * and stayed green through four separate bugs that leaked or misdirected lane
 * slots at N > 1. A guarantee that is only ever exercised at its degenerate case
 * is not tested, and "one active session" generalising to "at most N" is exactly
 * the kind of change where the degenerate case keeps passing.
 */

const WS = "workspace-1";
const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	event: () => {},
} as never;

function makeLane(concurrency: number, enabled = true) {
	return new LaneManager(
		() => enabled,
		silentLogger,
		() => concurrency,
	);
}

function entry(sessionId: string) {
	return {
		sessionId,
		enqueuedAt: new Date(0).toISOString(),
		webhook: {},
		kind: "created" as const,
	};
}

describe("LaneManager at N = 1 (unchanged behaviour)", () => {
	it("admits one and refuses the second", () => {
		const lane = makeLane(1);
		expect(lane.acquire(WS, "a")).toBe(true);
		expect(lane.acquire(WS, "b")).toBe(false);
	});

	it("admits the next only after a release", () => {
		const lane = makeLane(1);
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));

		expect(lane.takeNext(WS)).toBeNull();
		expect(lane.release(WS, "a")).toBe(true);
		expect(lane.takeNext(WS)?.sessionId).toBe("b");
	});
});

describe("LaneManager at N = 2", () => {
	it("admits exactly two and queues the third", () => {
		const lane = makeLane(2);
		expect(lane.acquire(WS, "a")).toBe(true);
		expect(lane.acquire(WS, "b")).toBe(true);
		expect(lane.acquire(WS, "c")).toBe(false);

		expect(lane.activeSessionsOf(WS).sort()).toEqual(["a", "b"]);
	});

	it("reports every holder, not just the first", () => {
		// The single-holder accessor is what four separate bugs read.
		const lane = makeLane(2);
		lane.acquire(WS, "a");
		lane.acquire(WS, "b");

		expect(lane.isActive("a")).toBe(true);
		expect(lane.isActive("b")).toBe(true);
		expect(lane.activeSessionsOf(WS)).toHaveLength(2);
	});

	it("frees exactly one slot per release", () => {
		const lane = makeLane(2);
		lane.acquire(WS, "a");
		lane.acquire(WS, "b");
		lane.enqueue(WS, entry("c"));

		expect(lane.takeNext(WS)).toBeNull(); // still full
		lane.release(WS, "a");
		expect(lane.takeNext(WS)?.sessionId).toBe("c");
		expect(lane.activeSessionsOf(WS).sort()).toEqual(["b", "c"]);
	});

	it("releasing a session that does not hold a slot changes nothing", () => {
		const lane = makeLane(2);
		lane.acquire(WS, "a");

		expect(lane.release(WS, "never-held")).toBe(false);
		expect(lane.activeSessionsOf(WS)).toEqual(["a"]);
	});
});

describe("abnormal ends free the slot they held", () => {
	// Every end path funnels through release(sessionId). What matters at N > 1
	// is that it frees *that* session's slot and leaves the others alone.
	it.each([
		"result",
		"runner_error",
		"stop_signal",
		"issue_removed",
	])("a session ending via %s frees only its own slot and admits the next", (_reason) => {
		const lane = makeLane(2);
		lane.acquire(WS, "a");
		lane.acquire(WS, "b");
		lane.enqueue(WS, entry("c"));

		// "a" ends abnormally.
		expect(lane.release(WS, "a")).toBe(true);

		// "b" keeps working; "c" is admitted into the freed slot.
		expect(lane.isActive("b")).toBe(true);
		expect(lane.takeNext(WS)?.sessionId).toBe("c");
		expect(lane.activeSessionsOf(WS).sort()).toEqual(["b", "c"]);
	});

	it("a crashed session does not strand the queue behind it", () => {
		const lane = makeLane(1);
		lane.acquire(WS, "crashed");
		lane.enqueue(WS, entry("waiting"));

		lane.release(WS, "crashed");

		expect(lane.takeNext(WS)?.sessionId).toBe("waiting");
	});

	it("releasing every holder empties the lane and drains the queue", () => {
		// The deactivateTenant shape: a revoked tenant must leave nothing held.
		const lane = makeLane(3);
		lane.acquire(WS, "a");
		lane.acquire(WS, "b");
		lane.acquire(WS, "c");
		lane.enqueue(WS, entry("d"));

		for (const held of lane.activeSessionsOf(WS)) {
			lane.release(WS, held);
		}
		expect(lane.activeSessionsOf(WS)).toEqual([]);

		// Drain by releasing exactly what takeNext admitted — releasing "whichever
		// is active" was the bug, and with several holders it frees the wrong one.
		let drained = lane.takeNext(WS);
		while (drained) {
			lane.release(WS, drained.sessionId);
			drained = lane.takeNext(WS);
		}
		expect(lane.activeSessionsOf(WS)).toEqual([]);
	});
});

describe("persistence across a restart", () => {
	it("restores every holder, not just the first", () => {
		const before = makeLane(2);
		before.acquire(WS, "a");
		before.acquire(WS, "b");
		before.enqueue(WS, entry("c"));

		const after = makeLane(2);
		after.restore(before.serialize());

		expect(after.activeSessionsOf(WS).sort()).toEqual(["a", "b"]);
		expect(after.isActive("a")).toBe(true);
		expect(after.isActive("b")).toBe(true);
		expect(after.workspaceOf("c")).toBe(WS);
	});

	it("stays readable by a build that only understands one holder", () => {
		// Rollback safety at the default N=1: the legacy field is a complete
		// description, so an older build restores the lane intact.
		const lane = makeLane(1);
		lane.acquire(WS, "only");

		const state = lane.serialize();
		expect(state[WS]?.activeSessionId).toBe("only");
		expect(state[WS]?.activeSessionIds).toEqual(["only"]);
	});

	it("does not misrepresent multiple holders to an older build", () => {
		// With more than one holder the legacy field cannot describe the state,
		// so it is null rather than an arbitrary one of them. An older build then
		// restores an empty lane instead of silently losing a session it thinks
		// it is tracking.
		const lane = makeLane(2);
		lane.acquire(WS, "a");
		lane.acquire(WS, "b");

		const state = lane.serialize();
		expect(state[WS]?.activeSessionId).toBeNull();
		expect(state[WS]?.activeSessionIds?.sort()).toEqual(["a", "b"]);
	});

	it("restores state written before per-lane concurrency existed", () => {
		const after = makeLane(2);
		after.restore({
			[WS]: {
				activeSessionId: "legacy-holder",
				queue: [],
			},
		});

		expect(after.activeSessionsOf(WS)).toEqual(["legacy-holder"]);
		expect(after.isActive("legacy-holder")).toBe(true);
	});
});

describe("concurrency configuration", () => {
	it("treats a missing or invalid limit as 1", () => {
		for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
			const lane = new LaneManager(
				() => true,
				silentLogger,
				() => bad,
			);
			expect(lane.acquire(WS, "a")).toBe(true);
			expect(lane.acquire(WS, "b")).toBe(false);
		}
	});

	it("floors a fractional limit rather than admitting a partial session", () => {
		const lane = makeLane(2.9);
		expect(lane.acquire(WS, "a")).toBe(true);
		expect(lane.acquire(WS, "b")).toBe(true);
		expect(lane.acquire(WS, "c")).toBe(false);
	});
});
