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
 * Tests for PON-112: per-workspace serialized lanes.
 *
 * The lane admits one active session per opted-in workspace; the rest queue
 * FIFO, get position acks, can be reordered by prompt, and start
 * automatically when the lane frees up on every end path (completion,
 * failure, stop, unassign).
 */
describe("EdgeWorker - Serialized lanes (PON-112)", () => {
	let edgeWorker: EdgeWorker;
	let mockAgentSessionManager: any;
	let sessionsWithRunners: Set<string>;

	const LANE_WS = "lane-workspace";
	const FREE_WS = "free-workspace";

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: LANE_WS,
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {},
		teamKeys: ["TEST"],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		sessionsWithRunners = new Set();

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
			// Sessions that "started" report an agentRunner so the lane
			// backstop sees them as running.
			getSession: vi.fn((sessionId: string) =>
				sessionsWithRunners.has(sessionId)
					? {
							id: sessionId,
							agentRunner: { isRunning: () => true, stop: vi.fn() },
						}
					: null,
			),
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

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({
					post: vi.fn(),
					get: vi.fn(),
				}),
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
				[LANE_WS]: { linearToken: "test-token", laneSerialization: true },
				[FREE_WS]: { linearToken: "test-token-2" },
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).repositories.set("test-repo", mockRepository);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
		for (const ws of [LANE_WS, FREE_WS]) {
			(edgeWorker as any).issueTrackers.set(ws, {
				getClient: vi.fn().mockReturnValue({}),
				fetchIssue: vi.fn().mockResolvedValue({
					id: "issue-123",
					identifier: "TEST-123",
					title: "Test Issue",
				}),
				fetchComment: vi.fn().mockResolvedValue(null),
			});
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createdWebhook(sessionId: string, workspaceId = LANE_WS) {
		return {
			type: "AgentSessionEvent",
			action: "created",
			createdAt: new Date().toISOString(),
			organizationId: workspaceId,
			agentSession: {
				id: sessionId,
				issue: {
					id: `issue-${sessionId}`,
					identifier: `TEST-${sessionId}`,
					title: "Test Issue",
					team: { id: "team-1", key: "TEST", name: "Test Team" },
				},
			},
		};
	}

	function promptedWebhook(
		sessionId: string,
		body: string,
		workspaceId = LANE_WS,
	) {
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			createdAt: new Date().toISOString(),
			organizationId: workspaceId,
			agentSession: {
				id: sessionId,
				issue: {
					id: `issue-${sessionId}`,
					identifier: `TEST-${sessionId}`,
					title: "Test Issue",
					team: { id: "team-1", key: "TEST", name: "Test Team" },
				},
			},
			agentActivity: {
				id: `activity-${sessionId}`,
				content: { type: "prompt", body },
			},
		};
	}

	/** Route created sessions into a mocked "started runner" state. */
	function mockStartFlow() {
		const router = (edgeWorker as any).repositoryRouter;
		vi.spyOn(router, "determineRepositoryForWebhook").mockResolvedValue({
			type: "selected",
			repositories: [mockRepository],
			routingMethod: "team-based",
		});
		vi.spyOn(edgeWorker as any, "checkBlockedByDependencies").mockResolvedValue(
			{
				blocked: false,
				blockingIssueIds: [],
				blockingIdentifiers: [],
			},
		);
		const initSpy = vi
			.spyOn(edgeWorker as any, "initializeAgentRunner")
			.mockImplementation(async (agentSession: any) => {
				sessionsWithRunners.add(agentSession.id);
			});
		const poster = (edgeWorker as any).activityPoster;
		const spies = {
			init: initSpy,
			instantAck: vi
				.spyOn(edgeWorker as any, "postInstantAcknowledgment")
				.mockResolvedValue(undefined),
			queuedAck: vi
				.spyOn(poster, "postQueuedAcknowledgment")
				.mockResolvedValue(undefined),
			positionUpdate: vi
				.spyOn(poster, "postQueuePositionUpdate")
				.mockResolvedValue(undefined),
			reorderConfirm: vi
				.spyOn(poster, "postQueueReorderConfirmation")
				.mockResolvedValue(undefined),
			contextAck: vi
				.spyOn(poster, "postQueueContextAcknowledgment")
				.mockResolvedValue(undefined),
			removedNotice: vi
				.spyOn(poster, "postQueueRemovedNotice")
				.mockResolvedValue(undefined),
			graceNotice: vi
				.spyOn(poster, "postLaneGraceReleaseNotice")
				.mockResolvedValue(undefined),
		};
		return spies;
	}

	async function settle() {
		// Drain fire-and-forget lane continuations
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("three delegations: #1 starts, #2 and #3 queue with positions 1 and 2", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];

		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s3"), repos);

		expect(spies.init).toHaveBeenCalledTimes(1);
		expect(spies.instantAck).toHaveBeenCalledTimes(1);
		expect(spies.queuedAck).toHaveBeenCalledTimes(2);
		expect(spies.queuedAck).toHaveBeenNthCalledWith(1, "s2", LANE_WS, 1);
		expect(spies.queuedAck).toHaveBeenNthCalledWith(2, "s3", LANE_WS, 2);
	});

	it("persists the queue entry before posting the queued ack", async () => {
		mockStartFlow();
		const order: string[] = [];
		vi.spyOn(edgeWorker as any, "savePersistedStateStrict").mockImplementation(
			async () => {
				order.push("persist");
			},
		);
		const poster = (edgeWorker as any).activityPoster;
		vi.spyOn(poster, "postQueuedAcknowledgment").mockImplementation(
			async () => {
				order.push("ack");
			},
		);
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		order.length = 0;
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

		expect(order[0]).toBe("persist");
		expect(order).toContain("ack");
	});

	it("'next' on #3 moves it to the front, confirms, and reposts only changed positions", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s3"), repos);

		await (edgeWorker as any).handleWebhook(
			promptedWebhook("s3", "next"),
			repos,
		);

		expect(spies.reorderConfirm).toHaveBeenCalledWith("s3", LANE_WS, false);
		expect(spies.positionUpdate).toHaveBeenCalledTimes(1);
		expect(spies.positionUpdate).toHaveBeenCalledWith("s2", LANE_WS, 2);
		expect((edgeWorker as any).laneManager.positionOf("s3")).toBe(1);
	});

	it("a non-reorder prompt on a queued session is stored as context, position unchanged", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

		await (edgeWorker as any).handleWebhook(
			promptedWebhook(
				"s2",
				"also please add dark mode support to the settings page",
			),
			repos,
		);

		expect(spies.contextAck).toHaveBeenCalledWith("s2", LANE_WS, 1);
		expect(spies.reorderConfirm).not.toHaveBeenCalled();
		expect(spies.positionUpdate).not.toHaveBeenCalled();
	});

	it("completion of the active session auto-starts the next queued session", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s3"), repos);

		(edgeWorker as any).handleLaneSessionEnded("s1", "result");
		await settle();

		expect(spies.init).toHaveBeenCalledTimes(2);
		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s2");
		// s3 shifted from position 2 to 1
		expect(spies.positionUpdate).toHaveBeenCalledWith("s3", LANE_WS, 1);
		// dequeue start posts the NORMAL start acknowledgment
		expect(spies.instantAck).toHaveBeenCalledTimes(2);
	});

	it("a dead runner (error without result) releases the lane", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

		// s1's runner dies: it no longer reports a live runner
		sessionsWithRunners.delete("s1");
		(edgeWorker as any).handleLaneRunnerError("s1");
		await settle();

		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s2");
		expect(spies.init).toHaveBeenCalledTimes(2);
	});

	it("a runner error while the session is still running does NOT release the lane", async () => {
		mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);

		(edgeWorker as any).handleLaneRunnerError("s1");
		await settle();

		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s1");
	});

	it("stop on the ACTIVE session releases the lane and starts the next (aborted runners emit no result/error)", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

		await (edgeWorker as any).handleWebhook(
			promptedWebhook("s1", "stop"),
			repos,
		);
		await settle();

		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s2");
		expect(spies.init).toHaveBeenCalledTimes(2);
	});

	it("stop on a queued session removes it and reposts shifted positions", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s3"), repos);

		await (edgeWorker as any).handleWebhook(
			promptedWebhook("s2", "stop"),
			repos,
		);

		expect(spies.removedNotice).toHaveBeenCalledWith("s2", LANE_WS);
		expect(spies.positionUpdate).toHaveBeenCalledWith("s3", LANE_WS, 1);
		expect((edgeWorker as any).laneManager.isQueued("s2")).toBe(false);
	});

	it("a session that never starts (routing none) releases the lane", async () => {
		const spies = mockStartFlow();
		const router = (edgeWorker as any).repositoryRouter;
		vi.spyOn(router, "determineRepositoryForWebhook").mockResolvedValue({
			type: "none",
		});
		const repos = [mockRepository];

		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await settle();

		expect(spies.init).not.toHaveBeenCalled();
		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe(null);
	});

	it("workspaces without laneSerialization run sessions concurrently", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];

		await (edgeWorker as any).handleWebhook(
			createdWebhook("f1", FREE_WS),
			repos,
		);
		await (edgeWorker as any).handleWebhook(
			createdWebhook("f2", FREE_WS),
			repos,
		);

		expect(spies.init).toHaveBeenCalledTimes(2);
		expect(spies.queuedAck).not.toHaveBeenCalled();
	});

	it("child sessions bypass the lane (no parent-child deadlock)", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("parent"), repos);

		(edgeWorker as any).globalSessionRegistry.setParentSession(
			"child",
			"parent",
		);
		await (edgeWorker as any).handleWebhook(createdWebhook("child"), repos);

		expect(spies.init).toHaveBeenCalledTimes(2);
		expect(spies.queuedAck).not.toHaveBeenCalled();
	});

	it("lane state serializes and restores across a restart without double-starting", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s3"), repos);

		const state = (edgeWorker as any).serializeMappings();
		expect(state.lanes[LANE_WS].activeSessionId).toBe("s1");
		expect(state.lanes[LANE_WS].queue.map((e: any) => e.sessionId)).toEqual([
			"s2",
			"s3",
		]);

		// Simulate restart: fresh lane manager restored from persisted state
		const restored = JSON.parse(JSON.stringify(state));
		(edgeWorker as any).laneManager.release(LANE_WS, "s1");
		(edgeWorker as any).laneManager.takeNext(LANE_WS);
		(edgeWorker as any).laneManager.takeNext(LANE_WS);
		(edgeWorker as any).restoreMappings(restored);

		const lm = (edgeWorker as any).laneManager;
		expect(lm.activeSessionOf(LANE_WS)).toBe("s1");
		expect(lm.positionOf("s2")).toBe(1);
		expect(lm.positionOf("s3")).toBe(2);

		// Boot recovery with a restored active session arms grace, does NOT start the head
		sessionsWithRunners.clear();
		vi.useFakeTimers();
		spies.init.mockClear();
		(edgeWorker as any).armLaneBootRecovery();
		expect(spies.init).not.toHaveBeenCalled();
		expect(lm.graceDeadlineOf(LANE_WS)).toBeDefined();

		// Grace expiry: stalled session releases, next starts, notice posted
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		vi.useRealTimers();
		await settle();
		expect(spies.graceNotice).toHaveBeenCalledWith("s1", LANE_WS);
		expect(lm.activeSessionOf(LANE_WS)).toBe("s2");
		expect(spies.init).toHaveBeenCalledTimes(1);
	});

	it("a resume prompt on a delivered session while the lane is busy is enqueued, not started", async () => {
		const spies = mockStartFlow();
		const normalFlowSpy = vi
			.spyOn(edgeWorker as any, "runNormalPromptedFlow")
			.mockResolvedValue(undefined);
		const repos = [mockRepository];

		// s1 delivered (lane released), s2 now holds the lane
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		sessionsWithRunners.delete("s1");
		(edgeWorker as any).handleLaneSessionEnded("s1", "result");
		await settle();
		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s2");

		// client replies on delivered s1 while s2 works
		await (edgeWorker as any).handleWebhook(
			promptedWebhook("s1", "also handle Y please"),
			repos,
		);

		expect(normalFlowSpy).not.toHaveBeenCalled();
		expect(spies.queuedAck).toHaveBeenLastCalledWith("s1", LANE_WS, 1);
		expect((edgeWorker as any).laneManager.isQueued("s1")).toBe(true);
	});

	it("a resume prompt with the lane free acquires it and starts immediately", async () => {
		const spies = mockStartFlow();
		const normalFlowSpy = vi
			.spyOn(edgeWorker as any, "runNormalPromptedFlow")
			.mockImplementation(async (webhook: any) => {
				sessionsWithRunners.add(webhook.agentSession.id);
			});
		const repos = [mockRepository];

		// s1 delivered, lane free, empty queue
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		sessionsWithRunners.delete("s1");
		(edgeWorker as any).handleLaneSessionEnded("s1", "result");
		await settle();

		await (edgeWorker as any).handleWebhook(
			promptedWebhook("s1", "also handle Y please"),
			repos,
		);

		expect(normalFlowSpy).toHaveBeenCalledTimes(1);
		expect(spies.queuedAck).not.toHaveBeenCalled();
		// the resumed session is accounted as the lane holder
		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s1");
	});

	it("a dequeued resume entry replays through the prompted flow with queued context appended", async () => {
		mockStartFlow();
		const normalFlowSpy = vi
			.spyOn(edgeWorker as any, "runNormalPromptedFlow")
			.mockImplementation(async (webhook: any) => {
				sessionsWithRunners.add(webhook.agentSession.id);
			});
		const repos = [mockRepository];

		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		// s1 (delivered earlier) gets a resume prompt while s2 holds the lane
		await (edgeWorker as any).handleWebhook(
			promptedWebhook("s1", "also handle Y please"),
			repos,
		);
		// more context arrives while queued
		await (edgeWorker as any).handleWebhook(
			promptedWebhook("s1", "and make sure it works on mobile"),
			repos,
		);

		// s2 completes → s1's resume entry replays
		sessionsWithRunners.delete("s2");
		(edgeWorker as any).handleLaneSessionEnded("s2", "result");
		await settle();

		expect(normalFlowSpy).toHaveBeenCalledTimes(1);
		const replayed = normalFlowSpy.mock.calls[0]![0] as any;
		expect(replayed.agentSession.id).toBe("s1");
		expect(replayed.agentActivity.content.body).toContain(
			"also handle Y please",
		);
		expect(replayed.agentActivity.content.body).toContain(
			"and make sure it works on mobile",
		);
		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s1");
	});

	it("a failed persist on enqueue rolls back the entry and posts NO queued ack", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);

		vi.spyOn(
			(edgeWorker as any).persistenceManager,
			"saveEdgeWorkerState",
		).mockRejectedValue(new Error("disk full"));

		// handleWebhook swallows the rethrow (logs it); the observable
		// contract is: no ack, no queue entry.
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

		expect(spies.queuedAck).not.toHaveBeenCalled();
		expect((edgeWorker as any).laneManager.isQueued("s2")).toBe(false);
	});

	it("agent-session webhooks from an unknown workspace are dropped entirely", async () => {
		const spies = mockStartFlow();
		const router = (edgeWorker as any).repositoryRouter;
		const routeSpy = vi.spyOn(router, "determineRepositoryForWebhook");
		const repos = [mockRepository];

		await (edgeWorker as any).handleWebhook(
			createdWebhook("intruder-1", "uninvited-workspace"),
			repos,
		);
		await (edgeWorker as any).handleWebhook(
			promptedWebhook("intruder-1", "do work", "uninvited-workspace"),
			repos,
		);

		// Nothing acked, nothing routed, nothing started, nothing queued
		expect(spies.instantAck).not.toHaveBeenCalled();
		expect(spies.queuedAck).not.toHaveBeenCalled();
		expect(spies.init).not.toHaveBeenCalled();
		expect(routeSpy).not.toHaveBeenCalled();
		expect((edgeWorker as any).laneManager.isQueued("intruder-1")).toBe(false);
	});

	it("agent-session webhooks with a missing organizationId are dropped", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		const webhook = createdWebhook("s1") as any;
		webhook.organizationId = undefined;

		await (edgeWorker as any).handleWebhook(webhook, repos);

		expect(spies.instantAck).not.toHaveBeenCalled();
		expect(spies.init).not.toHaveBeenCalled();
	});

	it("cancelling the active issue releases the lane and starts the next", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

		// Terminal state (Done/Canceled) arrives on the message bus, not the
		// legacy webhook path.
		mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([
			{ id: "s1", agentRunner: { stop: vi.fn() } },
		]);
		await (edgeWorker as any).handleIssueStateChangeMessage({
			source: "linear",
			action: "issue_state_change",
			workItemId: "issue-s1",
			workItemIdentifier: "TEST-s1",
		});
		await settle();

		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s2");
		expect(spies.init).toHaveBeenCalledTimes(2);
	});

	it("cancelling a QUEUED issue removes it and reposts shifted positions", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s3"), repos);

		mockAgentSessionManager.getSessionsByIssueId.mockReturnValue([]);
		await (edgeWorker as any).handleIssueStateChangeMessage({
			source: "linear",
			action: "issue_state_change",
			workItemId: "issue-s2",
			workItemIdentifier: "TEST-s2",
		});
		await settle();

		// s2 dropped from the queue; s3 moved up and was told
		expect((edgeWorker as any).laneManager.isQueued("s2")).toBe(false);
		expect((edgeWorker as any).laneManager.positionOf("s3")).toBe(1);
		expect(spies.positionUpdate).toHaveBeenCalledWith("s3", LANE_WS, 1);
		// the active session is untouched
		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s1");
	});

	// PON-113: a session parked on a question is not working. It gives the
	// lane back so the client's other issues proceed, and re-enters when the
	// answer arrives — otherwise an unanswered split proposal freezes the
	// client's entire queue for as long as they take to reply.
	describe("lane handover while awaiting user input (PON-113)", () => {
		it("frees the lane when a session asks a question, starting the next issue", async () => {
			const spies = mockStartFlow();
			const repos = [mockRepository];
			await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
			await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
			expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe(
				"s1",
			);

			(edgeWorker as any).releaseLaneWhileAwaitingInput("s1");
			await settle();

			// s2 took over instead of waiting on a human
			expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe(
				"s2",
			);
			expect(spies.init).toHaveBeenCalledTimes(2);
		});

		it("resumes immediately when the lane is free on answer", async () => {
			mockStartFlow();
			const admitted = await (edgeWorker as any).admitAnsweredSessionToLane(
				promptedWebhook("s1", "Proceed with this split"),
				Date.now(),
			);

			expect(admitted).toBe(true);
			expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe(
				"s1",
			);
		});

		it("queues the answer when another issue holds the lane", async () => {
			const spies = mockStartFlow();
			const repos = [mockRepository];
			await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

			const admitted = await (edgeWorker as any).admitAnsweredSessionToLane(
				promptedWebhook("s1", "Proceed with this split"),
				Date.now(),
			);

			expect(admitted).toBe(false);
			expect((edgeWorker as any).laneManager.isQueued("s1")).toBe(true);
			expect(spies.queuedAck).toHaveBeenCalledWith("s1", LANE_WS, 1);
			// s2 keeps working; the answered session did NOT jump in
			expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe(
				"s2",
			);
		});

		it("admits the answered session once it reaches the front of the queue", async () => {
			mockStartFlow();
			const repos = [mockRepository];
			// The session really is parked on a question, so the replayed
			// webhook takes the AskUserQuestion branch rather than the normal
			// continuation branch.
			const handler = (edgeWorker as any).askUserQuestionHandler;
			vi.spyOn(handler, "hasPendingQuestion").mockReturnValue(true);
			const resolveSpy = vi
				.spyOn(edgeWorker as any, "handleAskUserQuestionResponse")
				.mockResolvedValue(undefined);

			await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
			await (edgeWorker as any).admitAnsweredSessionToLane(
				promptedWebhook("s1", "Proceed"),
				Date.now(),
			);
			expect((edgeWorker as any).laneManager.isQueued("s1")).toBe(true);

			// s2 finishes; the queued answer is dequeued, takes the lane, and
			// the pending question finally resolves.
			(edgeWorker as any).handleLaneSessionEnded("s2", "result");
			await settle();

			expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe(
				"s1",
			);
			expect(resolveSpy).toHaveBeenCalled();
		});

		it("does not enqueue twice on a duplicate answer delivery", async () => {
			const spies = mockStartFlow();
			const repos = [mockRepository];
			await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);
			const webhook = promptedWebhook("s1", "Proceed");

			await (edgeWorker as any).admitAnsweredSessionToLane(webhook, Date.now());
			await (edgeWorker as any).admitAnsweredSessionToLane(webhook, Date.now());

			expect((edgeWorker as any).laneManager.queueLength(LANE_WS)).toBe(1);
			expect(spies.queuedAck).toHaveBeenCalledTimes(2);
			expect(spies.queuedAck).toHaveBeenLastCalledWith("s1", LANE_WS, 1);
		});

		it("is a no-op for workspaces without lane serialization", async () => {
			mockStartFlow();
			const admitted = await (edgeWorker as any).admitAnsweredSessionToLane(
				promptedWebhook("f1", "Proceed", FREE_WS),
				Date.now(),
			);

			expect(admitted).toBe(true);
			expect((edgeWorker as any).laneManager.isQueued("f1")).toBe(false);
		});
	});

	it("boot recovery drains a lane left free with queued work", async () => {
		const spies = mockStartFlow();
		const repos = [mockRepository];
		await (edgeWorker as any).handleWebhook(createdWebhook("s1"), repos);
		await (edgeWorker as any).handleWebhook(createdWebhook("s2"), repos);

		// Simulate crash between release and start: lane free, s2 still queued
		(edgeWorker as any).laneManager.release(LANE_WS, "s1");
		spies.init.mockClear();

		(edgeWorker as any).armLaneBootRecovery();
		await settle();

		expect((edgeWorker as any).laneManager.activeSessionOf(LANE_WS)).toBe("s2");
		expect(spies.init).toHaveBeenCalledTimes(1);
	});
});
