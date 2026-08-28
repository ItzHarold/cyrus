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
const LOUD_SESSION = "session-loud";
const WS = "workspace-1";

function setup() {
	const createAgentActivity = vi.fn().mockResolvedValue({
		success: true,
		agentActivity: Promise.resolve({ id: "activity-1" }),
	});
	const poster = new ActivityPoster(
		new Map([[WS, { createAgentActivity } as unknown as IIssueTrackerService]]),
		new Map(),
		{
			debug: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
			event: vi.fn(),
		} as unknown as ILogger,
		{
			isQuiet: (sessionId: string) => sessionId === QUIET_SESSION,
			// Mirrors the real guard: path floor everywhere.
			sanitize: (_sessionId: string, _surface: string, text: string) =>
				sanitizeClientPaths(text, {
					stripPrefixes: ["/root/.cyrus-community/worktrees/ws/ACM-10"],
				}).text,
		},
	);
	const bodies = () =>
		createAgentActivity.mock.calls.map((c) => c[0].content.body);
	return { poster, createAgentActivity, bodies };
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

	it("posts the client scope proposal on a quiet workspace and reports success", async () => {
		const { poster, bodies } = setup();
		const ok = await poster.postClientScopeProposal(
			QUIET_SESSION,
			WS,
			"**Outcome** — the dashboard works on a phone.",
		);
		expect(ok).toBe(true);
		expect(bodies()).toEqual(["**Outcome** — the dashboard works on a phone."]);
	});

	it("reports failure when the scope post is rejected — the caller must not ask", async () => {
		const { poster, createAgentActivity } = setup();
		createAgentActivity.mockResolvedValueOnce({ success: false });
		expect(await poster.postClientScopeProposal(QUIET_SESSION, WS, "x")).toBe(
			false,
		);
	});

	it("reports failure when the scope post throws", async () => {
		const { poster, createAgentActivity } = setup();
		createAgentActivity.mockRejectedValueOnce(new Error("network"));
		expect(await poster.postClientScopeProposal(QUIET_SESSION, WS, "x")).toBe(
			false,
		);
	});
});
