import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { NEEDS_INFO_HEADER } from "../src/needs-info.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * EdgeWorker wiring of needs-info mid-work (PON-172): the ask releases the
 * lane under its own reason and flips the mirror to needs-info; the answer
 * — through either path, pending-question or post-restart normal prompt —
 * closes the wait exactly once; the state survives serialize/restore.
 */

const GATED_WS = "gated-workspace-id";
const ISSUE_ID = "issue-uuid-0001";
const SESSION_ID = "agent-session-0001";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
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

const needsInfoInput = {
	questions: [
		{
			question:
				"To finish the export you'll receive, I need: the sender address.",
			header: NEEDS_INFO_HEADER,
			options: [],
			multiSelect: false,
		},
	],
};

describe("EdgeWorker - needs-info mid-work (PON-172)", () => {
	let worker: EdgeWorker;

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
		registerSession(worker);
		// Mid-work = the scope gate is closed for this issue.
		privates(worker).scopeApprovals.recordApproved(ISSUE_ID, {
			workspaceId: GATED_WS,
		});
		privates(worker).askUserQuestionHandler.handleAskUserQuestion = vi
			.fn()
			.mockResolvedValue({ behavior: "allow", updatedInput: {} });
	});

	async function ask() {
		const callback = privates(worker).createAskUserQuestionCallback(
			SESSION_ID,
			GATED_WS,
		);
		await callback(needsInfoInput, "runner-session", undefined);
	}

	it("a needs-info ask records the wait, releases the lane as awaiting_client_info, and mirrors needs-info", async () => {
		privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
		const release = vi
			.spyOn(privates(worker), "releaseLaneAndContinue" as never)
			.mockImplementation(() => {});
		const upsert = vi
			.spyOn(privates(worker).cockpitMirror, "upsert")
			.mockResolvedValue(undefined);

		await ask();

		const record = privates(worker).needsInfo.get(ISSUE_ID);
		expect(record?.state).toBe("awaiting");
		expect(record?.question).toContain("sender address");
		expect(record?.sessionId).toBe(SESSION_ID);
		expect(release).toHaveBeenCalledWith(
			GATED_WS,
			SESSION_ID,
			"awaiting_client_info",
		);
		expect(upsert).toHaveBeenCalledWith(
			{ issueId: ISSUE_ID, issueIdentifier: "DVV-42" },
			GATED_WS,
			"needs-info",
		);
	});

	it("while the scope gate is open, the same ask stays a scope wait — no needs-info record", async () => {
		privates(worker).scopeApprovals.remove(ISSUE_ID);
		privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
			workspaceId: GATED_WS,
		});
		privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
		const release = vi
			.spyOn(privates(worker), "releaseLaneAndContinue" as never)
			.mockImplementation(() => {});

		await ask();

		expect(privates(worker).needsInfo.get(ISSUE_ID)).toBeUndefined();
		expect(release).toHaveBeenCalledWith(
			GATED_WS,
			SESSION_ID,
			"awaiting_scope_confirm",
		);
	});

	it("a non-needs-info question records nothing and releases as awaiting_user_input", async () => {
		privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
		const release = vi
			.spyOn(privates(worker), "releaseLaneAndContinue" as never)
			.mockImplementation(() => {});

		const callback = privates(worker).createAskUserQuestionCallback(
			SESSION_ID,
			GATED_WS,
		);
		await callback(
			{
				questions: [
					{
						question: "Which library?",
						header: "Approach",
						options: [],
						multiSelect: false,
					},
				],
			},
			"runner-session",
			undefined,
		);

		expect(privates(worker).needsInfo.get(ISSUE_ID)).toBeUndefined();
		expect(release).toHaveBeenCalledWith(
			GATED_WS,
			SESSION_ID,
			"awaiting_user_input",
		);
	});

	it("the client's answer through the pending-question path closes the wait and re-activates the mirror", async () => {
		await ask();
		const upsert = vi
			.spyOn(privates(worker).cockpitMirror, "upsert")
			.mockResolvedValue(undefined);

		await privates(worker).handleAskUserQuestionResponse({
			type: "AgentSessionEvent",
			action: "prompted",
			organizationId: GATED_WS,
			agentSession: {
				id: SESSION_ID,
				issue: { id: ISSUE_ID, identifier: "DVV-42" },
			},
			agentActivity: { content: { body: "sender is noreply@acme.com" } },
		});

		expect(privates(worker).needsInfo.get(ISSUE_ID)?.state).toBe("answered");
		expect(upsert).toHaveBeenCalledWith(
			{ issueId: ISSUE_ID, issueIdentifier: "DVV-42" },
			GATED_WS,
			"active",
		);
	});

	it("marking answered is idempotent — a replayed answer changes nothing", async () => {
		await ask();
		privates(worker).markNeedsInfoAnswered(ISSUE_ID, GATED_WS, "DVV-42");
		const answeredAt = privates(worker).needsInfo.get(ISSUE_ID)?.answeredAt;
		const upsert = vi
			.spyOn(privates(worker).cockpitMirror, "upsert")
			.mockResolvedValue(undefined);

		privates(worker).markNeedsInfoAnswered(ISSUE_ID, GATED_WS, "DVV-42");

		expect(privates(worker).needsInfo.get(ISSUE_ID)?.answeredAt).toBe(
			answeredAt,
		);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("the wait rides the persisted state (serializeMappings) and restores", async () => {
		await ask();
		const state = privates(worker).serializeMappings();
		expect(state.needsInfo?.[ISSUE_ID]?.state).toBe("awaiting");

		const fresh = createTestWorker([]);
		privates(fresh).needsInfo.restore(state.needsInfo);
		expect(privates(fresh).needsInfo.isAwaiting(ISSUE_ID)).toBe(true);
	});
});
