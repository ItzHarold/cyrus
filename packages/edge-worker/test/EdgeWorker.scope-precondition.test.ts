import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-188: the client is never asked to approve a scope they cannot read.
 *
 * Found live on ACM-10: the session recorded its client scope and posted the
 * confirmation elicitation, but the scope body itself was assistant text —
 * narration — and narration is suppressed on exactly the workspaces this gate
 * runs on. The client got "Shall I proceed with the scope above?" with
 * nothing above it.
 *
 * The scope body's presence is now a hard precondition of asking.
 */

const WS = "ws-scope-precondition";
const SESSION_ID = "agent-session-scope-1";
const ISSUE_ID = "issue-scope-1";

const SCOPE_TEXT =
	"**Outcome** — the dashboard works on a phone.\n**You will receive** — a preview link and a PR to merge.";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

const SCOPE_QUESTION = {
	questions: [
		{
			question: "Shall I proceed with the scope above?",
			header: "Scope",
			multiSelect: false,
			options: [
				{ label: "Approve scope", description: "Build it." },
				{ label: "Revise scope", description: "Change it." },
				{ label: "Cancel", description: "Don't." },
			],
		},
	],
};

function setup(
	workspaceConfig: Record<string, unknown> = { linearToken: "t" },
) {
	const worker = createTestWorker([]);
	const p = privates(worker);
	p.config.linearWorkspaces = { [WS]: workspaceConfig };
	p.agentSessionManager.createCyrusAgentSession(
		SESSION_ID,
		ISSUE_ID,
		{
			id: ISSUE_ID,
			identifier: "ACM-10",
			title: "Dashboard is broken on mobile",
			description: "d",
			branchName: "b",
		},
		{ path: "/root/.cyrus-community/worktrees/ws/ACM-10", isGitWorktree: true },
	);
	p.sessionRepositories.set(SESSION_ID, "repo-1");
	p.repositories.set("repo-1", { id: "repo-1", linearWorkspaceId: WS });
	p.sessionIssueId = () => ISSUE_ID;

	// Isolate the unit: no disk, no mirror, no lane.
	p.persistScopeApprovals = vi.fn().mockResolvedValue(undefined);
	p.persistNeedsInfo = vi.fn().mockResolvedValue(undefined);
	p.cockpitMirror = { upsert: vi.fn() };
	p.releaseLaneWhileAwaitingInput = vi.fn();

	const postedScopes: string[] = [];
	p.activityPoster.postClientScopeProposal = vi
		.fn()
		.mockImplementation(async (_s: string, _w: string, body: string) => {
			postedScopes.push(body);
			return true;
		});

	const asked = vi.fn().mockResolvedValue({ answered: true, answers: {} });
	p.askUserQuestionHandler = { handleAskUserQuestion: asked };

	const callback = p.createAskUserQuestionCallback(SESSION_ID, WS);
	return { worker, p, callback, asked, postedScopes };
}

describe("EdgeWorker - scope body is a precondition of asking (PON-188)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("posts the recorded client scope, then the elicitation — the ACM-10 fix", async () => {
		const { p, callback, asked, postedScopes } = setup();
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);

		await callback(SCOPE_QUESTION, "claude-session", undefined);

		expect(postedScopes).toEqual([SCOPE_TEXT]);
		expect(asked).toHaveBeenCalledOnce();
		expect(p.scopeApprovals.get(ISSUE_ID).clientScopePosted).toBe(SCOPE_TEXT);
	});

	it("REFUSES to ask when no scope was recorded — nothing posted, nothing stamped", async () => {
		const { p, callback, asked, postedScopes } = setup();

		const result = await callback(SCOPE_QUESTION, "claude-session", undefined);

		expect(asked).not.toHaveBeenCalled();
		expect(postedScopes).toEqual([]);
		expect(result.answered).toBe(false);
		expect(result.message).toMatch(/client_scope/);
		// No proposal bookkeeping: the SLA clock and the cockpit state must not
		// move for a question the client never saw.
		expect(p.scopeApprovals.get(ISSUE_ID)).toBeUndefined();
		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
		expect(p.releaseLaneWhileAwaitingInput).not.toHaveBeenCalled();
	});

	it("refuses when the post itself fails — better silent than asking blind", async () => {
		const { p, callback, asked } = setup();
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);
		p.activityPoster.postClientScopeProposal = vi.fn().mockResolvedValue(false);

		const result = await callback(SCOPE_QUESTION, "claude-session", undefined);

		expect(asked).not.toHaveBeenCalled();
		expect(result.answered).toBe(false);
		expect(p.scopeApprovals.get(ISSUE_ID).clientScopePosted).toBeUndefined();
	});

	it("does not double-post a replayed identical proposal", async () => {
		const { p, callback, postedScopes } = setup();
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);

		await callback(SCOPE_QUESTION, "claude-session", undefined);
		await callback(SCOPE_QUESTION, "claude-session", undefined);

		expect(postedScopes).toEqual([SCOPE_TEXT]);
	});

	it("posts again when the scope is revised — the client reads the new one", async () => {
		const { p, callback, postedScopes } = setup();
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);
		await callback(SCOPE_QUESTION, "claude-session", undefined);

		const revised = `${SCOPE_TEXT}\n**Interpreted** — tables scroll instead of shrinking.`;
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal v2", revised);
		await callback(SCOPE_QUESTION, "claude-session", undefined);

		expect(postedScopes).toEqual([SCOPE_TEXT, revised]);
	});

	it("posts nothing on a non-quiet workspace — its narration already carries the scope", async () => {
		const { p, callback, asked, postedScopes } = setup({
			linearToken: "t",
			clientQuiet: false,
		});
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);

		await callback(SCOPE_QUESTION, "claude-session", undefined);

		expect(postedScopes).toEqual([]);
		expect(asked).toHaveBeenCalledOnce();
	});

	it("asks a NON-gate question freely — the precondition is scope-confirm only", async () => {
		const { callback, asked, postedScopes } = setup();

		await callback(
			{
				questions: [
					{
						question: "Missing info: which currency?",
						header: "Missing info",
						multiSelect: false,
						options: [
							{ label: "EUR", description: "euro" },
							{ label: "USD", description: "dollar" },
						],
					},
				],
			},
			"claude-session",
			undefined,
		);

		expect(asked).toHaveBeenCalledOnce();
		expect(postedScopes).toEqual([]);
	});

	it("sanitizes the scope before it reaches the client", async () => {
		const { p, callback, postedScopes } = setup();
		p.scopeApprovals.recordOperatorNote(
			ISSUE_ID,
			"internal",
			"**Outcome** — see /root/.cyrus-community/worktrees/ws/ACM-10/README.md",
		);

		await callback(SCOPE_QUESTION, "claude-session", undefined);

		expect(postedScopes[0]).not.toContain("/root/");
		expect(postedScopes[0]).toContain("README.md");
	});
});
