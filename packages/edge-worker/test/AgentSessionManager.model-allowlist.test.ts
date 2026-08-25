import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

/**
 * Model allowlist verification (PON-147). Every model in modelUsage must be
 * the pin or a known SDK-internal helper — the plurality check alone let an
 * unpinned model do 49% of a session unexamined (and one three-model session
 * slipped through in the wild). The pin is claude-opus-5 via test setup.
 */

const SESSION_ID = "session-model-allowlist";

function makeManager() {
	const manager = new AgentSessionManager();
	manager.createCyrusAgentSession(
		SESSION_ID,
		"issue-1",
		{
			id: "issue-1",
			identifier: "MDL-1",
			title: "t",
			description: "d",
			branchName: "b",
		},
		{ path: "/tmp/ws", isGitWorktree: false },
	);
	manager.setActivitySink(SESSION_ID, {
		postActivity: vi.fn().mockResolvedValue({ activityId: "a1" }),
		createAgentSession: vi.fn().mockResolvedValue("s1"),
	} as never);
	return manager;
}

function resultWith(modelUsage: Record<string, Record<string, number>>) {
	return {
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
		modelUsage,
		permission_denials: [],
		uuid: "result-1",
		session_id: "sdk-session",
	} as never;
}

describe("AgentSessionManager - model allowlist (PON-147)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("pinned + known-internal helper passes (the 53-of-62 shape)", async () => {
		const manager = makeManager();
		await expect(
			manager.handleClaudeMessage(
				SESSION_ID,
				resultWith({
					"claude-opus-5": { inputTokens: 900, outputTokens: 100 },
					"claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 5 },
				}),
			),
		).resolves.not.toThrow();
		expect(manager.getSession(SESSION_ID)?.status).not.toBe("error");
	});

	it("the historical three-model case FAILS — the regression the wild leaked", async () => {
		const manager = makeManager();
		// The dispatcher swallows the throw by design (one failure must not
		// block later messages) and fails the session via status=error plus
		// the drift notification thought — assert THAT mechanism.
		const sink = (manager as never as Record<string, any>).getActivitySink(
			SESSION_ID,
		);
		await manager.handleClaudeMessage(
			SESSION_ID,
			resultWith({
				"claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 5 },
				"claude-opus-5": { inputTokens: 600, outputTokens: 100 },
				"claude-sonnet-5": { inputTokens: 90, outputTokens: 15 },
			}),
		);
		const posted = JSON.stringify(sink.postActivity.mock.calls);
		expect(posted).toContain("Model drift");
		expect(posted).toContain("claude-sonnet-5");
		expect(posted).toContain("PON-147");
		expect(manager.getSession(SESSION_ID)?.status).toBe("error");
	});

	it("the failure names the model and its token share", async () => {
		const manager = makeManager();
		const sink = (manager as never as Record<string, any>).getActivitySink(
			SESSION_ID,
		);
		await manager.handleClaudeMessage(
			SESSION_ID,
			resultWith({
				"claude-opus-5": { inputTokens: 490, outputTokens: 20 },
				"claude-sonnet-5": { inputTokens: 480, outputTokens: 10 },
			}),
		);
		const posted = JSON.stringify(sink.postActivity.mock.calls);
		expect(posted).toMatch(/claude-sonnet-5 carried 49%/);
	});

	it("a wrong DOMINANT model still fails via the PON-110 path, unchanged", async () => {
		const manager = makeManager();
		const sink = (manager as never as Record<string, any>).getActivitySink(
			SESSION_ID,
		);
		await manager.handleClaudeMessage(
			SESSION_ID,
			resultWith({
				"claude-sonnet-5": { inputTokens: 900, outputTokens: 100 },
				"claude-opus-5": { inputTokens: 10, outputTokens: 5 },
			}),
		);
		const posted = JSON.stringify(sink.postActivity.mock.calls);
		expect(posted).toContain("PON-110");
		expect(manager.getSession(SESSION_ID)?.status).toBe("error");
	});

	it("dated pin suffixes still pass (snapshot resolution)", async () => {
		const manager = makeManager();
		await expect(
			manager.handleClaudeMessage(
				SESSION_ID,
				resultWith({
					"claude-opus-5-20260115": { inputTokens: 900, outputTokens: 100 },
				}),
			),
		).resolves.not.toThrow();
	});
});
