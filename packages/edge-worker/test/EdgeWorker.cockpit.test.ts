import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * EdgeWorker wiring of the operator-cockpit mirror (PON-151).
 *
 * The mirror itself is tested in CockpitMirror.test.ts; these tests pin the
 * seams — which EdgeWorker events push which mirror transitions — because a
 * mirror nothing calls is a cockpit showing nothing.
 */

const GATED_WS = "gated-workspace-id";
const ISSUE_ID = "issue-uuid-0001";
const SESSION_ID = "agent-session-0001";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function spyMirror(worker: EdgeWorker) {
	const mirror = {
		upsert: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		reconcile: vi.fn().mockResolvedValue(undefined),
		serialize: vi.fn().mockReturnValue({}),
		restore: vi.fn(),
	};
	privates(worker).cockpitMirror = mirror;
	return mirror;
}

function registerSession(worker: EdgeWorker) {
	privates(worker).agentSessionManager.createCyrusAgentSession(
		SESSION_ID,
		ISSUE_ID,
		{
			id: ISSUE_ID,
			identifier: "DVV-42",
			title: "Add CSV export",
			description: "d",
			branchName: "dvv-42",
		},
		{ path: "/test/repo", isGitWorktree: false },
	);
}

function promptedWebhook(body: string) {
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: GATED_WS,
		agentSession: {
			id: SESSION_ID,
			issue: { id: ISSUE_ID, identifier: "DVV-42" },
		},
		agentActivity: { content: { body } },
	} as never;
}

const confirmQuestion = {
	question: "Proceed with the scope as posted?",
	header: "Scope",
	options: [
		{ label: "Approve scope", description: "go" },
		{ label: "Revise scope", description: "revise" },
		{ label: "Cancel", description: "stop" },
	],
	multiSelect: false,
};

describe("EdgeWorker - cockpit mirror wiring (PON-151)", () => {
	let worker: EdgeWorker;
	let mirror: ReturnType<typeof spyMirror>;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
		privates(worker).config.linearWorkspaces = {
			[GATED_WS]: { linearToken: "t1" },
		};
		privates(worker).savePersistedStateStrict = vi
			.fn()
			.mockResolvedValue(undefined);
		mirror = spyMirror(worker);
	});

	it("a scope proposal puts NOTHING on the operator's board (PON-219)", async () => {
		// The cockpit contains only approved work. While the client is still
		// deciding, the conversation is theirs and the agent's — an issue in
		// the operator's queue is work he has not been asked to do yet.
		registerSession(worker);
		privates(worker).scopeApprovals.recordOperatorNote(
			ISSUE_ID,
			"internal reading",
			"**Outcome** — the thing works.",
		);
		privates(worker).activityPoster.postClientScopeComment = vi
			.fn()
			.mockResolvedValue(true);
		const callback = privates(worker).createAskUserQuestionCallback(
			SESSION_ID,
			GATED_WS,
		);
		await callback(
			{ questions: [confirmQuestion] },
			"claude-session-id",
			new AbortController().signal,
		);

		expect(mirror.upsert).not.toHaveBeenCalled();
	});

	it("records the approval even if the mirror cannot be created", async () => {
		// The mirror is now BORN on this path, so a throw here lands at the
		// moment consent is recorded. The approval is the fact and the SLA
		// start; the mirror is a derived view, and a broken view must never
		// cost us the fact.
		registerSession(worker);
		privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
			workspaceId: GATED_WS,
			issueIdentifier: "DVV-42",
		});
		privates(worker).askUserQuestionHandler = {
			getPendingQuestion: () => confirmQuestion,
			clearPendingQuestion: vi.fn(),
		};
		mirror.upsert = vi.fn(() => {
			throw new Error("cockpit unreachable");
		});
		await privates(worker).interpretScopeConfirmReply(
			promptedWebhook("Approve scope"),
		);
		expect(privates(worker).scopeApprovals.isApproved(ISSUE_ID)).toBe(true);
	});

	it("scope approval mirrors as queued — approval no longer starts the work (PON-224)", async () => {
		registerSession(worker);
		privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
			workspaceId: GATED_WS,
		});
		privates(worker).askUserQuestionHandler = {
			getPendingQuestion: vi.fn().mockReturnValue(confirmQuestion),
			hasPendingQuestion: vi.fn().mockReturnValue(true),
		};

		await privates(worker).interpretScopeConfirmReply(
			promptedWebhook("Approve scope"),
		);

		expect(mirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: ISSUE_ID }),
			GATED_WS,
			"queued",
			// PON-170: approval also composes the operator brief.
			// PON-224: reviewers are notified at birth — queued is claimable.
			expect.objectContaining({
				brief: expect.objectContaining({ revisions: 0 }),
				subscriberIds: expect.any(Array),
			}),
		);
		expect(
			privates(worker).scopeApprovals.isImplementationDeferred(ISSUE_ID),
		).toBe(true);
	});

	it("scope cancellation closes the mirror", async () => {
		registerSession(worker);
		privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
			workspaceId: GATED_WS,
		});
		privates(worker).askUserQuestionHandler = {
			getPendingQuestion: vi.fn().mockReturnValue(confirmQuestion),
			hasPendingQuestion: vi.fn().mockReturnValue(true),
		};

		await privates(worker).interpretScopeConfirmReply(
			promptedWebhook("Cancel"),
		);

		expect(mirror.close).toHaveBeenCalledWith(ISSUE_ID, "scope_canceled");
	});

	it("a real session end closes the mirror with its reason", () => {
		registerSession(worker);
		privates(worker).handleLaneSessionEnded(SESSION_ID, "runner_complete");
		expect(mirror.close).toHaveBeenCalledWith(ISSUE_ID, "runner_complete");
	});

	it("a mention session's end never closes the delegation's mirror", () => {
		registerSession(worker);
		privates(worker).mentionSessionIds.add(SESSION_ID);
		privates(worker).handleLaneSessionEnded(SESSION_ID, "runner_complete");
		expect(mirror.close).not.toHaveBeenCalled();
	});

	it("a session end while the scope gate is open leaves the mirror alone", () => {
		registerSession(worker);
		privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
			workspaceId: GATED_WS,
		});
		privates(worker).handleLaneSessionEnded(SESSION_ID, "runner_complete");
		expect(mirror.close).not.toHaveBeenCalled();
	});

	it("a session end with queued work remaining on the issue leaves the mirror alone", () => {
		registerSession(worker);
		privates(worker).laneManager.enqueue(GATED_WS, {
			sessionId: "other-session",
			issueId: ISSUE_ID,
			issueIdentifier: "DVV-42",
			enqueuedAt: new Date().toISOString(),
			webhook: {},
		});
		privates(worker).handleLaneSessionEnded(SESSION_ID, "runner_complete");
		expect(mirror.close).not.toHaveBeenCalled();
	});

	it("stopping a queued session closes its mirror", async () => {
		registerSession(worker);
		privates(worker).laneManager.enqueue(GATED_WS, {
			sessionId: SESSION_ID,
			issueId: ISSUE_ID,
			issueIdentifier: "DVV-42",
			enqueuedAt: new Date().toISOString(),
			webhook: {},
		});
		privates(worker).activityPoster = {
			postQueueRemovedNotice: vi.fn().mockResolvedValue(undefined),
			postQueuePositionUpdate: vi.fn().mockResolvedValue(undefined),
		};
		privates(worker).savePersistedState = vi.fn().mockResolvedValue(undefined);

		await privates(worker).handleQueuedSessionStop(promptedWebhook("stop"));

		expect(mirror.close).toHaveBeenCalledWith(ISSUE_ID, "stopped_while_queued");
	});

	it("a terminal client issue closes the mirror", async () => {
		privates(worker).gitService = {
			deleteWorktree: vi.fn().mockResolvedValue(undefined),
		};
		await privates(worker).handleIssueStateChangeMessage({
			workItemId: ISSUE_ID,
			workItemIdentifier: "DVV-42",
		});
		expect(mirror.close).toHaveBeenCalledWith(ISSUE_ID, "issue_terminal");
	});

	it("syncCockpitQueue pushes every queued entry with its position", () => {
		privates(worker).laneManager.enqueue(GATED_WS, {
			sessionId: "s-1",
			issueId: "issue-a",
			issueIdentifier: "DVV-1",
			enqueuedAt: new Date().toISOString(),
			webhook: {},
		});
		privates(worker).laneManager.enqueue(GATED_WS, {
			sessionId: "s-2",
			issueId: "issue-b",
			issueIdentifier: "DVV-2",
			enqueuedAt: new Date().toISOString(),
			webhook: {},
		});

		privates(worker).syncCockpitQueue(GATED_WS);

		expect(mirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: "issue-a" }),
			GATED_WS,
			"queued",
			{ position: 1 },
		);
		expect(mirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: "issue-b" }),
			GATED_WS,
			"queued",
			{ position: 2 },
		);
	});

	it("boot reconciliation hands the full live picture to the mirror", async () => {
		registerSession(worker);
		privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
		privates(worker).laneManager.enqueue(GATED_WS, {
			sessionId: "s-queued",
			issueId: "issue-q",
			issueIdentifier: "DVV-7",
			enqueuedAt: new Date().toISOString(),
			webhook: {},
		});
		privates(worker).scopeApprovals.recordProposed("issue-awaiting", {
			workspaceId: GATED_WS,
			issueIdentifier: "DVV-8",
		});

		await privates(worker).reconcileCockpitMirror();

		expect(mirror.reconcile).toHaveBeenCalledTimes(1);
		const live = mirror.reconcile.mock.calls[0]![0];
		expect(live.active).toEqual([
			{
				issue: { issueId: ISSUE_ID, issueIdentifier: "DVV-42" },
				tenantWorkspaceId: GATED_WS,
			},
		]);
		expect(live.queued).toEqual([
			{
				issue: { issueId: "issue-q", issueIdentifier: "DVV-7" },
				tenantWorkspaceId: GATED_WS,
				position: 1,
			},
		]);
		// PON-219: an open scope conversation is NOT handed to reconcile any
		// more. It used to be the belt-and-braces that recreated a mirror for
		// anything unapproved, which would have quietly undone the creation
		// guard on the very next boot.
		expect(live.awaitingScopeConfirm).toBeUndefined();
	});

	it("cockpit mirrors serialize through serializeMappings and restore back", () => {
		mirror.serialize.mockReturnValue({
			[ISSUE_ID]: {
				mirrorIssueId: "mirror-1",
				tenantWorkspaceId: GATED_WS,
				state: "active",
			},
		});

		const state = worker.serializeMappings();
		expect(state.cockpitMirrors?.[ISSUE_ID]?.mirrorIssueId).toBe("mirror-1");

		worker.restoreMappings(state);
		expect(mirror.restore).toHaveBeenCalledWith(state.cockpitMirrors);
	});

	it("nothing reads the mirror to make a decision (write-only surface)", () => {
		// The spy exposes exactly the write/lifecycle surface EdgeWorker uses;
		// any read-back call site would show up here as an unknown method.
		expect(Object.keys(mirror).sort()).toEqual([
			"close",
			"reconcile",
			"restore",
			"serialize",
			"upsert",
		]);
	});
});
