import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { ScopeApprovalStore } from "../src/ScopeApprovalStore.js";
import {
	buildImplementationParkedBlock,
	buildScopeConfirmGateBlock,
} from "../src/scope-confirm-gate.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Approval parks the work (PON-224, v3 cockpit step 1).
 *
 * The properties under test: approval no longer starts implementation — the
 * record parks, the mirror is born `queued`, the confirmation turn is not
 * held for verification, and nothing (session end, boot reconcile, follow-up
 * conversation) mistakes parked work for started or finished work. Legacy
 * records approved under the auto-start flow carry no flag and behave
 * exactly as before.
 */

const GATED_WS = "gated-workspace-id";
const ISSUE_ID = "issue-uuid-0001";
const SESSION_ID = "agent-session-0001";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function registerSession(worker: EdgeWorker, sessionId = SESSION_ID) {
	privates(worker).agentSessionManager.createCyrusAgentSession(
		sessionId,
		ISSUE_ID,
		{
			id: ISSUE_ID,
			identifier: "ACM-42",
			title: "Add CSV export",
			description: "d",
			branchName: "acm-42",
		},
		{ path: "/test/repo", isGitWorktree: false },
	);
	privates(worker).sessionRepositories.set(sessionId, "repo-gated");
	privates(worker).repositories.set("repo-gated", {
		id: "repo-gated",
		repositoryPath: "/test/repo",
		baseBranch: "main",
		linearWorkspaceId: GATED_WS,
	});
}

function spyMirror(worker: EdgeWorker) {
	const mirror = {
		upsert: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		reconcile: vi.fn().mockResolvedValue(undefined),
		serialize: vi.fn().mockReturnValue({}),
		restore: vi.fn(),
		clientIssueIdFor: vi.fn().mockReturnValue(undefined),
		clientIssueStateType: vi.fn().mockResolvedValue(undefined),
	};
	privates(worker).cockpitMirror = mirror;
	return mirror;
}

describe("ScopeApprovalStore - the parked flag (PON-224)", () => {
	it("approval parks; a replayed approve cannot re-park a started issue", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed(ISSUE_ID);
		expect(store.recordApproved(ISSUE_ID)).toBe(true);
		expect(store.isImplementationDeferred(ISSUE_ID)).toBe(true);

		expect(store.markImplementationStarted(ISSUE_ID)).toBe(true);
		expect(store.isImplementationDeferred(ISSUE_ID)).toBe(false);
		// The transition reports once.
		expect(store.markImplementationStarted(ISSUE_ID)).toBe(false);

		// A replayed approve webhook records nothing and re-parks nothing.
		expect(store.recordApproved(ISSUE_ID)).toBe(false);
		expect(store.isImplementationDeferred(ISSUE_ID)).toBe(false);
	});

	it("a legacy approved record (no flag) is not deferred", () => {
		const store = new ScopeApprovalStore();
		store.restore({
			[ISSUE_ID]: {
				state: "approved",
				proposedAt: "2026-08-01T00:00:00.000Z",
				approvedAt: "2026-08-01T00:01:00.000Z",
			},
		});
		expect(store.isImplementationDeferred(ISSUE_ID)).toBe(false);
		expect(store.listDeferred()).toEqual([]);
	});

	it("listDeferred lists parked approvals only, and the flag survives serialize/restore", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("parked-issue", { workspaceId: GATED_WS });
		store.recordApproved("parked-issue", { workspaceId: GATED_WS });
		store.recordProposed("awaiting-issue");

		const restored = new ScopeApprovalStore();
		restored.restore(store.serialize());
		expect(restored.listDeferred().map((e) => e.issueId)).toEqual([
			"parked-issue",
		]);
		expect(restored.isImplementationDeferred("parked-issue")).toBe(true);
	});
});

describe("EdgeWorker - approval parks the work (PON-224)", () => {
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
		privates(worker).config.cockpit = {
			linearWorkspaceId: "cockpit-ws",
			workspaceName: "Cockpit",
			teamId: "team-1",
			assigneeId: "approver-user-id",
		};
		privates(worker).savePersistedStateStrict = vi
			.fn()
			.mockResolvedValue(undefined);
		mirror = spyMirror(worker);
	});

	const approve = () => {
		privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
			workspaceId: GATED_WS,
		});
		privates(worker).scopeApprovals.recordApproved(ISSUE_ID, {
			workspaceId: GATED_WS,
		});
	};

	it("a parked completion is NOT held for verification — the confirmation posts", () => {
		registerSession(worker);
		approve();
		const held = privates(worker).holdCompletionForVerification(
			SESSION_ID,
			"Confirmed — your work is in the queue.",
			false,
		);
		expect(held).toBe(false);
		expect(privates(worker).verificationGate.get(ISSUE_ID)).toBeUndefined();
	});

	it("a legacy approved issue (no flag) is still held exactly as before", () => {
		registerSession(worker);
		privates(worker).scopeApprovals.restore({
			[ISSUE_ID]: {
				state: "approved",
				proposedAt: "2026-08-01T00:00:00.000Z",
				approvedAt: "2026-08-01T00:01:00.000Z",
				workspaceId: GATED_WS,
			},
		});
		const held = privates(worker).holdCompletionForVerification(
			SESSION_ID,
			"All done. PR: https://github.com/acme/webapp/pull/42",
			false,
		);
		expect(held).toBe(true);
		expect(privates(worker).verificationGate.get(ISSUE_ID)?.state).toBe(
			"in-verification",
		);
	});

	it("closes the mirror's narration turn when the scoping session ends (PON-226)", () => {
		// Found live on CKP-22: the narration thread is a real agent session,
		// client narration is shadowed onto it, and a turn is only closed by a
		// `response` — so a parked mirror sat in Linear's `active` state with
		// a running timer, quoting a stale plan item, on work nobody had
		// claimed. Nothing was running; the board said otherwise.
		registerSession(worker);
		approve();
		const endNarrationTurn = vi.fn();
		privates(worker).endNarrationTurn = endNarrationTurn;

		privates(worker).handleLaneSessionEnded(SESSION_ID, "result");

		expect(endNarrationTurn).toHaveBeenCalledWith(
			ISSUE_ID,
			expect.stringContaining("Queued — your move"),
		);
		// It says the truth about what is above it, so the stale narration is
		// not read as this mirror working.
		expect(endNarrationTurn.mock.calls[0][1]).toContain("Nothing is running");
	});

	it("does not sign off a mirror whose work has actually started", () => {
		registerSession(worker);
		approve();
		privates(worker).scopeApprovals.markImplementationStarted(ISSUE_ID);
		const endNarrationTurn = vi.fn();
		privates(worker).endNarrationTurn = endNarrationTurn;

		privates(worker).handleLaneSessionEnded(SESSION_ID, "result");

		expect(endNarrationTurn).not.toHaveBeenCalled();
	});

	it("the scoping session ending does not close a parked mirror", () => {
		registerSession(worker);
		approve();
		expect(
			privates(worker).shouldCloseCockpitMirror(SESSION_ID, ISSUE_ID),
		).toBe(false);
		// Once implementation starts, session end resumes meaning what it
		// always did.
		privates(worker).scopeApprovals.markImplementationStarted(ISSUE_ID);
		expect(
			privates(worker).shouldCloseCockpitMirror(SESSION_ID, ISSUE_ID),
		).toBe(true);
	});

	it("boot reconcile counts parked work as live, as queued", async () => {
		approve();
		await privates(worker).reconcileCockpitMirror();
		expect(mirror.reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				parked: [
					expect.objectContaining({
						issue: expect.objectContaining({ issueId: ISSUE_ID }),
						tenantWorkspaceId: GATED_WS,
					}),
				],
			}),
		);
	});

	it("a parked issue already accounted for by the lane is not double-listed", async () => {
		registerSession(worker);
		approve();
		privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
		await privates(worker).reconcileCockpitMirror();
		const call = mirror.reconcile.mock.calls[0][0];
		expect(call.parked).toEqual([]);
		expect(call.active.map((e: any) => e.issue.issueId)).toContain(ISSUE_ID);
	});

	it("a needs-info answer on a parked issue keeps the mirror queued", () => {
		registerSession(worker);
		approve();
		privates(worker).needsInfo.recordAsked(ISSUE_ID, {
			question: "Which currency?",
			sessionId: SESSION_ID,
			workspaceId: GATED_WS,
		});
		privates(worker).markNeedsInfoAnswered(ISSUE_ID, GATED_WS, "ACM-42");
		expect(mirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: ISSUE_ID }),
			GATED_WS,
			"queued",
		);
	});

	describe("the parked prompt block", () => {
		it("replaces the gate block after approval, and disappears when work starts", () => {
			approve();
			const parked = privates(worker).appendScopeGateIfPending(
				"BASE",
				GATED_WS,
				ISSUE_ID,
				SESSION_ID,
			);
			expect(parked).toBe(`BASE${buildImplementationParkedBlock()}`);

			privates(worker).scopeApprovals.markImplementationStarted(ISSUE_ID);
			expect(
				privates(worker).appendScopeGateIfPending(
					"BASE",
					GATED_WS,
					ISSUE_ID,
					SESSION_ID,
				),
			).toBe("BASE");
		});

		it("the gate block still wins while the gate is open", () => {
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
				workspaceId: GATED_WS,
			});
			expect(
				privates(worker).appendScopeGateIfPending(
					"BASE",
					GATED_WS,
					ISSUE_ID,
					SESSION_ID,
				),
			).toBe(`BASE${buildScopeConfirmGateBlock()}`);
		});

		it("child and operator sessions get neither block", () => {
			approve();
			privates(worker).globalSessionRegistry = {
				getParentSessionId: vi.fn().mockReturnValue("parent-session"),
			};
			expect(
				privates(worker).appendScopeGateIfPending(
					"BASE",
					GATED_WS,
					ISSUE_ID,
					SESSION_ID,
				),
			).toBe("BASE");
		});
	});
});
