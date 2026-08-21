import { WorkspaceAuthNotDeclaredError } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

/**
 * Runtime wiring of per-workspace Anthropic auth (PON-139).
 *
 * These tests exist because the resolver, the schema, and 12 unit tests for
 * `resolveWorkspaceAuthEnv` all shipped in PR #15 — and none of it was called
 * at session start. Every session kept running on the box's ambient
 * credential, and the documented refusal did not exist. Unit tests on the
 * resolver could not have caught that, because the defect was the absence of
 * a call, not the behaviour of the function. So this file tests the seam
 * itself: what `buildAgentRunnerConfig` actually puts into a session's env.
 */

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(function () {
		return {
			initializeFastify: vi.fn(),
			getFastifyInstance: vi
				.fn()
				.mockReturnValue({ get: vi.fn(), post: vi.fn() }),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
		};
	}),
}));
vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(function () {
		return {
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			getAllSessions: vi.fn().mockReturnValue([]),
			getSession: vi.fn(),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createErrorActivity: vi.fn().mockResolvedValue(undefined),
			setActivitySink: vi.fn(),
			on: vi.fn(),
			emit: vi.fn(),
		};
	}),
}));
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as object;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

const SANDBOX_KEY = "sk-ant-api03-sandbox-workspace-key";
const BOX_TOKEN = "sk-ant-oat-box-subscription-token";

const KEYED_WS = "keyed-workspace-id";
const SUB_WS = "subscription-workspace-id";
const UNDECLARED_WS = "undeclared-workspace-id";

const repo = (linearWorkspaceId?: string): RepositoryConfig => ({
	id: "repo-1",
	name: "Repo One",
	repositoryPath: "/test/repo",
	workspaceBaseDir: "/test/workspaces",
	baseBranch: "main",
	...(linearWorkspaceId ? { linearWorkspaceId } : {}),
	isActive: true,
});

const mockConfig: EdgeWorkerConfig = {
	platform: "linear",
	cyrusHome: "/test/.cyrus",
	repositories: [repo(KEYED_WS)],
	linearWorkspaces: {
		[KEYED_WS]: {
			linearToken: "lin-token-a",
			linearWorkspaceName: "FrontDoor Sandbox",
			anthropicAuth: { mode: "apiKey", apiKey: SANDBOX_KEY },
		},
		[SUB_WS]: {
			linearToken: "lin-token-b",
			linearWorkspaceName: "Ponte Digital",
			anthropicAuth: { mode: "subscription" },
		},
		[UNDECLARED_WS]: {
			linearToken: "lin-token-c",
			linearWorkspaceName: "Never Configured",
		},
	},
};

describe("EdgeWorker - per-workspace auth wiring (PON-139)", () => {
	let edgeWorker: EdgeWorker;
	let builtConfig: Record<string, unknown>;
	let runnerType: string;
	let capturedBuilderInput: Record<string, unknown> | undefined;

	const session = {
		issueContext: {
			trackerId: "linear",
			issueIdentifier: "FRO-1",
		},
		workspace: { path: "/test/workspaces/FRO-1" },
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		process.env.CLAUDE_CODE_OAUTH_TOKEN = BOX_TOKEN;
		delete process.env.CYRUS_ENABLE_WARM_SESSIONS;

		edgeWorker = new EdgeWorker(mockConfig);

		// Stub the heavy collaborators on the instance. The unit under test is
		// buildAgentRunnerConfig's own wiring, not skill discovery or the config
		// builder's internals — the builder returns a bare config we can inspect.
		builtConfig = {};
		runnerType = "claude";
		capturedBuilderInput = undefined;
		(edgeWorker as never as Record<string, unknown>).skillsPluginResolver = {
			resolve: vi.fn().mockResolvedValue([]),
			discoverSkillNames: vi.fn().mockResolvedValue([]),
		};
		(edgeWorker as never as Record<string, unknown>).runnerConfigBuilder = {
			buildIssueConfig: vi.fn((input: Record<string, unknown>) => {
				capturedBuilderInput = input;
				return { config: builtConfig, runnerType };
			}),
		};
	});

	afterEach(() => {
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.CYRUS_ENABLE_WARM_SESSIONS;
	});

	const build = (repository: RepositoryConfig, linearWorkspaceId?: string) =>
		(
			edgeWorker as never as {
				buildAgentRunnerConfig: (
					...args: unknown[]
				) => Promise<{ config: Record<string, unknown>; runnerType: string }>;
			}
		).buildAgentRunnerConfig(
			session,
			repository,
			"session-1",
			undefined, // systemPrompt
			[], // allowedTools
			[], // allowedDirectories
			[], // disallowedTools
			undefined, // resumeSessionId
			[], // labels
			undefined, // issueDescription
			undefined, // maxTurns
			linearWorkspaceId,
			{ repositoryId: repository.id, repoPaths: [] }, // skillContext
		);

	it("a keyed workspace's session gets its key, and the box token is UNSET", async () => {
		const { config } = await build(repo(KEYED_WS));
		const env = config.additionalEnv as Record<string, string | undefined>;

		expect(env.ANTHROPIC_API_KEY).toBe(SANDBOX_KEY);
		// Present-as-undefined: the box token would otherwise be inherited by
		// every child, and SDK precedence would decide what the tenant ran on.
		expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(true);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(true);
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	it("a subscription workspace's session gets the box token, key unset", async () => {
		const { config } = await build(repo(SUB_WS));
		const env = config.additionalEnv as Record<string, string | undefined>;

		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(BOX_TOKEN);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("an undeclared workspace REFUSES to build, naming the workspace", async () => {
		// This is the assertion that was false before this PR: the refusal now
		// actually exists at runtime, not only in the CLI check.
		await expect(build(repo(UNDECLARED_WS))).rejects.toBeInstanceOf(
			WorkspaceAuthNotDeclaredError,
		);
		await expect(build(repo(UNDECLARED_WS))).rejects.toThrow(
			/Never Configured/,
		);
	});

	it("the refusal posts a VISIBLE error activity before throwing", async () => {
		// Every entry path acks before reaching the build, and every one
		// swallows this throw after journaling. Without a posted activity the
		// client sees "Got it" then permanent silence — and a serialized lane
		// drains its whole queue through the same silence. The refusal is only
		// a refusal if the tenant can see it.
		const asm = (
			edgeWorker as never as {
				agentSessionManager: { createErrorActivity: ReturnType<typeof vi.fn> };
			}
		).agentSessionManager;

		await expect(build(repo(UNDECLARED_WS))).rejects.toThrow();

		expect(asm.createErrorActivity).toHaveBeenCalledTimes(1);
		const [postedSessionId, body] = asm.createErrorActivity.mock.calls[0] as [
			string,
			string,
		];
		expect(postedSessionId).toBe("session-1");
		expect(body).toMatch(/not configured to run sessions/);
		// The client-facing text names no credential, no key, no env var value.
		expect(body).not.toContain("sk-ant");
	});

	it("the explicit linearWorkspaceId parameter wins over the repository's", async () => {
		// Multi-workspace routing passes the routed workspace explicitly; the
		// repository's own field is the fallback, not the authority.
		const { config } = await build(repo(KEYED_WS), SUB_WS);
		const env = config.additionalEnv as Record<string, string | undefined>;

		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(BOX_TOKEN);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("a session with no Linear workspace runs ambient and does not throw", async () => {
		// Non-Linear platforms have no tenant to attribute to. The legacy
		// ambient tier applies — the same explicitly-named residual as
		// GITHUB_TOKEN, logged rather than silent.
		const { config } = await build(repo(undefined));

		expect(config.additionalEnv).toBeUndefined();
	});

	it("a non-claude runner is left alone, even for an undeclared workspace", async () => {
		// The declaration is Anthropic-specific. A gemini session in an
		// undeclared workspace must not be refused over a credential it would
		// never read.
		runnerType = "gemini";
		const { config } = await build(repo(UNDECLARED_WS));

		expect(config.additionalEnv).toBeUndefined();
	});

	describe("lane release timing wiring (PON-154)", () => {
		it("wires onComplete so the lane releases when the stream ACTUALLY ends", async () => {
			// The other half of the PON-154 fix: completeSession defers its release
			// while the runner streams, so something must fire at true stream end.
			// This asserts the built runner config carries that trigger and that
			// invoking it releases this session's lane slot.
			const lm = (
				edgeWorker as never as {
					laneManager: {
						acquire: (ws: string, s: string) => boolean;
						isActive: (s: string) => boolean;
					};
				}
			).laneManager;
			lm.acquire(SUB_WS, "session-1");
			expect(lm.isActive("session-1")).toBe(true);

			await build(repo(SUB_WS));

			const onComplete = capturedBuilderInput?.onComplete as
				| (() => void)
				| undefined;
			expect(typeof onComplete).toBe("function");

			onComplete?.();
			expect(lm.isActive("session-1")).toBe(false);
		});
	});

	describe("warm-session attach guard (proof, not assumption)", () => {
		// The first guard skipped attach only for apiKey mode, on the claim that
		// subscription "matches the ambient credential by construction". The
		// adversarial review refuted it: a warm subprocess's env is fixed at
		// spawn with ALL ambient auth vars forwarded, and nothing enforces the
		// subscription token being the only one. Attach now requires the auth
		// env resolved for this session to deep-equal the env the subprocess was
		// spawned with. Mismatch costs a cold start; a wrong-tenant bill is not
		// a latency trade.
		beforeEach(() => {
			process.env.CYRUS_ENABLE_WARM_SESSIONS = "true";
		});

		const setWarm = (authEnv: Record<string, string | undefined> | undefined) =>
			(
				edgeWorker as never as {
					warmInstances: Map<string, { query: unknown; authEnv: unknown }>;
				}
			).warmInstances.set("session-1", { query: { warm: true }, authEnv });

		it("attaches when the spawn-time auth env deep-equals the session's", async () => {
			setWarm({
				ANTHROPIC_API_KEY: undefined,
				CLAUDE_CODE_OAUTH_TOKEN: BOX_TOKEN,
				ANTHROPIC_AUTH_TOKEN: undefined,
			});
			const { config } = await build(repo(SUB_WS));
			expect(config.warmSession).toEqual({ warm: true });
		});

		it("refuses an ambient-spawned warm session even for subscription mode, and reaps it", async () => {
			// The exact case the review found: authEnv undefined means the child
			// was spawned on raw ambient env, which may hold several credentials.
			// Subscription mode is no longer taken on faith. And a refused entry
			// is CLOSED and removed — there is no pool sweep, so leaving it would
			// park a live subprocess holding the wrong credentials forever.
			const close = vi.fn();
			(
				edgeWorker as never as {
					warmInstances: Map<string, { query: unknown; authEnv: unknown }>;
				}
			).warmInstances.set("session-1", {
				query: { warm: true, close },
				authEnv: undefined,
			});

			const { config } = await build(repo(SUB_WS));

			expect(config.warmSession).toBeUndefined();
			expect(close).toHaveBeenCalledTimes(1);
			expect(
				(edgeWorker as never as { warmInstances: Map<string, unknown> })
					.warmInstances.size,
			).toBe(0);
		});

		it("refuses a warm session whose spawn env held a different credential", async () => {
			setWarm({
				ANTHROPIC_API_KEY: "sk-ant-api03-some-OTHER-key",
				CLAUDE_CODE_OAUTH_TOKEN: undefined,
				ANTHROPIC_AUTH_TOKEN: undefined,
			});
			const { config } = await build(repo(KEYED_WS));
			expect(config.warmSession).toBeUndefined();
		});

		it("attaches a keyed session to a warm child spawned with that same key", async () => {
			// Warm spawn now resolves per workspace, so this pairing is the normal
			// case after a restart — and it is allowed precisely because it is
			// proven, not because of what mode it is.
			setWarm({
				ANTHROPIC_API_KEY: SANDBOX_KEY,
				CLAUDE_CODE_OAUTH_TOKEN: undefined,
				ANTHROPIC_AUTH_TOKEN: undefined,
			});
			const { config } = await build(repo(KEYED_WS));
			expect(config.warmSession).toEqual({ warm: true });
		});
	});
});
