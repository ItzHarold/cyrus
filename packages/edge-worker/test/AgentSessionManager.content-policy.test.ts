import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

/**
 * The runtime tripwire (PON-168 / R2): model-authored client-bound text runs
 * through the content policy — violations are journaled and the unambiguous
 * ones redacted, loudly. Covers the final-response path and the strict
 * delivery post.
 */
describe("AgentSessionManager - client content tripwire", () => {
	const SESSION_ID = "session-1";
	let manager: AgentSessionManager;
	let sink: {
		postActivity: ReturnType<typeof vi.fn>;
		createAgentSession: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			SESSION_ID,
			"issue-1",
			{
				id: "issue-1",
				identifier: "FRO-1",
				title: "t",
				description: "d",
				branchName: "b",
			},
			{ path: "/tmp/ws", isGitWorktree: false },
		);
		sink = {
			postActivity: vi.fn().mockResolvedValue({ activityId: "a1" }),
			createAgentSession: vi.fn().mockResolvedValue("s1"),
		};
		manager.setActivitySink(SESSION_ID, sink as never);
	});

	it("redacts internals from the final response and journals the violation", async () => {
		await manager.completeSession(SESSION_ID, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result:
				"Cyrus finished the work in /root/.service/worktrees/FRO-1 using claude-opus-5.",
			total_cost_usd: 0,
			usage: { input_tokens: 1, output_tokens: 1 },
			session_id: "sdk-1",
		} as never);

		const posted = JSON.stringify(sink.postActivity.mock.calls);
		expect(posted).not.toMatch(/cyrus/i);
		expect(posted).not.toContain("/root/");
		expect(posted).not.toContain("claude-opus-5");
		expect(posted).toContain("the agent");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("client_content_policy_violation"),
		);
	});

	it("clean responses pass byte-identical with no journal noise", async () => {
		const clean = "Done — the export view is live on the preview.";
		await manager.completeSession(SESSION_ID, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: clean,
			total_cost_usd: 0,
			usage: { input_tokens: 1, output_tokens: 1 },
			session_id: "sdk-1",
		} as never);
		expect(JSON.stringify(sink.postActivity.mock.calls)).toContain(clean);
		const warns = (console.warn as ReturnType<typeof vi.fn>).mock.calls
			.map((c) => String(c[0]))
			.filter((s) => s.includes("client_content_policy_violation"));
		expect(warns).toHaveLength(0);
	});

	it("the strict delivery post is checked too", async () => {
		await manager.postResponseActivityStrict(
			SESSION_ID,
			"Delivered by cyrus-edge-worker.",
		);
		const posted = JSON.stringify(sink.postActivity.mock.calls);
		expect(posted).not.toMatch(/cyrus/i);
		expect(posted).toContain("the agent");
	});
});
