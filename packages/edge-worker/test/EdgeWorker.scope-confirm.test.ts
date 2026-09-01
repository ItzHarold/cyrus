import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import {
	SCOPE_APPROVE_LABEL,
	SCOPE_CANCEL_LABEL,
	SCOPE_REVISE_LABEL,
} from "../src/scope-confirm-gate.js";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

/**
 * EdgeWorker wiring of the scope-confirm gate (PON-150).
 *
 * The gate is intrinsic — a system-prompt step — with mechanical bookkeeping
 * around it. These tests exercise the seams: where the prompt block appears,
 * which lane-release reason a pre-approval wait records, how a structured
 * reply becomes an approval (and a replayed one does not move the clock), and
 * that the records survive serialize/restore.
 */

const GATED_WS = "gated-workspace-id";
const OPTOUT_WS = "optout-workspace-id";
const ISSUE_ID = "issue-uuid-0001";
const SESSION_ID = "agent-session-0001";

const issue = {
	id: ISSUE_ID,
	identifier: "DVV-42",
	title: "Add CSV export",
	description: "Customers want to export the table",
};

const session = {
	issueId: ISSUE_ID,
	workspace: { path: "/test/repo" },
	metadata: {},
};

const repository = {
	id: "repo-uuid-1",
	path: "/test/repo",
	linearWorkspaceId: GATED_WS,
};

const confirmQuestionInput = {
	questions: [
		{
			question: "Proceed with the scope as posted?",
			header: "Scope",
			options: [
				{ label: SCOPE_APPROVE_LABEL, description: "Start implementing" },
				{ label: SCOPE_REVISE_LABEL, description: "Revise the reading" },
				{ label: SCOPE_CANCEL_LABEL, description: "Stop here" },
			],
			multiSelect: false,
		},
	],
};

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

/** Register a live session in the worker's real AgentSessionManager. */
function registerSession(worker: EdgeWorker, workspaceId = GATED_WS) {
	const asm = (worker as never as Record<string, any>).agentSessionManager;
	asm.createCyrusAgentSession(
		SESSION_ID,
		ISSUE_ID,
		{
			id: ISSUE_ID,
			identifier: "DVV-42",
			title: issue.title,
			description: issue.description,
			branchName: "dvv-42",
		},
		{ path: "/test/repo", isGitWorktree: false },
	);
	void workspaceId;
}

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

describe("EdgeWorker - scope-confirm gate (PON-150)", () => {
	let worker: EdgeWorker;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
		// The scenario helper auto-creates linearWorkspaces entries; make the
		// two this file needs explicit.
		privates(worker).config.linearWorkspaces = {
			[GATED_WS]: { linearToken: "t1" }, // no scopeConfirmGate → default ON
			[OPTOUT_WS]: { linearToken: "t2", scopeConfirmGate: false },
		};
		// Persistence is a real manager pointed at a real path in these
		// worker fixtures — stub the save so bookkeeping persists in-memory.
		privates(worker).savePersistedStateStrict = vi
			.fn()
			.mockResolvedValue(undefined);
	});

	describe("system prompt injection", () => {
		it("appends the gate block for a delegated session in a gated workspace", async () => {
			const result = await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepository(repository)
				.withLinearWorkspaceId(GATED_WS)
				.withUserComment("")
				.withLabels()
				.build();

			expect(result.systemPrompt).toContain("<scope_confirm_gate>");
			expect(result.systemPrompt).toContain(SCOPE_APPROVE_LABEL);
		});

		it("does not gate an opted-out workspace", async () => {
			const result = await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepository({ ...repository, linearWorkspaceId: OPTOUT_WS })
				.withLinearWorkspaceId(OPTOUT_WS)
				.withUserComment("")
				.withLabels()
				.build();

			expect(result.systemPrompt).not.toContain("<scope_confirm_gate>");
		});

		it("does not gate a session with no workspace id (legacy path)", async () => {
			const result = await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepository(repository)
				.withUserComment("")
				.withLabels()
				.build();

			expect(result.systemPrompt).not.toContain("<scope_confirm_gate>");
		});

		it("does not re-ask on an issue whose scope is already approved", async () => {
			privates(worker).scopeApprovals.recordApproved(ISSUE_ID);

			const result = await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepository(repository)
				.withLinearWorkspaceId(GATED_WS)
				.withUserComment("")
				.withLabels()
				.build();

			expect(result.systemPrompt).not.toContain("<scope_confirm_gate>");
		});

		it("a mention while a delegated flow is mid-gate gets the block — no ungated side door", async () => {
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
				workspaceId: GATED_WS,
			});

			const result = await scenario(worker)
				.newSession()
				.withMentionTriggered(true)
				.withSession(session)
				.withIssue(issue)
				.withRepository(repository)
				.withLinearWorkspaceId(GATED_WS)
				.withAgentSession({ id: SESSION_ID })
				.withUserComment("@agent please also rename the column")
				.withLabels()
				.build();

			expect(result.systemPrompt).toContain("<scope_confirm_gate>");
		});

		it("mentions stay conversational — no gate block", async () => {
			const result = await scenario(worker)
				.newSession()
				.withMentionTriggered(true)
				.withSession(session)
				.withIssue(issue)
				.withRepository(repository)
				.withLinearWorkspaceId(GATED_WS)
				.withAgentSession({ id: SESSION_ID })
				.withUserComment("@agent what does this file do?")
				.withLabels()
				.build();

			expect(result.systemPrompt).not.toContain("<scope_confirm_gate>");
		});

		it("child sessions work inside the parent's approved scope — no gate block", async () => {
			privates(worker).globalSessionRegistry.setParentSession(
				SESSION_ID,
				"parent-session-id",
			);

			const result = await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepository(repository)
				.withLinearWorkspaceId(GATED_WS)
				.withAgentSession({ id: SESSION_ID })
				.withUserComment("")
				.withLabels()
				.build();

			expect(result.systemPrompt).not.toContain("<scope_confirm_gate>");
		});
	});

	describe("lane release reason", () => {
		it("releases with awaiting_scope_confirm while the issue is unapproved", () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			const release = vi.spyOn(
				privates(worker),
				"releaseLaneAndContinue" as never,
			);

			privates(worker).releaseLaneWhileAwaitingInput(SESSION_ID);

			expect(release).toHaveBeenCalledWith(
				GATED_WS,
				SESSION_ID,
				"awaiting_scope_confirm",
			);
		});

		it("releases with awaiting_user_input once the scope is approved", () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordApproved(ISSUE_ID);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			const release = vi.spyOn(
				privates(worker),
				"releaseLaneAndContinue" as never,
			);

			privates(worker).releaseLaneWhileAwaitingInput(SESSION_ID);

			expect(release).toHaveBeenCalledWith(
				GATED_WS,
				SESSION_ID,
				"awaiting_user_input",
			);
		});

		it("releases with awaiting_user_input in an opted-out workspace", () => {
			registerSession(worker, OPTOUT_WS);
			privates(worker).laneManager.acquire(OPTOUT_WS, SESSION_ID);
			const release = vi.spyOn(
				privates(worker),
				"releaseLaneAndContinue" as never,
			);

			privates(worker).releaseLaneWhileAwaitingInput(SESSION_ID);

			expect(release).toHaveBeenCalledWith(
				OPTOUT_WS,
				SESSION_ID,
				"awaiting_user_input",
			);
		});
	});

	describe("proposal recording at AskUserQuestion time", () => {
		it("records the proposal when the confirmation ask is posted", async () => {
			registerSession(worker);
			// PON-188/191: the ask is refused unless the client scope has
			// reached the client, so a recorded client_scope is now part of
			// getting this far. The comment post itself is stubbed — this
			// case is about the proposal record, not the surface.
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
				confirmQuestionInput,
				"claude-session-id",
				new AbortController().signal,
			);

			const record = privates(worker).scopeApprovals.get(ISSUE_ID);
			expect(record?.state).toBe("awaiting");
			expect(record?.workspaceId).toBe(GATED_WS);
			expect(privates(worker).savePersistedStateStrict).toHaveBeenCalled();
		});

		it("registers an ambiguity elicitation WITHOUT making it the proposal", async () => {
			// Changed deliberately after FRO-65 (see packages/CLAUDE.md): this
			// used to record nothing at all, which left a session waiting at
			// `awaitingInput` on no operator register — the exact failure the
			// waiting room exists to prevent.
			//
			// The guarantee this test was written for is unchanged and still
			// asserted below: a non-canonical question must never be treated as
			// the gate's PROPOSAL. It does not stamp the SLA clock, does not
			// approve, and does not mark a client scope as posted — only the
			// canonical `Approve scope` option can do those. What it now does is
			// make the conversation visible.
			registerSession(worker);
			const callback = privates(worker).createAskUserQuestionCallback(
				SESSION_ID,
				GATED_WS,
			);
			await callback(
				{
					questions: [
						{
							question: "Which environment?",
							header: "Env",
							options: [
								{ label: "Staging", description: "staging" },
								{ label: "Production", description: "production" },
							],
							multiSelect: false,
						},
					],
				},
				"claude-session-id",
				new AbortController().signal,
			);

			const record = privates(worker).scopeApprovals.get(ISSUE_ID);
			expect(record?.state).toBe("awaiting");
			// The protections this test was originally written for.
			expect(record?.approvedAt).toBeUndefined();
			expect(privates(worker).scopeApprovals.isApproved(ISSUE_ID)).toBe(false);
			expect(record?.clientScopePosted).toBeUndefined();
		});
	});

	describe("reply interpretation", () => {
		it("records approval — the SLA clock — when the posted Approve option is chosen", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
				workspaceId: GATED_WS,
			});
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_APPROVE_LABEL),
			);

			const record = privates(worker).scopeApprovals.get(ISSUE_ID);
			expect(record?.state).toBe("approved");
			expect(record?.approvedAt).toBeTruthy();
			expect(privates(worker).savePersistedStateStrict).toHaveBeenCalledTimes(
				1,
			);
		});

		it("a replayed answer webhook does not move the clock or re-persist", async () => {
			registerSession(worker);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_APPROVE_LABEL),
			);
			const approvedAt =
				privates(worker).scopeApprovals.get(ISSUE_ID)?.approvedAt;

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_APPROVE_LABEL),
			);

			expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.approvedAt).toBe(
				approvedAt,
			);
			expect(privates(worker).savePersistedStateStrict).toHaveBeenCalledTimes(
				1,
			);
		});

		it("records a revision request without approving", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_REVISE_LABEL),
			);

			const record = privates(worker).scopeApprovals.get(ISSUE_ID);
			expect(record?.state).toBe("revised");
			expect(record?.revisions).toBe(1);
			expect(record?.approvedAt).toBeUndefined();
		});

		it("free text changes nothing mechanically", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook("sounds good but what about X"),
			);

			expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.state).toBe(
				"awaiting",
			);
		});

		it("an ambiguity answer is not an approval even while the gate is pending", async () => {
			registerSession(worker);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi.fn().mockReturnValue({
					question: "Which environment?",
					header: "Env",
					options: [
						{ label: "Staging", description: "s" },
						{ label: "Production", description: "p" },
					],
					multiSelect: false,
				}),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook("Staging"),
			);

			expect(privates(worker).scopeApprovals.isApproved(ISSUE_ID)).toBe(false);
		});

		it("restart fallback: a canonical approval with no pending question still records", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi.fn().mockReturnValue(null),
				hasPendingQuestion: vi.fn().mockReturnValue(false),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook("Approve scope"),
			);

			expect(privates(worker).scopeApprovals.isApproved(ISSUE_ID)).toBe(true);
		});

		it("restart fallback: free text never approves", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi.fn().mockReturnValue(null),
				hasPendingQuestion: vi.fn().mockReturnValue(false),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook("yes go ahead"),
			);

			expect(privates(worker).scopeApprovals.isApproved(ISSUE_ID)).toBe(false);
		});

		it("does nothing for an opted-out workspace", async () => {
			registerSession(worker, OPTOUT_WS);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			const webhook = {
				...(promptedWebhook(SCOPE_APPROVE_LABEL) as Record<string, unknown>),
				organizationId: OPTOUT_WS,
			};
			await privates(worker).interpretScopeConfirmReply(webhook);

			expect(privates(worker).scopeApprovals.get(ISSUE_ID)).toBeUndefined();
		});
	});

	describe("reply interpretation — cancel and guards", () => {
		it("Cancel removes the record: the pending list stays honest, re-delegation re-gates", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
				workspaceId: GATED_WS,
			});
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_CANCEL_LABEL),
			);

			expect(privates(worker).scopeApprovals.get(ISSUE_ID)).toBeUndefined();
			expect(privates(worker).savePersistedStateStrict).toHaveBeenCalledTimes(
				1,
			);

			// Replay: nothing left to remove, no second persist.
			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_CANCEL_LABEL),
			);
			expect(privates(worker).savePersistedStateStrict).toHaveBeenCalledTimes(
				1,
			);
		});

		it("a late answer after terminal cleanup resurrects nothing", async () => {
			registerSession(worker);
			// Terminal cleanup already removed the record; the pending
			// question died with the session. The webhook arrives late.
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi.fn().mockReturnValue(null),
				hasPendingQuestion: vi.fn().mockReturnValue(false),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook("Approve scope"),
			);

			expect(privates(worker).scopeApprovals.get(ISSUE_ID)).toBeUndefined();
			expect(privates(worker).savePersistedStateStrict).not.toHaveBeenCalled();
		});

		it("a replayed revise webhook does not inflate the revision count", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			privates(worker).askUserQuestionHandler = {
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				hasPendingQuestion: vi.fn().mockReturnValue(true),
			};

			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_REVISE_LABEL),
			);
			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_REVISE_LABEL),
			);

			expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.revisions).toBe(1);
			expect(privates(worker).savePersistedStateStrict).toHaveBeenCalledTimes(
				1,
			);
		});
	});

	describe("real AskUserQuestion handler lifecycle", () => {
		it("resolves the reply against the really-posted question, end to end", async () => {
			registerSession(worker);
			// PON-188/196: a recorded client_scope is a precondition of the
			// ask, and the scope travels inside the elicitation body — so the
			// posted activity is the thing to inspect.
			const createAgentActivity = vi.fn().mockResolvedValue(undefined);
			privates(worker).issueTrackers.set(GATED_WS, { createAgentActivity });
			privates(worker).scopeApprovals.recordOperatorNote(
				ISSUE_ID,
				"internal reading",
				"**Outcome** — the thing works.",
			);

			const callback = privates(worker).createAskUserQuestionCallback(
				SESSION_ID,
				GATED_WS,
			);
			const answerPromise = callback(
				confirmQuestionInput,
				"claude-session-id",
				new AbortController().signal,
			);
			// Wait for the elicitation to post and the pending question to arm.
			await vi.waitFor(() => {
				expect(
					privates(worker).askUserQuestionHandler.hasPendingQuestion(
						SESSION_ID,
					),
				).toBe(true);
			});
			expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.state).toBe(
				"awaiting",
			);
			// The scope reached the client inside the ask itself — no comment.
			const elicitation = createAgentActivity.mock.calls.find(
				(c) => c[0]?.content?.type === "elicitation",
			);
			expect(elicitation?.[0]?.content?.body).toContain(
				"**Outcome** — the thing works.",
			);
			expect(elicitation?.[0]?.content?.body).toContain("Proceed?");

			// The client's structured reply, interpreted against the REAL
			// pending question held by the REAL handler.
			await privates(worker).interpretScopeConfirmReply(
				promptedWebhook(SCOPE_APPROVE_LABEL),
			);
			expect(privates(worker).scopeApprovals.isApproved(ISSUE_ID)).toBe(true);

			privates(worker).askUserQuestionHandler.handleUserResponse(
				SESSION_ID,
				SCOPE_APPROVE_LABEL,
			);
			const result = await answerPromise;
			expect(result.answered).toBe(true);
		});
	});

	describe("resume re-injection", () => {
		const stubResumeCollaborators = () => {
			const captured: unknown[][] = [];
			privates(worker).fetchFullIssueDetails = vi
				.fn()
				.mockResolvedValue({ id: ISSUE_ID, identifier: "DVV-42" });
			privates(worker).fetchIssueLabels = vi.fn().mockResolvedValue([]);
			privates(worker).determineSystemPromptFromLabels = vi
				.fn()
				.mockResolvedValue(undefined);
			privates(worker).gitService = {
				getGitMetadataDirectoriesForWorkspace: () => [],
			};
			privates(worker).cyrusHome =
				"/tmp/claude-0/scope-confirm-test-cyrus-home";
			// PON-164: resume validates the workspace is a real checkout;
			// the fixture session's path is synthetic, so satisfy the
			// re-creation with a real one.
			const fresh = mkdtempSync(join(tmpdir(), "scope-resume-ws-"));
			mkdirSync(join(fresh, ".git"));
			privates(worker).config.handlers = {
				createWorkspace: vi
					.fn()
					.mockResolvedValue({ path: fresh, isGitWorktree: true }),
			};
			privates(worker).savePersistedState = vi
				.fn()
				.mockResolvedValue(undefined);
			privates(worker).buildAgentRunnerConfig = vi.fn(
				async (...args: unknown[]) => {
					captured.push(args);
					throw new Error("STOP_AFTER_CAPTURE");
				},
			);
			return captured;
		};

		it("a resumed session gets the gate block back while the gate is pending", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			const captured = stubResumeCollaborators();
			const asm = privates(worker).agentSessionManager;

			await expect(
				worker.resumeAgentSession(
					asm.getSession(SESSION_ID),
					{
						id: "repo-uuid-1",
						repositoryPath: "/test/repo",
						workspaceBaseDir: "/test/ws",
						baseBranch: "main",
						linearWorkspaceId: GATED_WS,
					} as never,
					SESSION_ID,
					asm,
					"Approve scope",
					"",
					false,
					[],
					GATED_WS,
				),
			).rejects.toThrow("STOP_AFTER_CAPTURE");

			// buildAgentRunnerConfig's 4th argument is the system prompt.
			expect(String(captured[0]?.[3])).toContain("<scope_confirm_gate>");
		});

		it("a resumed session on an approved issue gets no block", async () => {
			registerSession(worker);
			privates(worker).scopeApprovals.recordApproved(ISSUE_ID);
			const captured = stubResumeCollaborators();
			const asm = privates(worker).agentSessionManager;

			await expect(
				worker.resumeAgentSession(
					asm.getSession(SESSION_ID),
					{
						id: "repo-uuid-1",
						repositoryPath: "/test/repo",
						workspaceBaseDir: "/test/ws",
						baseBranch: "main",
						linearWorkspaceId: GATED_WS,
					} as never,
					SESSION_ID,
					asm,
					"thanks",
					"",
					false,
					[],
					GATED_WS,
				),
			).rejects.toThrow("STOP_AFTER_CAPTURE");

			// The R2 client-surface rules are always appended on resume; only
			// the scope gate must be absent for an approved issue.
			expect(String(captured[0]?.[3])).not.toContain("<scope_confirm_gate>");
			expect(String(captured[0]?.[3])).toContain("<client_surface_rules>");
		});
	});

	describe("admin endpoint", () => {
		const registerAndCapture = () => {
			const routes: Record<
				string,
				(request: unknown, reply: unknown) => Promise<unknown>
			> = {};
			privates(worker).sharedApplicationServer = {
				getFastifyInstance: () => ({
					get: (path: string, handler: never) => {
						routes[path] = handler;
					},
				}),
			};
			privates(worker).registerLanesEndpoint();
			return routes;
		};
		const reply = () => {
			const out: { code?: number; body?: unknown } = {};
			return {
				out,
				reply: {
					status: (code: number) => ({
						send: (body: unknown) => {
							out.code = code;
							out.body = body;
							return out;
						},
					}),
				},
			};
		};

		it("lists open gates with ages for loopback requests", async () => {
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
				workspaceId: GATED_WS,
				issueIdentifier: "DVV-42",
			});
			const routes = registerAndCapture();
			expect(routes["/admin/scope-approvals"]).toBeDefined();

			const { out, reply: rep } = reply();
			await routes["/admin/scope-approvals"]!(
				{ ip: "127.0.0.1", headers: {} },
				rep,
			);

			expect(out.code).toBe(200);
			const body = out.body as {
				pending: Array<{ issueId: string; awaitingForMs: number }>;
			};
			expect(body.pending).toHaveLength(1);
			expect(body.pending[0]!.issueId).toBe(ISSUE_ID);
			expect(body.pending[0]!.awaitingForMs).toBeGreaterThanOrEqual(0);
		});

		it("is invisible to non-loopback and proxied requests", async () => {
			const routes = registerAndCapture();

			const remote = reply();
			await routes["/admin/scope-approvals"]!(
				{ ip: "203.0.113.9", headers: {} },
				remote.reply,
			);
			expect(remote.out.code).toBe(404);

			const proxied = reply();
			await routes["/admin/scope-approvals"]!(
				{ ip: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4" } },
				proxied.reply,
			);
			expect(proxied.out.code).toBe(404);
		});
	});

	describe("prompted-webhook wiring", () => {
		it("branch 2.5 interprets the reply BEFORE lane admission", async () => {
			registerSession(worker);
			const order: string[] = [];
			privates(worker).askUserQuestionHandler = {
				hasPendingQuestion: vi.fn().mockReturnValue(true),
				getPendingQuestion: vi
					.fn()
					.mockReturnValue(confirmQuestionInput.questions[0]),
				handleUserResponse: vi.fn().mockReturnValue(true),
			};
			const interpretSpy = vi
				.spyOn(privates(worker), "interpretScopeConfirmReply" as never)
				.mockImplementation(async () => {
					order.push("interpret");
				});
			vi.spyOn(
				privates(worker),
				"admitAnsweredSessionToLane" as never,
			).mockImplementation(async () => {
				order.push("admit");
				return true;
			});
			vi.spyOn(
				privates(worker),
				"handleAskUserQuestionResponse" as never,
			).mockResolvedValue(undefined as never);

			await privates(worker).handleUserPromptedAgentActivity(
				promptedWebhook(SCOPE_APPROVE_LABEL),
			);

			expect(interpretSpy).toHaveBeenCalledTimes(1);
			expect(order).toEqual(["interpret", "admit"]);
		});

		it("a prompt on a lane-queued session is still interpreted", async () => {
			registerSession(worker);
			privates(worker).laneManager.enqueue(GATED_WS, {
				sessionId: SESSION_ID,
				enqueuedAt: new Date().toISOString(),
				webhook: {},
			});
			const interpretSpy = vi
				.spyOn(privates(worker), "interpretScopeConfirmReply" as never)
				.mockResolvedValue(undefined as never);

			await privates(worker).handleUserPromptedAgentActivity(
				promptedWebhook("Approve scope"),
			);

			expect(interpretSpy).toHaveBeenCalledTimes(1);
		});

		it("the restart fallback runs when no question is pending", async () => {
			registerSession(worker);
			privates(worker).askUserQuestionHandler = {
				hasPendingQuestion: vi.fn().mockReturnValue(false),
				getPendingQuestion: vi.fn().mockReturnValue(null),
			};
			const interpretSpy = vi
				.spyOn(privates(worker), "interpretScopeConfirmReply" as never)
				.mockResolvedValue(undefined as never);
			// Stop the flow right after the fallback: Branch 3 needs full
			// session/repo state that is not under test here.
			vi.spyOn(
				privates(worker),
				"handleNormalPromptedActivity" as never,
			).mockResolvedValue(undefined as never);

			await privates(worker)
				.handleUserPromptedAgentActivity(promptedWebhook("Approve scope"))
				.catch(() => {
					// Branch 3's downstream requirements are not under test.
				});

			expect(interpretSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("persistence", () => {
		it("scope approvals round-trip through serializeMappings/restoreMappings", () => {
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID, {
				workspaceId: GATED_WS,
				issueIdentifier: "DVV-42",
			});
			privates(worker).scopeApprovals.recordApproved("other-issue");

			const state = worker.serializeMappings();
			expect(state.scopeApprovals?.[ISSUE_ID]?.state).toBe("awaiting");
			expect(state.scopeApprovals?.["other-issue"]?.state).toBe("approved");

			const restoredWorker = createTestWorker([]);
			restoredWorker.restoreMappings(state);
			expect(privates(restoredWorker).scopeApprovals.get(ISSUE_ID)?.state).toBe(
				"awaiting",
			);
			expect(
				privates(restoredWorker).scopeApprovals.isApproved("other-issue"),
			).toBe(true);
		});

		it("state files without scopeApprovals restore to an empty store", () => {
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			worker.restoreMappings({});
			expect(privates(worker).scopeApprovals.size).toBe(0);
		});
	});

	describe("terminal cleanup", () => {
		it("removes the gate record when the issue reaches a terminal state", async () => {
			privates(worker).scopeApprovals.recordProposed(ISSUE_ID);
			privates(worker).gitService = {
				deleteWorktree: vi.fn().mockResolvedValue(undefined),
			};

			await privates(worker).handleIssueStateChangeMessage({
				workItemId: ISSUE_ID,
				workItemIdentifier: "DVV-42",
			});

			expect(privates(worker).scopeApprovals.get(ISSUE_ID)).toBeUndefined();
			expect(privates(worker).savePersistedStateStrict).toHaveBeenCalled();
		});
	});
});
