import type { IIssueTrackerService, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPoster } from "../src/ActivityPoster.js";
import { sanitizeClientPaths } from "../src/client-content-policy.js";

/**
 * PON-189: ActivityPoster writes straight to createAgentActivity, bypassing
 * both gated paths in AgentSessionManager. That is how routing internals —
 * repo name, branch, routing method — reached a client thread on a workspace
 * whose very next thought was suppressed.
 *
 * Direct posts now obey the same floor: narration suppressed on client-quiet
 * workspaces, internal paths never surviving on any workspace.
 */

const QUIET_SESSION = "session-quiet";
const QUIET_WS = "workspace-quiet";
const LOUD_SESSION = "session-loud";
const WS = "workspace-1";

function setup() {
	const createAgentActivity = vi.fn().mockResolvedValue({
		success: true,
		agentActivity: Promise.resolve({ id: "activity-1" }),
	});
	const createComment = vi.fn().mockResolvedValue({ success: true });
	const poster = new ActivityPoster(
		new Map([
			[
				WS,
				{
					createAgentActivity,
					createComment,
				} as unknown as IIssueTrackerService,
			],
			// Registered so the workspace-fallback case exercises the guard
			// rather than returning early on a missing tracker.
			[
				QUIET_WS,
				{
					createAgentActivity,
					createComment,
				} as unknown as IIssueTrackerService,
			],
		]),
		new Map(),
		{
			debug: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
			event: vi.fn(),
		} as unknown as ILogger,
		{
			// Mirrors the real resolver: session first, workspace as fallback.
			isQuiet: (sessionId: string, workspaceId?: string) =>
				sessionId === QUIET_SESSION || workspaceId === QUIET_WS,
			// Mirrors the real guard: path floor everywhere.
			sanitize: (_sessionId: string, _surface: string, text: string) =>
				sanitizeClientPaths(text, {
					stripPrefixes: ["/root/.cyrus-community/worktrees/ws/ACM-10"],
				}).text,
		},
	);
	const bodies = () =>
		createAgentActivity.mock.calls.map((c) => c[0].content.body);
	return { poster, createAgentActivity, createComment, bodies };
}

describe("ActivityPoster - client-surface floor (PON-189)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("has no routing method at all — clients get no routing information", () => {
		const { poster } = setup();
		expect(
			(poster as unknown as Record<string, unknown>).postRoutingActivity,
		).toBeUndefined();
	});

	it("suppresses a narration thought on a quiet workspace", async () => {
		const { poster, createAgentActivity } = setup();
		await poster.postParentResumeAcknowledgment(QUIET_SESSION, WS);
		expect(createAgentActivity).not.toHaveBeenCalled();
	});

	it("posts the same narration on a non-quiet workspace", async () => {
		const { poster, createAgentActivity } = setup();
		await poster.postParentResumeAcknowledgment(LOUD_SESSION, WS);
		expect(createAgentActivity).toHaveBeenCalledOnce();
	});

	it("suppresses setup-hook output on a quiet workspace — script tails are narration", async () => {
		const { poster, createAgentActivity } = setup();
		await poster.postRepoSetupHookActivity(QUIET_SESSION, WS, {
			scriptName: "cyrus-setup.sh",
			status: "failed",
			errorMessage: "boom",
			stdoutTail: "/root/.cyrus-community/worktrees/ws/ACM-10/setup.log",
		} as never);
		expect(createAgentActivity).not.toHaveBeenCalled();
	});

	it("still posts the acknowledgment on a quiet workspace — the client needs it", async () => {
		const { poster, bodies } = setup();
		await poster.postInstantAcknowledgment(QUIET_SESSION, WS);
		expect(bodies()).toEqual(["Got it. Looking at this now."]);
	});

	it("still posts queue positions and blocked-by notices on a quiet workspace", async () => {
		const { poster, createAgentActivity } = setup();
		await poster.postQueuedAcknowledgment(QUIET_SESSION, WS, 2);
		await poster.postThoughtActivity(
			QUIET_SESSION,
			WS,
			"Blocked by **ACM-9** — will start automatically when it is resolved.",
		);
		expect(createAgentActivity).toHaveBeenCalledTimes(2);
	});

	it("path-sanitizes a sanctioned post on a NON-quiet workspace too", async () => {
		const { poster, bodies } = setup();
		await poster.postThoughtActivity(
			LOUD_SESSION,
			WS,
			"Working in /root/.cyrus-community/worktrees/ws/ACM-10/src/app/page.tsx",
		);
		expect(bodies()[0]).toBe("Working in src/app/page.tsx");
	});

	it("posts the client scope as an issue COMMENT, not an activity (PON-191)", async () => {
		const { poster, createComment, createAgentActivity } = setup();
		const ok = await poster.postClientScopeComment(
			"issue-1",
			QUIET_SESSION,
			WS,
			"**Outcome** — the dashboard works on a phone.",
		);
		expect(ok).toBe(true);
		expect(createComment).toHaveBeenCalledWith("issue-1", {
			body: "**Outcome** — the dashboard works on a phone.",
		});
		// Nothing lands on the activity stream, where Linear would collapse it.
		expect(createAgentActivity).not.toHaveBeenCalled();
	});

	it("reports failure when the scope comment throws — the caller must not ask", async () => {
		const { poster, createComment } = setup();
		createComment.mockRejectedValueOnce(new Error("network"));
		expect(
			await poster.postClientScopeComment("issue-1", QUIET_SESSION, WS, "x"),
		).toBe(false);
	});

	it("sanitizes a comment body on every workspace, and suppresses a narration comment when quiet", async () => {
		const { poster, createComment } = setup();
		await poster.postComment(
			"issue-1",
			"See /root/.cyrus-community/worktrees/ws/ACM-10/README.md",
			WS,
			{ kind: "sanctioned", sessionId: LOUD_SESSION, label: "note" },
		);
		expect(createComment).toHaveBeenCalledWith("issue-1", {
			body: "See README.md",
		});

		createComment.mockClear();
		const posted = await poster.postComment("issue-1", "internal chatter", WS, {
			kind: "narration",
			sessionId: QUIET_SESSION,
		});
		expect(posted).toBe(false);
		expect(createComment).not.toHaveBeenCalled();
	});

	it("resolves quietness from the WORKSPACE when the session is not mapped yet (PON-191)", async () => {
		// The repo-setup hook fires inside worktree creation, before the
		// session is registered against its repository. Resolving from the
		// session alone answered "not quiet" and leaked hook output.
		const { poster, createAgentActivity } = setup();
		await poster.postRepoSetupHookActivity("session-not-yet-mapped", QUIET_WS, {
			scriptName: "cyrus-setup.sh",
			status: "failed",
			errorMessage: "boom",
		} as never);
		expect(createAgentActivity).not.toHaveBeenCalled();
	});
});
