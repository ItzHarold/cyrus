import { describe, expect, it } from "vitest";
import { isQueueReorderIntent, LaneManager } from "../src/LaneManager.js";

const WS = "workspace-1";
const WS2 = "workspace-2";

function makeLane(enabled = new Set([WS, WS2])) {
	return new LaneManager((ws) => enabled.has(ws));
}

function entry(sessionId: string, issueId = `issue-${sessionId}`) {
	return {
		sessionId,
		issueId,
		issueIdentifier: `TEST-${sessionId}`,
		enqueuedAt: new Date().toISOString(),
		webhook: { organizationId: WS, agentSession: { id: sessionId } },
		kind: "created" as const,
	};
}

describe("LaneManager (PON-112)", () => {
	it("acquires a free lane and reports busy afterwards", () => {
		const lane = makeLane();
		expect(lane.acquire(WS, "a")).toBe(true);
		expect(lane.acquire(WS, "b")).toBe(false);
		expect(lane.isActive("a")).toBe(true);
		expect(lane.activeSessionOf(WS)).toBe("a");
	});

	it("re-acquire by the current holder is idempotent (duplicate webhooks)", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		expect(lane.acquire(WS, "a")).toBe(true);
		expect(lane.activeSessionOf(WS)).toBe("a");
	});

	it("enqueues FIFO with 1-based positions and is idempotent per session", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		expect(lane.enqueue(WS, entry("b"))).toBe(1);
		expect(lane.enqueue(WS, entry("c"))).toBe(2);
		expect(lane.enqueue(WS, entry("b"))).toBe(1); // duplicate keeps position
		expect(lane.positionOf("c")).toBe(2);
		expect(lane.isQueued("c")).toBe(true);
		expect(lane.isActive("c")).toBe(false);
	});

	it("release is idempotent and only honors the holder", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		expect(lane.release(WS, "b")).toBe(false);
		expect(lane.release(WS, "a")).toBe(true);
		expect(lane.release(WS, "a")).toBe(false);
		expect(lane.activeSessionOf(WS)).toBe(null);
	});

	it("takeNext dequeues the head and marks it active", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));
		lane.enqueue(WS, entry("c"));
		expect(lane.takeNext(WS)).toBe(null); // lane still held
		lane.release(WS, "a");
		const next = lane.takeNext(WS);
		expect(next?.sessionId).toBe("b");
		expect(lane.isActive("b")).toBe(true);
		expect(lane.positionOf("c")).toBe(1);
	});

	it("moveToFront reorders and reports only OTHER sessions' changes", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));
		lane.enqueue(WS, entry("c"));
		lane.enqueue(WS, entry("d"));
		const result = lane.moveToFront("d");
		expect(result?.alreadyFirst).toBe(false);
		// b: 1→2, c: 2→3; d itself is excluded from changes
		expect(result?.changes).toEqual([
			{ sessionId: "b", position: 2 },
			{ sessionId: "c", position: 3 },
		]);
		expect(lane.positionOf("d")).toBe(1);
	});

	it("moveToFront on the head is a no-op with no changes", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));
		lane.enqueue(WS, entry("c"));
		const result = lane.moveToFront("b");
		expect(result?.alreadyFirst).toBe(true);
		expect(result?.changes).toEqual([]);
	});

	it("moveToFront only shifts sessions between old and new position", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));
		lane.enqueue(WS, entry("c"));
		lane.enqueue(WS, entry("d"));
		// moving c (pos 2) to front: b shifts 1→2, d stays at 3
		const result = lane.moveToFront("c");
		expect(result?.changes).toEqual([{ sessionId: "b", position: 2 }]);
	});

	it("removeQueued drops the entry and reports shifted positions", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));
		lane.enqueue(WS, entry("c"));
		lane.enqueue(WS, entry("d"));
		const result = lane.removeQueued("b");
		expect(result?.changes).toEqual([
			{ sessionId: "c", position: 1 },
			{ sessionId: "d", position: 2 },
		]);
		expect(lane.isQueued("b")).toBe(false);
	});

	it("lanes are independent per workspace", () => {
		const lane = makeLane();
		expect(lane.acquire(WS, "a")).toBe(true);
		expect(lane.acquire(WS2, "x")).toBe(true);
		lane.enqueue(WS, entry("b"));
		expect(lane.queueLength(WS)).toBe(1);
		expect(lane.queueLength(WS2)).toBe(0);
	});

	it("serializes and restores active session, order, and context prompts", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));
		lane.enqueue(WS, entry("c"));
		lane.addContextPrompt("b", "extra context");
		const restored = makeLane();
		restored.restore(JSON.parse(JSON.stringify(lane.serialize())));
		expect(restored.activeSessionOf(WS)).toBe("a");
		expect(restored.positionOf("b")).toBe(1);
		expect(restored.positionOf("c")).toBe(2);
		expect(restored.takeNext(WS)).toBe(null); // active survives restore
		restored.release(WS, "a");
		expect(restored.takeNext(WS)?.contextPrompts).toEqual(["extra context"]);
	});

	it("queuedSessionIdsForIssue finds queued sessions by issue", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b", "issue-shared"));
		lane.enqueue(WS, entry("c", "issue-shared"));
		lane.enqueue(WS, entry("d", "issue-other"));
		expect(lane.queuedSessionIdsForIssue("issue-shared")).toEqual(["b", "c"]);
	});

	it("snapshot exposes positions but never webhook payloads", () => {
		const lane = makeLane();
		lane.acquire(WS, "a");
		lane.enqueue(WS, entry("b"));
		const snapshot = lane.snapshot();
		expect(snapshot[WS]?.activeSessionId).toBe("a");
		expect(snapshot[WS]?.queue[0]?.position).toBe(1);
		expect(JSON.stringify(snapshot)).not.toContain("webhook");
	});
});

describe("isQueueReorderIntent (PON-112)", () => {
	it.each([
		"next",
		"Next!",
		"do this one next",
		"do it next",
		"this one next",
		"prioritize this",
		"prioritise",
		"make this next",
		"move to the front",
		"move this up",
		"jump the queue",
		"please do this next",
		"first",
		"do this first",
		"bump this up",
	])("matches reorder intent: %s", (prompt) => {
		expect(isQueueReorderIntent(prompt)).toBe(true);
	});

	it.each([
		"",
		"also make sure the button is blue next to the logo",
		"when you start, do the migration first and then the API",
		"next time use the staging database",
		"the next step should be careful",
		"can you give me a status update?",
		"stop",
	])("does not match added context: %s", (prompt) => {
		expect(isQueueReorderIntent(prompt)).toBe(false);
	});
});
