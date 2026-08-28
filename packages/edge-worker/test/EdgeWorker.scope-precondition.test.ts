import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-188/196: the client is never asked to approve a scope they cannot read,
 * and the scope travels INSIDE the ask.
 *
 * Three surfaces were tried. Narration was suppressed and the client was asked
 * to approve nothing (PON-188, found live on ACM-10). A comment was readable
 * but left a trail on the client's thread (PON-192). The elicitation itself is
 * never collapsed, always visible in the panel, standalone in an email, and
 * leaves nothing behind.
 */

const WS = "ws-scope-precondition";
const SESSION_ID = "agent-session-scope-1";
const ISSUE_ID = "issue-scope-1";

const SCOPE_TEXT =
	"**Outcome** — the dashboard works on a phone.\n**You will receive** — a preview link and a PR to merge.";
/** Operator material the client must never see in the ask. */
const SCOPE_WITH_INTERPRETED = `${SCOPE_TEXT}\n\n**Interpreted** — I assumed the tables should scroll rather than shrink.`;

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

const SCOPE_QUESTION = () => ({
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
});

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

	// Any comment at all on a client thread is now a failure.
	const comments: unknown[][] = [];
	p.activityPoster.postComment = vi
		.fn()
		.mockImplementation(async (...args: unknown[]) => {
			comments.push(args);
			return true;
		});

	// The ask carries the scope, so the question text IS the delivery.
	const askedBodies: string[] = [];
	const asked = vi.fn().mockImplementation(async (input: any) => {
		askedBodies.push(input.questions[0].question);
		return { answered: true, answers: {} };
	});
	p.askUserQuestionHandler = { handleAskUserQuestion: asked };

	const callback = p.createAskUserQuestionCallback(SESSION_ID, WS);
	return { worker, p, callback, asked, askedBodies, comments };
}

describe("EdgeWorker - the scope travels inside the ask (PON-188/196)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("puts the scope in the question, ahead of the options, and posts no comment", async () => {
		const { p, callback, asked, askedBodies, comments } = setup();
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);

		await callback(SCOPE_QUESTION(), "claude-session", undefined);

		expect(asked).toHaveBeenCalledOnce();
		const body = askedBodies[0] as string;
		expect(body).toContain("**Outcome** — the dashboard works on a phone.");
		expect(body).toContain("**You will receive**");
		expect(body).toContain("Proceed?");
		// Opens with the scope, not with a pointer to something else.
		expect(body).toMatch(/^This is the scope for ACM-10 — Dashboard/);
		expect(body).not.toContain("above");
		// Zero comments on the client thread.
		expect(comments).toEqual([]);
		expect(p.scopeApprovals.get(ISSUE_ID).clientScopePosted).toBe(SCOPE_TEXT);
	});

	it("keeps the Interpreted section out of the client's ask", async () => {
		const { p, callback, askedBodies } = setup();
		p.scopeApprovals.recordOperatorNote(
			ISSUE_ID,
			"internal",
			SCOPE_WITH_INTERPRETED,
		);

		await callback(SCOPE_QUESTION(), "claude-session", undefined);

		const body = askedBodies[0] as string;
		expect(body).toContain("**Outcome**");
		expect(body).not.toContain("Interpreted");
		expect(body).not.toContain("I assumed");
		// The operator brief still holds the whole thing.
		expect(p.scopeApprovals.get(ISSUE_ID).clientScope).toBe(
			SCOPE_WITH_INTERPRETED,
		);
	});

	it("REFUSES to ask when no scope was recorded — nothing asked, nothing stamped", async () => {
		const { p, callback, asked, comments } = setup();

		const result = await callback(
			SCOPE_QUESTION(),
			"claude-session",
			undefined,
		);

		expect(asked).not.toHaveBeenCalled();
		expect(comments).toEqual([]);
		expect(result.answered).toBe(false);
		expect(result.message).toMatch(/client_scope/);
		// No proposal bookkeeping: the SLA clock and the cockpit state must not
		// move for a question the client never saw.
		expect(p.scopeApprovals.get(ISSUE_ID)).toBeUndefined();
		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
		expect(p.releaseLaneWhileAwaitingInput).not.toHaveBeenCalled();
	});

	it("carries the revised scope in the re-issued ask", async () => {
		const { p, callback, askedBodies } = setup();
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);
		await callback(SCOPE_QUESTION(), "claude-session", undefined);

		const revised =
			"**Outcome** — the dashboard works on a phone, navigation only.\n**You will receive** — a PR to merge.";
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal v2", revised);
		await callback(SCOPE_QUESTION(), "claude-session", undefined);

		expect(askedBodies).toHaveLength(2);
		expect(askedBodies[1]).toContain("navigation only");
		expect(askedBodies[1]).not.toContain("a preview link and a PR");
	});

	it("asks on a non-quiet workspace too — the ask is not narration", async () => {
		const { p, callback, asked, askedBodies } = setup({
			linearToken: "t",
			clientQuiet: false,
		});
		p.scopeApprovals.recordOperatorNote(ISSUE_ID, "internal", SCOPE_TEXT);

		await callback(SCOPE_QUESTION(), "claude-session", undefined);

		expect(asked).toHaveBeenCalledOnce();
		expect(askedBodies[0]).toContain("**Outcome**");
	});

	it("leaves a NON-gate question exactly as the session wrote it", async () => {
		const { callback, asked, askedBodies, comments } = setup();

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
		expect(askedBodies[0]).toBe("Missing info: which currency?");
		expect(comments).toEqual([]);
	});

	it("sanitizes the scope before it reaches the client", async () => {
		const { p, callback, askedBodies } = setup();
		p.scopeApprovals.recordOperatorNote(
			ISSUE_ID,
			"internal",
			"**Outcome** — see /root/.cyrus-community/worktrees/ws/ACM-10/README.md",
		);

		await callback(SCOPE_QUESTION(), "claude-session", undefined);

		expect(askedBodies[0]).not.toContain("/root/");
		expect(askedBodies[0]).toContain("README.md");
	});
});
