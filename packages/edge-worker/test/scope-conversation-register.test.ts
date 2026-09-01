import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * A waiting conversation must appear on SOME operator register.
 *
 * Found live on FRO-65. Both registers recognise by exact canonical form —
 * the scope record needs the `Approve scope` option, needs-info needs the
 * `Missing info` header, and needs-info is additionally scoped to
 * gate-CLOSED issues. So a pre-approval question in neither form landed in
 * neither: the session sat at `awaitingInput`, the lane correctly released,
 * nothing was blocked, and the conversation was invisible.
 *
 * Not a rare shape. FRO-65 asked a good question — the repository had no
 * tests at all, so it asked what the client actually wanted rather than
 * proposing scope for a false premise.
 */

const WS = "gated-workspace-id";
const ISSUE = "issue-uuid-0001";
const SESSION = "agent-session-0001";

function privates(w: EdgeWorker): Record<string, any> {
	return w as never as Record<string, any>;
}

const clarifying = {
	question:
		"This repository has no tests today. What should new people find when they look?",
	header: "Tests",
	options: [
		{ label: "Set up tests, then document", description: "a" },
		{ label: "Document the gap only", description: "b" },
	],
	multiSelect: false,
};

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

function worker() {
	const w = createTestWorker([]);
	const p = privates(w);
	p.config.linearWorkspaces = { [WS]: { linearToken: "t1" } };
	p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
	p.agentSessionManager.getSession = vi.fn().mockReturnValue({
		issueContext: { issueId: ISSUE, issueIdentifier: "FRO-65" },
	});
	p.sessionIssueId = vi.fn().mockReturnValue(ISSUE);
	p.cockpitMirror.upsert = vi.fn();
	return p;
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a pre-approval question the operator can see", () => {
	it("registers a non-canonical elicitation so it reaches the waiting room", async () => {
		const p = worker();
		expect(p.scopeApprovals.get(ISSUE)).toBeUndefined();

		await p.createAskUserQuestionCallback(SESSION, WS)(
			{ questions: [clarifying] },
			"claude-session-id",
			new AbortController().signal,
		);

		const rec = p.scopeApprovals.get(ISSUE);
		expect(rec).toBeDefined();
		expect(rec.state).toBe("awaiting");
		expect(rec.issueIdentifier).toBe("FRO-65");
	});

	it("does not stamp the SLA clock — nobody has approved anything", async () => {
		const p = worker();

		await p.createAskUserQuestionCallback(SESSION, WS)(
			{ questions: [clarifying] },
			"c",
			new AbortController().signal,
		);

		expect(p.scopeApprovals.get(ISSUE).approvedAt).toBeUndefined();
		expect(p.scopeApprovals.isApproved(ISSUE)).toBe(false);
	});

	it("keeps the FIRST proposedAt when the real scope ask follows", async () => {
		// The registration is a floor, not a reset: a later genuine proposal
		// refines the record rather than restarting the wait, or a stalled
		// conversation would look fresh every time it asked again.
		const p = worker();
		await p.createAskUserQuestionCallback(SESSION, WS)(
			{ questions: [clarifying] },
			"c",
			new AbortController().signal,
		);
		const first = p.scopeApprovals.get(ISSUE).proposedAt;

		await p.createAskUserQuestionCallback(SESSION, WS)(
			{ questions: [{ ...clarifying, question: "and which runner?" }] },
			"c",
			new AbortController().signal,
		);

		expect(p.scopeApprovals.get(ISSUE).proposedAt).toBe(first);
	});

	it("leaves an APPROVED issue alone — the gate is closed there", async () => {
		// After approval this path must not re-open a scope conversation; a
		// mid-work question is needs-info's business.
		const p = worker();
		p.scopeApprovals.recordProposed(ISSUE, { workspaceId: WS });
		p.scopeApprovals.recordApproved(ISSUE);
		const before = JSON.stringify(p.scopeApprovals.get(ISSUE));

		await p.createAskUserQuestionCallback(SESSION, WS)(
			{ questions: [clarifying] },
			"c",
			new AbortController().signal,
		);

		expect(p.scopeApprovals.isApproved(ISSUE)).toBe(true);
		expect(JSON.stringify(p.scopeApprovals.get(ISSUE))).toBe(before);
	});

	it("still lets the canonical scope ask take its own path", async () => {
		// The canonical branch composes the client-facing scope and refuses
		// when none was recorded. Registration must not swallow that.
		const p = worker();
		const res = await p.createAskUserQuestionCallback(SESSION, WS)(
			{ questions: [confirmQuestion] },
			"c",
			new AbortController().signal,
		);
		expect(res.answered).toBe(false);
		expect(res.message).toContain("record_operator_note");
	});
});
