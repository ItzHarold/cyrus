import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

/**
 * When a workspace lane releases (PON-154).
 *
 * Observed live in a concurrency-1 lane: a Stop-hook-blocked stop made the CLI
 * emit a result and KEEP STREAMING; the lane released on that mid-session
 * result, a second session was admitted, and two sessions ran concurrently in
 * a serialized lane for ~20 seconds (FRO-47/FRO-48, 2026-08-21).
 *
 * The rule: a result message is not the end of a session. The lane releases on
 * the runner's actual completion. `completeSession` only fires the release
 * itself when the runner is already stopped — the fallback for runners whose
 * result arrives after their stream ends — and defers otherwise.
 */

const resultMessage = {
	type: "result",
	subtype: "success",
	duration_ms: 1,
	duration_api_ms: 1,
	is_error: false,
	num_turns: 1,
	result: "done",
	stop_reason: null,
	total_cost_usd: 0,
	usage: {
		input_tokens: 1,
		output_tokens: 1,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation: null,
	},
	modelUsage: {},
	permission_denials: [],
	uuid: "result-1",
	session_id: "sdk-session",
} as never;

describe("AgentSessionManager - lane release timing (PON-154)", () => {
	const sessionId = "session-lane-timing";
	let manager: AgentSessionManager;
	let onSessionEnded: ReturnType<typeof vi.fn>;

	const makeManager = () => {
		onSessionEnded = vi.fn();
		manager = new AgentSessionManager(
			undefined,
			undefined,
			undefined,
			onSessionEnded,
		);
		manager.createCyrusAgentSession(
			sessionId,
			"issue-1",
			{
				id: "issue-1",
				identifier: "FRO-47",
				title: "t",
				description: "d",
				branchName: "b",
			},
			{ path: "/tmp/ws", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, {
			postActivity: vi.fn().mockResolvedValue({ activityId: "a1" }),
			createAgentSession: vi.fn().mockResolvedValue("s1"),
		} as never);
	};

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		makeManager();
	});

	it("DEFERS the release when the runner is still streaming", async () => {
		// The observed defect, as a test: the result arrives while the runner
		// reports running (a Stop-hook continuation). Releasing here is what
		// admitted a second session into a serialized lane.
		const session = manager.getSession(sessionId);
		if (session) {
			session.agentRunner = {
				isRunning: () => true,
			} as never;
		}

		await manager.completeSession(sessionId, resultMessage);

		expect(onSessionEnded).not.toHaveBeenCalled();
	});

	it("releases immediately when the runner has already stopped", async () => {
		// The fallback: a runner whose stream ended before its (final) result
		// was processed. ClaudeRunner sets isRunning=false before emitting a
		// deferred result for exactly this check.
		const session = manager.getSession(sessionId);
		if (session) {
			session.agentRunner = {
				isRunning: () => false,
			} as never;
		}

		await manager.completeSession(sessionId, resultMessage);

		expect(onSessionEnded).toHaveBeenCalledTimes(1);
		expect(onSessionEnded).toHaveBeenCalledWith(sessionId);
	});

	it("releases immediately when there is no runner at all", async () => {
		// A session restored from persistence can have a result processed with
		// no live runner attached. A missing runner must never wedge the lane.
		await manager.completeSession(sessionId, resultMessage);

		expect(onSessionEnded).toHaveBeenCalledTimes(1);
	});

	it("still releases on the user-stop path even mid-stream", async () => {
		// A requested stop is a deliberate end — the stop-signal path also
		// releases, and release is idempotent, but completeSession's own fire
		// must not be lost for stopped sessions regardless of runner state:
		// the runner may take time to wind down after a stop.
		const session = manager.getSession(sessionId);
		if (session) {
			session.agentRunner = {
				isRunning: () => false,
			} as never;
		}
		manager.requestSessionStop(sessionId);

		await manager.completeSession(sessionId, resultMessage);

		expect(onSessionEnded).toHaveBeenCalledTimes(1);
	});
});
