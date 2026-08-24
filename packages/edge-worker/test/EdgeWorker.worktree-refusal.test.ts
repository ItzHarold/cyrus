import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { WorktreeCreationRefusedError } from "../src/GitService.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * EdgeWorker wiring for PON-161/162: a worktree-creation refusal is terminal
 * for the session (visible error activity, mirror closed, rethrow — the
 * caller's lane backstop releases the slot and no runner starts), and the
 * createWorkspace handler receives the git credential resolver the
 * production path was missing.
 */

const WS = "gated-workspace-id";
const SESSION_ID = "agent-session-0001";
const ISSUE = { id: "issue-uuid-0001", identifier: "FRO-60" };

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

describe("EdgeWorker - worktree refusal terminal + git auth threading", () => {
	let worker: EdgeWorker;
	let tracker: { createAgentActivity: ReturnType<typeof vi.fn> };
	let mirror: {
		close: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};

	const repository = {
		id: "repo-1",
		name: "frontdoor-sandbox",
		repositoryPath: "/repos/frontdoor-sandbox",
		workspaceBaseDir: "/workspaces",
		baseBranch: "main",
		linearWorkspaceId: WS,
	} as never;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
		privates(worker).config.linearWorkspaces = { [WS]: { linearToken: "t" } };
		tracker = { createAgentActivity: vi.fn().mockResolvedValue(undefined) };
		privates(worker).issueTrackers.set(WS, tracker);
		mirror = {
			close: vi.fn().mockResolvedValue(undefined),
			upsert: vi.fn().mockResolvedValue(undefined),
		};
		privates(worker).cockpitMirror = mirror;
		privates(worker).fetchFullIssueDetails = vi
			.fn()
			.mockResolvedValue({ id: ISSUE.id, identifier: ISSUE.identifier });
		privates(worker).moveIssueToStartedState = vi
			.fn()
			.mockResolvedValue(undefined);
	});

	const callCreateSession = () =>
		privates(worker).createCyrusAgentSession(
			SESSION_ID,
			ISSUE,
			[repository],
			privates(worker).agentSessionManager,
			WS,
		);

	it("a refusal from the handler is terminal: visible error, mirror closed, rethrown", async () => {
		privates(worker).config.handlers = {
			createWorkspace: vi
				.fn()
				.mockRejectedValue(
					new WorktreeCreationRefusedError(
						"git fetch failed for frontdoor-sandbox",
						"frontdoor-sandbox",
					),
				),
		};

		await expect(callCreateSession()).rejects.toBeInstanceOf(
			WorktreeCreationRefusedError,
		);

		// Visible where the client looks — never an ack followed by silence.
		expect(tracker.createAgentActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				agentSessionId: SESSION_ID,
				content: expect.objectContaining({
					type: "error",
					body: expect.stringContaining("frontdoor-sandbox"),
				}),
			}),
		);
		// The cockpit must not show a live session that never started.
		expect(mirror.close).toHaveBeenCalledWith(ISSUE.id, "not_started");
		// No session was registered — nothing for a runner to attach to.
		expect(
			privates(worker).agentSessionManager.getSession(SESSION_ID),
		).toBeUndefined();
	});

	it("a generic workspace error still rethrows but posts no refusal activity (unchanged behavior)", async () => {
		privates(worker).config.handlers = {
			createWorkspace: vi.fn().mockRejectedValue(new Error("disk full")),
		};

		await expect(callCreateSession()).rejects.toThrow("disk full");
		expect(tracker.createAgentActivity).not.toHaveBeenCalled();
		expect(mirror.close).not.toHaveBeenCalled();
	});

	it("the createWorkspace handler receives the git credential resolver (PON-162)", async () => {
		let received: ((path: string, op: string) => Promise<unknown>) | undefined;
		privates(worker).config.handlers = {
			createWorkspace: vi.fn(
				async (_issue: never, _repos: never, options: never) => {
					received = (options as { resolveGitAuth?: never })?.resolveGitAuth;
					// Abort after capture; the rest of session creation is not
					// under test here.
					throw new Error("STOP_AFTER_CAPTURE");
				},
			),
		};
		const resolverSpy = vi
			.spyOn(privates(worker), "resolveGitAuthForRepoPath" as never)
			.mockResolvedValue(null as never);

		await expect(callCreateSession()).rejects.toThrow("STOP_AFTER_CAPTURE");

		expect(received).toBeTypeOf("function");
		await received?.("/repos/frontdoor-sandbox", "fetch");
		expect(resolverSpy).toHaveBeenCalledWith(
			"/repos/frontdoor-sandbox",
			"fetch",
		);
	});
});
