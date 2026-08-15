import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
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

/**
 * PON-115 acceptance: two workspaces served by one instance must never see
 * each other's tokens, repositories, filesystem paths, or queue state.
 *
 * Both tenants deliberately use the SAME issue identifier (ENG-1) — the
 * collision that identifier-keyed paths could not survive.
 */
describe("EdgeWorker multi-tenant isolation (PON-115)", () => {
	const WS_A = "workspace-aaaa";
	const WS_B = "workspace-bbbb";

	const repoA: RepositoryConfig = {
		id: "repo-a",
		name: "tenant-a-api",
		repositoryPath: "/repos/tenant-a-api",
		workspaceBaseDir: "/worktrees",
		baseBranch: "main",
		linearWorkspaceId: WS_A,
		isActive: true,
		teamKeys: ["ENG"],
		labelPrompts: {},
	};

	const repoB: RepositoryConfig = {
		id: "repo-b",
		name: "tenant-b-api",
		repositoryPath: "/repos/tenant-b-api",
		workspaceBaseDir: "/worktrees",
		baseBranch: "main",
		linearWorkspaceId: WS_B,
		isActive: true,
		teamKeys: ["ENG"],
		labelPrompts: {},
	};

	let edgeWorker: EdgeWorker;
	let trackerA: any;
	let trackerB: any;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		vi.mocked(createCyrusToolsServer).mockImplementation(
			() => ({ server: {} }) as any,
		);
		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				startStreaming: vi.fn().mockResolvedValue({ sessionId: "c1" }),
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return {
				hasAgentRunner: vi.fn().mockReturnValue(false),
				getSession: vi.fn().mockReturnValue(null),
				getSessionsByIssueId: vi.fn().mockReturnValue([]),
				getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
				createResponseActivity: vi.fn().mockResolvedValue(undefined),
				requestSessionStop: vi.fn(),
				removeSession: vi.fn(),
				setActivitySink: vi.fn(),
				serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
				restoreState: vi.fn(),
				on: vi.fn(),
			};
		} as any);
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi
					.fn()
					.mockReturnValue({ post: vi.fn(), get: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
		} as any);
		vi.mocked(LinearClient).mockImplementation(function () {
			return { users: { me: vi.fn().mockResolvedValue({ id: "u" }) } };
		} as any);

		const config: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repoA, repoB],
			linearWorkspaces: {
				[WS_A]: { linearToken: "token-AAA" },
				[WS_B]: { linearToken: "token-BBB" },
			},
		};

		edgeWorker = new EdgeWorker(config);
		(edgeWorker as any).repositories.set(repoA.id, repoA);
		(edgeWorker as any).repositories.set(repoB.id, repoB);

		const makeTracker = (label: string) => ({
			label,
			getClient: vi.fn().mockReturnValue({}),
			fetchIssue: vi.fn().mockResolvedValue({
				id: `issue-${label}`,
				identifier: "ENG-1",
				title: "Same identifier in both tenants",
			}),
			fetchComment: vi.fn().mockResolvedValue(null),
			createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
		});
		trackerA = makeTracker("A");
		trackerB = makeTracker("B");
		(edgeWorker as any).issueTrackers.set(WS_A, trackerA);
		(edgeWorker as any).issueTrackers.set(WS_B, trackerB);
	});

	afterEach(() => vi.restoreAllMocks());

	it("hands each tenant only its own token", () => {
		const get = (ws: string) =>
			(edgeWorker as any).getLinearTokenForWorkspace(ws);

		expect(get(WS_A)).toBe("token-AAA");
		expect(get(WS_B)).toBe("token-BBB");
		// An unknown tenant gets nothing — never another tenant's token.
		expect(get("workspace-unknown")).toBeNull();
	});

	it("routes an identically-identified issue to each tenant's own repo", async () => {
		const router = (edgeWorker as any).repositoryRouter;

		const forWorkspace = async (ws: string) =>
			router.determineRepositoryForWebhook(
				{
					type: "AgentSessionEvent",
					action: "created",
					organizationId: ws,
					agentSession: {
						id: `s-${ws}`,
						issue: {
							id: `issue-${ws}`,
							identifier: "ENG-1",
							team: { key: "ENG" },
						},
					},
				},
				[repoA, repoB],
			);

		const a = await forWorkspace(WS_A);
		const b = await forWorkspace(WS_B);

		expect(a.repositories.map((r: RepositoryConfig) => r.id)).toEqual([
			"repo-a",
		]);
		expect(b.repositories.map((r: RepositoryConfig) => r.id)).toEqual([
			"repo-b",
		]);
	});

	it("gives the two tenants different worktree paths for the same identifier", async () => {
		const gitService = (edgeWorker as any).gitService;
		const pathA = gitService.tenantScopedBaseDir("/worktrees", repoA);
		const pathB = gitService.tenantScopedBaseDir("/worktrees", repoB);

		expect(pathA).not.toBe(pathB);
		expect(pathA).toContain(WS_A);
		expect(pathB).toContain(WS_B);
	});

	it("resolves each session's tenant for logging independently", () => {
		(edgeWorker as any).sessionRepositories.set("s-a", "repo-a");
		(edgeWorker as any).sessionRepositories.set("s-b", "repo-b");

		expect((edgeWorker as any).resolveWorkspaceIdForSession("s-a")).toBe(WS_A);
		expect((edgeWorker as any).resolveWorkspaceIdForSession("s-b")).toBe(WS_B);
		expect(
			(edgeWorker as any).resolveWorkspaceIdForSession("s-unknown"),
		).toBeUndefined();
	});

	it("accepts webhooks from both configured tenants and drops unknown ones", () => {
		const known = (ws: string | undefined) =>
			(edgeWorker as any).isKnownWorkspace(ws);

		expect(known(WS_A)).toBe(true);
		expect(known(WS_B)).toBe(true);
		expect(known("workspace-uninvited")).toBe(false);
		expect(known(undefined)).toBe(false);
	});

	it("keeps lane state per tenant, so one tenant's queue cannot block another", () => {
		const lanes = (edgeWorker as any).laneManager;

		expect(lanes.acquire(WS_A, "s-a1")).toBe(true);
		// Tenant B's lane is unaffected by A holding its own.
		expect(lanes.acquire(WS_B, "s-b1")).toBe(true);
		// A second session in A queues; B stays free.
		expect(lanes.acquire(WS_A, "s-a2")).toBe(false);
		expect(lanes.queueLength(WS_B)).toBe(0);

		lanes.release(WS_A, "s-a1");
		expect(lanes.activeSessionOf(WS_B)).toBe("s-b1");
	});

	it("keeps the issue-update dedupe cache per tenant (no noisy-neighbour eviction)", () => {
		const worker = edgeWorker as any;

		// One busy tenant floods the cache well past the per-tenant limit.
		for (let i = 0; i < 400; i++) {
			worker.processedIssueUpdateKeys.add(`${WS_A}:t${i}:issue-${i}`);
			worker.pruneProcessedIssueUpdateKeys();
		}
		// A quiet tenant records a single key.
		worker.processedIssueUpdateKeys.add(`${WS_B}:t0:issue-quiet`);
		worker.pruneProcessedIssueUpdateKeys();

		// The quiet tenant's dedupe history survives the noisy one entirely.
		expect(worker.processedIssueUpdateKeys.has(`${WS_B}:t0:issue-quiet`)).toBe(
			true,
		);
		// And the busy tenant is still bounded.
		const tenantAKeys = [...worker.processedIssueUpdateKeys].filter(
			(k: string) => k.startsWith(WS_A),
		);
		expect(tenantAKeys.length).toBeLessThanOrEqual(250);
	});

	it("posts activities through the tenant's own tracker", async () => {
		const poster = (edgeWorker as any).activityPoster;

		await poster.postThoughtActivity("s-a", WS_A, "hello A");
		await poster.postThoughtActivity("s-b", WS_B, "hello B");

		expect(trackerA.createAgentActivity).toHaveBeenCalledTimes(1);
		expect(trackerB.createAgentActivity).toHaveBeenCalledTimes(1);
		expect(trackerA.createAgentActivity.mock.calls[0][0].content.body).toBe(
			"hello A",
		);
		expect(trackerB.createAgentActivity.mock.calls[0][0].content.body).toBe(
			"hello B",
		);
	});
});
