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
 * Tests for PON-111: Instant session acknowledgment.
 *
 * Linear marks a session unresponsive when no activity arrives within 10
 * seconds of the `created` webhook. The acknowledgment thought must therefore
 * be posted BEFORE repository routing, blocked-by checks, and any repo work
 * (worktree creation, dependency install, model startup) — all of which can
 * be slow or hit the Linear API.
 */
describe("EdgeWorker - Instant session acknowledgment (PON-111)", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;
	let callOrder: string[];

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {},
		teamKeys: ["TEST"],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		callOrder = [];

		vi.mocked(createCyrusToolsServer).mockImplementation(() => {
			return { server: {} } as any;
		});

		vi.mocked(ClaudeRunner).mockImplementation(function () {
			return {
				supportsStreamingInput: true,
				startStreaming: vi
					.fn()
					.mockResolvedValue({ sessionId: "claude-session-123" }),
				stop: vi.fn(),
				isStreaming: vi.fn().mockReturnValue(false),
				isRunning: vi.fn().mockReturnValue(false),
			};
		} as any);

		mockAgentSessionManager = {
			hasAgentRunner: vi.fn().mockReturnValue(false),
			getSession: vi.fn().mockReturnValue(null),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			createResponseActivity: vi.fn().mockResolvedValue(undefined),
			requestSessionStop: vi.fn(),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: {
					me: vi.fn().mockResolvedValue({ id: "user-123", name: "Test User" }),
				},
			};
		} as any);

		const mockConfig: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": {
					linearToken: "test-token",
					// PON-139: sessions refuse to start for an undeclared workspace, so
					// every fixture that builds one must declare. apiKey rather than
					// subscription: self-contained, no hidden env-var dependency.
					anthropicAuth: { mode: "apiKey" as const, apiKey: "sk-ant-test" },
				},
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
		(edgeWorker as any).issueTrackers.set("test-workspace", {
			getClient: vi.fn().mockReturnValue({}),
			fetchIssue: vi.fn().mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
			}),
			fetchComment: vi.fn().mockResolvedValue(null),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function trackAck() {
		vi.spyOn(edgeWorker as any, "postInstantAcknowledgment").mockImplementation(
			async () => {
				callOrder.push("ack");
			},
		);
		vi.spyOn(
			edgeWorker as any,
			"postInstantPromptedAcknowledgment",
		).mockImplementation(async () => {
			callOrder.push("ack");
		});
	}

	function createdWebhook() {
		return {
			type: "AgentSessionEvent",
			action: "created",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			agentSession: {
				id: "agent-session-123",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
					team: { id: "team-1", key: "TEST", name: "Test Team" },
				},
			},
		};
	}

	function promptedWebhook() {
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			createdAt: new Date().toISOString(),
			organizationId: "test-workspace",
			agentSession: {
				id: "agent-session-123",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
					team: { id: "team-1", key: "TEST", name: "Test Team" },
				},
			},
			agentActivity: {
				id: "activity-1",
				content: { type: "prompt", body: "please continue" },
			},
		};
	}

	it("posts the created acknowledgment before repository routing", async () => {
		trackAck();

		const router = (edgeWorker as any).repositoryRouter;
		vi.spyOn(router, "determineRepositoryForWebhook").mockImplementation(
			async () => {
				callOrder.push("routing");
				return { type: "none" };
			},
		);

		await (edgeWorker as any).handleWebhook(createdWebhook(), [mockRepository]);

		expect(callOrder).toEqual(["ack", "routing"]);
	});

	it("posts the created acknowledgment before blocked-by checks and session creation", async () => {
		trackAck();

		const router = (edgeWorker as any).repositoryRouter;
		vi.spyOn(router, "determineRepositoryForWebhook").mockResolvedValue({
			type: "selected",
			repositories: [mockRepository],
			routingMethod: "team-based",
		});
		vi.spyOn(
			edgeWorker as any,
			"checkBlockedByDependencies",
		).mockImplementation(async () => {
			callOrder.push("blocked-check");
			return { blocked: false, blockingIssueIds: [], blockingIdentifiers: [] };
		});
		vi.spyOn(edgeWorker as any, "initializeAgentRunner").mockImplementation(
			async () => {
				callOrder.push("runner-init");
			},
		);

		await (edgeWorker as any).handleWebhook(createdWebhook(), [mockRepository]);

		expect(callOrder).toEqual(["ack", "blocked-check", "runner-init"]);
	});

	it("posts the prompted acknowledgment before repository resolution", async () => {
		trackAck();

		// No cached repository — forces the fallback routing path, which must
		// come AFTER the acknowledgment.
		const router = (edgeWorker as any).repositoryRouter;
		vi.spyOn(router, "determineRepositoryForWebhook").mockImplementation(
			async () => {
				callOrder.push("routing");
				return { type: "none" };
			},
		);

		await (edgeWorker as any).handleWebhook(promptedWebhook(), [
			mockRepository,
		]);

		expect(callOrder[0]).toBe("ack");
		expect(callOrder).toContain("routing");
	});

	it("does not post a generic acknowledgment for stop signals", async () => {
		trackAck();
		vi.spyOn(edgeWorker as any, "handleStopSignal").mockImplementation(
			async () => {
				callOrder.push("stop");
			},
		);

		const webhook = promptedWebhook();
		webhook.agentActivity.content.body = "stop";

		await (edgeWorker as any).handleWebhook(webhook, [mockRepository]);

		expect(callOrder).toEqual(["stop"]);
	});
});
