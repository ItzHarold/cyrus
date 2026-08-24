import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("EdgeWorker - resume validates the worktree (PON-164)", () => {
	let worker: EdgeWorker;
	let asm: Record<string, any>;

	const repository = {
		id: "repo-1",
		name: "frontdoor-sandbox",
		repositoryPath: "/repos/frontdoor-sandbox",
		workspaceBaseDir: "/workspaces",
		baseBranch: "main",
		linearWorkspaceId: WS,
	} as never;

	const realCheckout = () => {
		const dir = mkdtempSync(join(tmpdir(), "pon164-ws-"));
		mkdirSync(join(dir, ".git"));
		return dir;
	};

	const registerSessionAt = (
		path: string,
		isGitWorktree = true,
		contexts: Array<{
			repositoryId: string;
			branchName?: string;
			baseBranchName?: string;
		}> = [],
	) => {
		asm.createCyrusAgentSession(
			SESSION_ID,
			ISSUE.id,
			{
				id: ISSUE.id,
				identifier: ISSUE.identifier,
				title: "t",
				description: "d",
				branchName: "b",
			},
			{ path, isGitWorktree },
			"linear",
			contexts,
		);
		return asm.getSession(SESSION_ID);
	};

	let capturedBuilderCalls: number;
	const stubResumeCollaborators = () => {
		capturedBuilderCalls = 0;
		privates(worker).fetchFullIssueDetails = vi
			.fn()
			.mockResolvedValue({ id: ISSUE.id, identifier: ISSUE.identifier });
		privates(worker).fetchIssueLabels = vi.fn().mockResolvedValue([]);
		privates(worker).determineSystemPromptFromLabels = vi
			.fn()
			.mockResolvedValue(undefined);
		privates(worker).gitService = {
			getGitMetadataDirectoriesForWorkspace: () => [],
		};
		privates(worker).cyrusHome = mkdtempSync(
			join(tmpdir(), "pon164-cyrus-home-"),
		);
		privates(worker).savePersistedState = vi.fn().mockResolvedValue(undefined);
		privates(worker).buildAgentRunnerConfig = vi.fn(async () => {
			capturedBuilderCalls++;
			throw new Error("STOP_AFTER_CAPTURE");
		});
	};

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
		privates(worker).config.linearWorkspaces = { [WS]: { linearToken: "t" } };
		asm = privates(worker).agentSessionManager;
		stubResumeCollaborators();
	});

	const resume = (session: unknown) =>
		worker.resumeAgentSession(
			session as never,
			repository,
			SESSION_ID,
			asm as never,
			"continue please",
			"",
			false,
			[],
			WS,
		);

	it("a valid checkout resumes untouched — no re-creation", async () => {
		const session = registerSessionAt(realCheckout());
		const handler = vi.fn();
		privates(worker).config.handlers = { createWorkspace: handler };

		await expect(resume(session)).rejects.toThrow("STOP_AFTER_CAPTURE");

		expect(handler).not.toHaveBeenCalled();
		expect(capturedBuilderCalls).toBe(1);
	});

	it("a missing workspace is re-created through the authenticated handler before the runner starts", async () => {
		const session = registerSessionAt("/nonexistent/path/gone");
		const fresh = realCheckout();
		const handler = vi.fn(async (_i: never, _r: never, options: never) => {
			// The re-creation must carry the PON-162 credential resolver.
			expect(
				(options as { resolveGitAuth?: unknown })?.resolveGitAuth,
			).toBeTypeOf("function");
			return { path: fresh, isGitWorktree: true };
		});
		privates(worker).config.handlers = { createWorkspace: handler };

		await expect(resume(session)).rejects.toThrow("STOP_AFTER_CAPTURE");

		expect(handler).toHaveBeenCalledTimes(1);
		expect(session.workspace.path).toBe(fresh);
		expect(session.workspace.isGitWorktree).toBe(true);
		expect(capturedBuilderCalls).toBe(1);
	});

	it("the pre-fix empty-directory fallback (isGitWorktree=false) is treated as invalid", async () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "pon164-empty-"));
		const session = registerSessionAt(emptyDir, false);
		const fresh = realCheckout();
		const handler = vi
			.fn()
			.mockResolvedValue({ path: fresh, isGitWorktree: true });
		privates(worker).config.handlers = { createWorkspace: handler };

		await expect(resume(session)).rejects.toThrow("STOP_AFTER_CAPTURE");

		expect(handler).toHaveBeenCalledTimes(1);
		expect(session.workspace.path).toBe(fresh);
	});

	it("a refused re-creation is terminal on resume: error activity, lane path, no runner", async () => {
		const session = registerSessionAt("/nonexistent/path/gone");
		privates(worker).config.handlers = {
			createWorkspace: vi
				.fn()
				.mockRejectedValue(
					new WorktreeCreationRefusedError("fetch failed", "frontdoor-sandbox"),
				),
		};
		const errorActivity = vi
			.spyOn(asm, "createErrorActivity")
			.mockResolvedValue(undefined);
		const laneEnd = vi.spyOn(
			privates(worker),
			"handleLaneSessionEnded" as never,
		);

		await expect(resume(session)).resolves.toBeUndefined();

		expect(errorActivity).toHaveBeenCalledWith(
			SESSION_ID,
			expect.stringContaining("frontdoor-sandbox"),
		);
		expect(laneEnd).toHaveBeenCalledWith(SESSION_ID, "not_started");
		expect(capturedBuilderCalls).toBe(0);
	});

	it("a multi-repo session is re-created with its FULL repository set and recorded base branches", async () => {
		const secondRepo = {
			id: "repo-2",
			name: "other-repo",
			repositoryPath: "/repos/other-repo",
			workspaceBaseDir: "/workspaces",
			baseBranch: "develop",
			linearWorkspaceId: WS,
		} as never;
		privates(worker).repositories.set("repo-1", repository);
		privates(worker).repositories.set("repo-2", secondRepo);
		const session = registerSessionAt("/nonexistent/path/gone", true, [
			{ repositoryId: "repo-1", baseBranchName: "main" },
			{ repositoryId: "repo-2", baseBranchName: "release/1.2" },
		]);
		const parent = realCheckout();
		const sub1 = realCheckout();
		const sub2 = realCheckout();
		let receivedRepos: unknown[] = [];
		let receivedOverrides: Map<string, string> | undefined;
		privates(worker).config.handlers = {
			createWorkspace: vi.fn(
				async (_i: never, repos: never[], options: never) => {
					receivedRepos = repos;
					receivedOverrides = (
						options as { baseBranchOverrides?: Map<string, string> }
					)?.baseBranchOverrides;
					return {
						path: parent,
						isGitWorktree: true,
						repoPaths: { "repo-1": sub1, "repo-2": sub2 },
					};
				},
			),
		};

		await expect(resume(session)).rejects.toThrow("STOP_AFTER_CAPTURE");

		expect(receivedRepos.map((r) => (r as { id: string }).id)).toEqual([
			"repo-1",
			"repo-2",
		]);
		expect(receivedOverrides?.get("repo-2")).toBe("release/1.2");
		expect(session.workspace.repoPaths).toEqual({
			"repo-1": sub1,
			"repo-2": sub2,
		});
	});

	it("a re-creation that yields no real checkout is terminal, never trusted", async () => {
		const session = registerSessionAt("/nonexistent/path/gone");
		// The generic fallbacks can hand back an empty directory or a stale
		// deleted path — the resume must re-validate and refuse.
		privates(worker).config.handlers = {
			createWorkspace: vi
				.fn()
				.mockResolvedValue({ path: "/still/not/there", isGitWorktree: true }),
		};
		const errorActivity = vi
			.spyOn(asm, "createErrorActivity")
			.mockResolvedValue(undefined);
		const laneEnd = vi.spyOn(
			privates(worker),
			"handleLaneSessionEnded" as never,
		);

		await expect(resume(session)).resolves.toBeUndefined();

		expect(errorActivity).toHaveBeenCalledWith(
			SESSION_ID,
			expect.stringContaining("could not be prepared"),
		);
		expect(laneEnd).toHaveBeenCalledWith(SESSION_ID, "not_started");
		expect(capturedBuilderCalls).toBe(0);
	});

	it("a non-refusal re-creation failure propagates (unchanged error behavior)", async () => {
		const session = registerSessionAt("/nonexistent/path/gone");
		privates(worker).config.handlers = {
			createWorkspace: vi.fn().mockRejectedValue(new Error("disk full")),
		};

		await expect(resume(session)).rejects.toThrow("disk full");
		expect(capturedBuilderCalls).toBe(0);
	});
});
