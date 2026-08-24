import { execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitService, WorktreeCreationRefusedError } from "../src/GitService.js";

/**
 * PON-161 / PON-162, both found live on agent-prod 2026-08-24:
 *
 * - The deliberate stale-fetch refusal was absorbed by the plain-directory
 *   fallback and the session started in an EMPTY worktree. The refusal must
 *   be terminal: a typed error that no fallback catch may swallow.
 * - The session-time fetch ran credential-less because the production path
 *   goes through a GitService with no constructor-wired resolver. A per-call
 *   `resolveGitAuth` now threads through `createGitWorktree`, and applies to
 *   BOTH the fetch and the ls-remote.
 */

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	readdirSync: vi.fn(() => []),
	rmSync: vi.fn(),
	statSync: vi.fn(),
}));

vi.mock("../src/WorktreeIncludeService.js", () => ({
	WorktreeIncludeService: vi.fn().mockImplementation(function () {
		return { copyIgnoredFiles: vi.fn().mockResolvedValue(undefined) };
	}),
}));

const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	event: vi.fn(),
	withContext: vi.fn().mockReturnThis(),
} as never;

const issue = {
	id: "issue-1",
	identifier: "FRO-60",
	title: "t",
	branchName: "cyrus/fro-60",
} as never;

const repository = (overrides: Record<string, unknown> = {}) =>
	({
		id: "repo-1",
		name: "frontdoor-sandbox",
		repositoryPath: "/repos/frontdoor-sandbox",
		workspaceBaseDir: "/workspaces",
		baseBranch: "main",
		...overrides,
	}) as never;

/**
 * Route execSync by command. `remoteExists` controls hasOriginRemote;
 * `fetchFails` makes `git … fetch origin` throw (the private-repo,
 * no-credential shape observed live).
 */
function routeGit(opts: {
	fetchFails?: boolean;
	onCall?: (cmd: string, options: unknown) => void;
}) {
	mockExecSync.mockImplementation(((cmd: unknown, options: unknown) => {
		const cmdStr = String(cmd);
		opts.onCall?.(cmdStr, options);
		if (cmdStr === "git rev-parse --git-dir") return Buffer.from(".git\n");
		if (cmdStr === "git worktree list --porcelain") return "";
		if (cmdStr.includes("git remote get-url origin")) {
			return Buffer.from("https://github.com/acme/frontdoor-sandbox.git\n");
		}
		if (cmdStr.includes("rev-parse --verify")) {
			throw new Error("unknown revision"); // branch does not exist yet
		}
		if (cmdStr.includes("fetch origin")) {
			if (opts.fetchFails) {
				throw new Error(
					"fatal: could not read Username for 'https://github.com': No such device or address",
				);
			}
			return Buffer.from("");
		}
		if (cmdStr.includes("ls-remote --heads origin")) {
			return Buffer.from("abc123\trefs/heads/main\n");
		}
		return Buffer.from("");
	}) as never);
}

function successfulSetupSpawn() {
	mockSpawn.mockImplementation((() => {
		const child = new EventEmitter() as never as Record<string, unknown> & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			emit: (...args: unknown[]) => boolean;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		setImmediate(() => child.emit("close", 0, null));
		return child;
	}) as never);
}

describe("GitService — refusal is terminal (PON-161)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
		successfulSetupSpawn();
	});

	it("a failing fetch rejects with WorktreeCreationRefusedError — never a fallback directory", async () => {
		routeGit({ fetchFails: true });
		const gitService = new GitService({ cyrusHome: "/home/x" }, mockLogger);

		await expect(
			gitService.createGitWorktree(issue, [repository()]),
		).rejects.toBeInstanceOf(WorktreeCreationRefusedError);
		await expect(
			gitService.createGitWorktree(issue, [repository()]),
		).rejects.toMatchObject({ repositoryName: "frontdoor-sandbox" });

		// The observed live failure mode: an empty directory handed back as a
		// workspace. No fallback mkdir may follow the refusal.
		const fallbackDirs = mockMkdirSync.mock.calls.filter((call) =>
			String(call[0]).includes("FRO-60"),
		);
		expect(fallbackDirs).toHaveLength(0);
	});

	it("the multi-repo loop rethrows the refusal instead of swallowing it per repo", async () => {
		routeGit({ fetchFails: true });
		const gitService = new GitService({ cyrusHome: "/home/x" }, mockLogger);

		await expect(
			gitService.createGitWorktree(issue, [
				repository(),
				repository({ id: "repo-2", name: "other-repo" }),
			]),
		).rejects.toBeInstanceOf(WorktreeCreationRefusedError);
	});

	it("a non-refusal worktree failure still falls back to a plain directory (existing behavior)", async () => {
		routeGit({ fetchFails: false });
		// Make the worktree add itself fail with a generic error.
		mockExecSync.mockImplementation(((cmd: unknown) => {
			const cmdStr = String(cmd);
			if (cmdStr === "git rev-parse --git-dir") return Buffer.from(".git\n");
			if (cmdStr === "git worktree list --porcelain") return "";
			if (cmdStr.includes("git remote get-url origin")) {
				return Buffer.from("https://github.com/acme/frontdoor-sandbox.git\n");
			}
			if (cmdStr.includes("rev-parse --verify")) {
				throw new Error("unknown revision");
			}
			if (cmdStr.includes("fetch origin")) return Buffer.from("");
			if (cmdStr.includes("ls-remote --heads origin")) {
				return Buffer.from("abc123\trefs/heads/main\n");
			}
			if (cmdStr.includes("git worktree add")) {
				throw new Error("disk full");
			}
			return Buffer.from("");
		}) as never);
		const gitService = new GitService({ cyrusHome: "/home/x" }, mockLogger);

		const result = await gitService.createGitWorktree(issue, [repository()]);
		expect(result.isGitWorktree).toBe(false);
	});
});

describe("GitService — per-call git auth (PON-162)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
		successfulSetupSpawn();
	});

	const fakeResolver = vi.fn(async (_path: string, _op: string) => ({
		env: { FAKE_GIT_AUTH: "1" },
		args: ["-c", "credential.helper="],
	}));

	it("the per-call resolver's env and args reach BOTH the fetch and the ls-remote", async () => {
		const seen: Array<{ cmd: string; env?: Record<string, string> }> = [];
		routeGit({
			onCall: (cmd, options) =>
				seen.push({
					cmd,
					env: (options as { env?: Record<string, string> })?.env,
				}),
		});
		const gitService = new GitService({ cyrusHome: "/home/x" }, mockLogger);

		await gitService.createGitWorktree(issue, [repository()], {
			resolveGitAuth: fakeResolver as never,
		});

		const fetchCall = seen.find((c) => c.cmd.includes("fetch origin"));
		expect(fetchCall).toBeDefined();
		expect(fetchCall?.cmd).toContain("credential.helper=");
		expect(fetchCall?.env?.FAKE_GIT_AUTH).toBe("1");

		const lsRemoteCall = seen.find((c) =>
			c.cmd.includes("ls-remote --heads origin"),
		);
		expect(lsRemoteCall).toBeDefined();
		expect(lsRemoteCall?.cmd).toContain("credential.helper=");
		expect(lsRemoteCall?.env?.FAKE_GIT_AUTH).toBe("1");

		expect(fakeResolver).toHaveBeenCalledWith(
			"/repos/frontdoor-sandbox",
			"fetch",
		);
		expect(fakeResolver).toHaveBeenCalledWith(
			"/repos/frontdoor-sandbox",
			"ls-remote",
		);
	});

	it("falls back to the constructor-wired resolver when no per-call one is given", async () => {
		const seen: Array<{ cmd: string; env?: Record<string, string> }> = [];
		routeGit({
			onCall: (cmd, options) =>
				seen.push({
					cmd,
					env: (options as { env?: Record<string, string> })?.env,
				}),
		});
		const gitService = new GitService(
			{ cyrusHome: "/home/x", resolveGitAuth: fakeResolver as never },
			mockLogger,
		);

		await gitService.createGitWorktree(issue, [repository()]);

		const fetchCall = seen.find((c) => c.cmd.includes("fetch origin"));
		expect(fetchCall?.env?.FAKE_GIT_AUTH).toBe("1");
	});

	it("no resolver anywhere: git runs bare, exactly as before", async () => {
		const seen: Array<{ cmd: string; env?: Record<string, string> }> = [];
		routeGit({
			onCall: (cmd, options) =>
				seen.push({
					cmd,
					env: (options as { env?: Record<string, string> })?.env,
				}),
		});
		const gitService = new GitService({ cyrusHome: "/home/x" }, mockLogger);

		await gitService.createGitWorktree(issue, [repository()]);

		const fetchCall = seen.find((c) => c.cmd.includes("fetch origin"));
		expect(fetchCall).toBeDefined();
		expect(fetchCall?.env?.FAKE_GIT_AUTH).toBeUndefined();
	});
});
