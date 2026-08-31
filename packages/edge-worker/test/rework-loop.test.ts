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
