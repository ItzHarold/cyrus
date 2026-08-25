import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { CLIENT_MESSAGES } from "../src/client-messages.js";

/**
 * Client-quiet activity stream (PON-179). On a gated workspace the Linear
 * activity stream is a CLIENT surface: working narration (thought/action
 * activities — including tool-call renderings, which can carry internal
 * paths and even the operator note's parameters) must not post. Liveness
 * comes from the ack, the per-invocation analyzing thought, ONE generic
 * status, elicitations, and the final response.
 */

const SESSION_ID = "agent-session-quiet-1";

function makeManager(quiet: boolean) {
	const manager = new AgentSessionManager(
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		() => quiet,
	);
	manager.createCyrusAgentSession(
		SESSION_ID,
		"issue-1",
		{
			id: "issue-1",
			identifier: "FRO-99",
			title: "t",
			description: "d",
			branchName: "b",
		},
		{
			path: "/root/.cyrus-community/worktrees/ws-1/FRO-99",
			isGitWorktree: false,
		},
	);
	const postActivity = vi.fn().mockResolvedValue({ activityId: "a-1" });
	manager.setActivitySink(SESSION_ID, {
		postActivity,
		createAgentSession: vi.fn(),
	} as never);
	return { manager, postActivity };
}

describe("AgentSessionManager - client-quiet stream (PON-179)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("suppresses narration on a quiet session: one generic status, then silence", async () => {
		const { manager, postActivity } = makeManager(true);

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createActionActivity(
			SESSION_ID,
			"Edit",
			"/root/.cyrus-community/worktrees/ws-1/FRO-99/SUPPORT.md",
		);
		await manager.createThoughtActivity(SESSION_ID, "Now writing the file…");

		expect(postActivity).toHaveBeenCalledTimes(1);
		const [, content] = postActivity.mock.calls[0] as [
			string,
			{ body: string },
		];
		expect(content.body).toBe(CLIENT_MESSAGES.workingStatus());
	});

	it("tool-call action renderings never post on a quiet session (the operator-note leak)", async () => {
		const { manager, postActivity } = makeManager(true);
		await manager.createThoughtActivity(SESSION_ID, "warm up"); // consumes the status slot
		postActivity.mockClear();

		await manager.createActionActivity(
			SESSION_ID,
			"mcp__cyrus-tools__record_operator_note",
			'{"cwd":"/root/.cyrus-community/worktrees/ws-1/FRO-99","note":"## Internal reading — approach, risks"}',
		);

		expect(postActivity).not.toHaveBeenCalled();
	});

	it("the analyzing thought passes through and re-arms the status for the next invocation", async () => {
		const { manager, postActivity } = makeManager(true);

		await manager.createThoughtActivity(SESSION_ID, "narration 1"); // → status
		await manager.createThoughtActivity(SESSION_ID, "narration 2"); // suppressed
		await manager.postAnalyzingThought(SESSION_ID); // allowed + re-arm
		await manager.createThoughtActivity(SESSION_ID, "narration 3"); // → status again

		const bodies = postActivity.mock.calls.map(
			(call) => (call[1] as { body: string }).body,
		);
		expect(bodies).toEqual([
			CLIENT_MESSAGES.workingStatus(),
			"Analyzing your request…",
			CLIENT_MESSAGES.workingStatus(),
		]);
	});

	it("a non-quiet session posts narration verbatim — non-gated workspaces unchanged", async () => {
		const { manager, postActivity } = makeManager(false);

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createActionActivity(SESSION_ID, "Bash", "pnpm test");

		expect(postActivity).toHaveBeenCalledTimes(2);
		expect((postActivity.mock.calls[0]?.[1] as { body: string }).body).toBe(
			"Reading the repo…",
		);
	});

	it("the elicitation body goes through the sanitizer (source wiring)", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const handler = readFileSync(
			join(__dirname, "..", "src", "AskUserQuestionHandler.ts"),
			"utf8",
		);
		expect(handler).toContain("sanitizeClientText?.(");
		const worker = readFileSync(
			join(__dirname, "..", "src", "EdgeWorker.ts"),
			"utf8",
		);
		expect(worker).toContain("sanitizeClientSurfaceText(");
	});

	it("sanitizeClientSurfaceText redacts paths REPO-RELATIVE on quiet sessions only", () => {
		const quiet = makeManager(true).manager;
		const sanitized = quiet.sanitizeClientSurfaceText(
			SESSION_ID,
			"elicitation",
			"Should I update /root/.cyrus-community/worktrees/ws-1/FRO-99/app/page.tsx?",
		);
		expect(sanitized).toBe("Should I update app/page.tsx?");

		const loud = makeManager(false).manager;
		const untouched = loud.sanitizeClientSurfaceText(
			SESSION_ID,
			"elicitation",
			"path /root/.cyrus-community/worktrees/ws-1/FRO-99/app/page.tsx stays",
		);
		expect(untouched).toContain("/root/.cyrus-community");
	});
});
