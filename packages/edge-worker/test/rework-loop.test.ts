import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import {
	interpretReworkAnswer,
	isReworkConfirmQuestion,
	REWORK_NO_LABEL,
	REWORK_YES_LABEL,
} from "../src/request-intent.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-236: a client's change request reopens the work rather than changing it.
 *
 * Delivered work is not edited quietly. The client confirms a delta, it goes
 * back in the queue as rework at the head of the order, and the reviewer is
 * told — because a finished item reopening is exactly the thing they would
 * otherwise learn about by accident.
 */

const WS = "ws-acme";
const ISSUE = "issue-acm-21";
const SESSION = "sess-client";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

const reworkQuestion = {
	question: "Shall I make that change?",
	header: "Change",
	options: [
		{ label: REWORK_YES_LABEL, description: "yes" },
		{ label: REWORK_NO_LABEL, description: "no" },
	],
	multiSelect: false,
};

describe("recognising the confirmation", () => {
	it("reads the canonical yes, and keeps what they added", () => {
		expect(interpretReworkAnswer(REWORK_YES_LABEL).confirmed).toBe(true);
		const withNote = interpretReworkAnswer(
			`${REWORK_YES_LABEL}\n\nand make the header bigger too`,
		);
		expect(withNote.confirmed).toBe(true);
		expect(withNote.note).toBe("and make the header bigger too");
	});

	it("never reopens work on a no, or on free text", () => {
		expect(interpretReworkAnswer(REWORK_NO_LABEL).confirmed).toBe(false);
		expect(interpretReworkAnswer("yes please").confirmed).toBe(false);
		expect(
			interpretReworkAnswer("Yes, make this change please").confirmed,
		).toBe(false);
	});

	it("only recognises an ask carrying the exact label", () => {
		expect(isReworkConfirmQuestion(reworkQuestion)).toBe(true);
		expect(
			isReworkConfirmQuestion({
				options: [{ label: "Yes" }, { label: "No" }],
			}),
		).toBe(false);
	});
});

describe("reopening the work", () => {
	let worker: EdgeWorker;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
	});

	function deliveredWork(pendingQuestion: unknown = reworkQuestion) {
		const p = privates(worker);
		p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
		p.scopeApprovals.recordProposed(ISSUE, { workspaceId: WS });
		p.scopeApprovals.recordApproved(ISSUE, { workspaceId: WS });
		p.scopeApprovals.markImplementationStarted(ISSUE);
		p.verificationGate.recordPending(ISSUE, {
			workspaceId: WS,
			issueIdentifier: "ACM-21",
			sessionId: SESSION,
			summary: "done",
			isError: false,
		});
		p.verificationGate.markDelivered(ISSUE);
		p.askUserQuestionHandler = {
			getPendingQuestion: () => pendingQuestion,
		};
		p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.commentOnMirror = vi.fn().mockResolvedValue(undefined);
		return p;
	}

	const reply = (body: string) =>
		({
			type: "AgentSessionEvent",
			action: "prompted",
			organizationId: WS,
			agentSession: { id: SESSION, issue: { id: ISSUE, identifier: "ACM-21" } },
			agentActivity: { content: { body } },
		}) as never;

	it("puts confirmed work back as rework, and tells the reviewer", async () => {
		const p = deliveredWork();

		await p.interpretReworkReply(
			reply(`${REWORK_YES_LABEL}\n\nthe totals column is still wrong`),
		);

		expect(p.cockpitMirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: ISSUE }),
			WS,
			"rework",
			expect.objectContaining({ subscriberIds: expect.any(Array) }),
		);
		// It re-enters by the same door a first start uses.
		expect(p.scopeApprovals.isImplementationDeferred(ISSUE)).toBe(true);
		// An activity does not reach an inbox; a comment does.
		expect(p.cockpitMirror.commentOnMirror).toHaveBeenCalledWith(
			ISSUE,
			expect.stringContaining("the totals column is still wrong"),
		);
	});

	it("does nothing on a no", async () => {
		const p = deliveredWork();

		await p.interpretReworkReply(reply(REWORK_NO_LABEL));

		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
		expect(p.scopeApprovals.isImplementationDeferred(ISSUE)).toBe(false);
	});

	it("does nothing when the work was never delivered", async () => {
		// The labels mean nothing before delivery and must move nothing.
		const p = deliveredWork();
		p.verificationGate.remove(ISSUE);

		await p.interpretReworkReply(reply(REWORK_YES_LABEL));

		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
	});

	it("does nothing while the work is still held for the reviewer", async () => {
		// A record exists but is in-verification: the client has not been
		// given anything yet, so there is nothing for them to ask to change.
		const p = deliveredWork();
		p.verificationGate.recordPending(ISSUE, {
			workspaceId: WS,
			issueIdentifier: "ACM-21",
			sessionId: SESSION,
			summary: "held",
			isError: false,
		});
		expect(p.verificationGate.get(ISSUE)?.state).toBe("in-verification");

		await p.interpretReworkReply(reply(REWORK_YES_LABEL));

		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
	});

	it("ignores a yes to an UNRELATED elicitation", async () => {
		const p = deliveredWork({
			question: "Delete the export?",
			options: [{ label: "Yes" }, { label: "No" }],
		});

		await p.interpretReworkReply(reply("Yes"));

		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
	});
});

describe("rework, the whole cycle (v3.1)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	// `null` means "no ask in memory" (a restart). Not `undefined`: passing
	// undefined selects the parameter default, and the two restart tests
	// below ran with the ask still in memory until a mutation check showed
	// they passed without the fallback they were written for.
	function delivered(pendingQuestion: unknown = reworkQuestion) {
		const worker = createTestWorker([]);
		const p = privates(worker);
		p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
		p.scopeApprovals.recordProposed(ISSUE, { workspaceId: WS });
		p.scopeApprovals.recordApproved(ISSUE, { workspaceId: WS });
		p.scopeApprovals.markImplementationStarted(ISSUE);
		p.verificationGate.recordPending(ISSUE, {
			workspaceId: WS,
			issueIdentifier: "ACM-21",
			sessionId: SESSION,
			summary: "done https://github.com/o/r/pull/6",
			isError: false,
		});
		p.verificationGate.markDelivered(ISSUE);
		p.verificationGate.setMergeWatch(ISSUE, {
			owner: "o",
			repo: "r",
			number: 6,
		});
		p.askUserQuestionHandler = {
			getPendingQuestion: () => pendingQuestion ?? undefined,
			hasPendingQuestion: () => pendingQuestion != null,
		};
		p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.commentOnMirror = vi.fn().mockResolvedValue(undefined);
		p.redraftPullRequestForRework = vi.fn().mockResolvedValue(undefined);
		return p;
	}
	const reply = (body: string) =>
		({
			type: "AgentSessionEvent",
			action: "prompted",
			organizationId: WS,
			agentSession: { id: SESSION, issue: { id: ISSUE, identifier: "ACM-21" } },
			agentActivity: { content: { body } },
		}) as never;

	it("the record leaves 'delivered', so the rework run can be held and released again", async () => {
		const p = delivered();
		await p.interpretReworkReply(reply(REWORK_YES_LABEL));

		const record = p.verificationGate.get(ISSUE);
		expect(record.state).toBe("rework");
		expect(record.reworkRequestedAt).toBeDefined();
		expect(record.mergeWatch).toEqual({ owner: "o", repo: "r", number: 6 });
		// A rework completion is held like a first pass: the delivered
		// early-return no longer applies, and the hold keeps the merge watch.
		p.verificationGate.recordPending(ISSUE, {
			workspaceId: WS,
			sessionId: "sess-mirror",
			summary: "reworked https://github.com/o/r/pull/6",
			isError: false,
		});
		expect(p.verificationGate.isPending(ISSUE)).toBe(true);
		expect(p.verificationGate.get(ISSUE).mergeWatch).toEqual({
			owner: "o",
			repo: "r",
			number: 6,
		});
	});

	it("puts the pull request back to draft — no merge button on unreviewed commits", async () => {
		const p = delivered();
		await p.interpretReworkReply(reply(REWORK_YES_LABEL));
		expect(p.redraftPullRequestForRework).toHaveBeenCalledWith(
			ISSUE,
			expect.objectContaining({
				mergeWatch: { owner: "o", repo: "r", number: 6 },
			}),
		);
	});

	it("approve: refuses while the rework has not handed over, instead of re-sending the old summary", async () => {
		const p = delivered();
		await p.interpretReworkReply(reply(REWORK_YES_LABEL));
		const answer = await p.deliverVerifiedWork(ISSUE, "looks fine");
		expect(answer).toMatch(/rework has not finished/);
		expect(p.verificationGate.get(ISSUE).state).toBe("rework");
	});

	it("the pull request stays watched during rework — the client may still merge", async () => {
		const p = delivered();
		await p.interpretReworkReply(reply(REWORK_YES_LABEL));
		expect(p.verificationGate.awaitingMergeIssueIds()).toContain(ISSUE);
	});

	it("after a restart, the canonical yes still reopens the work", async () => {
		// No pending ask in memory: the box restarted between the ask and
		// the answer. Same fallback the scope gate has had since PON-150.
		const p = delivered(null);
		await p.interpretReworkReply(reply(REWORK_YES_LABEL));
		expect(p.verificationGate.get(ISSUE).state).toBe("rework");
		expect(p.scopeApprovals.isImplementationDeferred(ISSUE)).toBe(true);
	});

	it("after a restart, free text does not", async () => {
		const p = delivered(null);
		await p.interpretReworkReply(reply("yes please, and make it blue"));
		expect(p.verificationGate.get(ISSUE).state).toBe("delivered");
	});

	it("survives a restart as rework, not as In client review", async () => {
		const p = delivered();
		await p.interpretReworkReply(reply(REWORK_YES_LABEL));
		const reconcile = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.reconcile = reconcile;
		p.cockpitMirror.resyncOperatorOrdering = vi
			.fn()
			.mockResolvedValue(undefined);
		p.pruneEndedScopeConversations = vi.fn().mockResolvedValue(undefined);

		await p.reconcileCockpitMirror();

		const args = reconcile.mock.calls[0][0];
		expect(args.rework.map((e: any) => e.issue.issueId)).toEqual([ISSUE]);
		expect(args.inClientReview.map((e: any) => e.issue.issueId)).not.toContain(
			ISSUE,
		);
		expect(args.parked.map((e: any) => e.issue.issueId)).not.toContain(ISSUE);
	});

	it("a mid-work needs-info wait survives a restart as needs-info", async () => {
		const p = delivered();
		p.verificationGate.remove(ISSUE);
		p.needsInfo.recordAsked(ISSUE, {
			question: "which currency?",
			workspaceId: WS,
			issueIdentifier: "ACM-21",
			relaySessionId: "sess-mirror",
		});
		const reconcile = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.reconcile = reconcile;
		p.cockpitMirror.resyncOperatorOrdering = vi
			.fn()
			.mockResolvedValue(undefined);
		p.pruneEndedScopeConversations = vi.fn().mockResolvedValue(undefined);

		await p.reconcileCockpitMirror();

		const args = reconcile.mock.calls[0][0];
		expect(args.needsInfo.map((e: any) => e.issue.issueId)).toEqual([ISSUE]);
	});
});
