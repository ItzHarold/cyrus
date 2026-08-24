import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * EdgeWorker wiring of verify-before-client-sees (PON-152).
 *
 * The properties under test: a gated completion is HELD, not posted; delivery
 * happens only on the operator's explicit action, PR-ready strictly before
 * the client summary; rejection tells the client nothing; the ladder only
 * ever gets louder.
 */

const GATED_WS = "gated-workspace-id";
const OPTOUT_WS = "optout-workspace-id";
const ISSUE_ID = "issue-uuid-0001";
const SESSION_ID = "agent-session-0001";
const MIRROR_ISSUE_ID = "mirror-issue-uuid";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function registerSession(worker: EdgeWorker, sessionId = SESSION_ID) {
	privates(worker).agentSessionManager.createCyrusAgentSession(
		sessionId,
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
	// The workspace is resolved from the session's repository, as at runtime.
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
		commentOnMirror: vi.fn().mockResolvedValue(undefined),
	};
	privates(worker).cockpitMirror = mirror;
	return mirror;
}

const SUMMARY =
	"All done. PR: https://github.com/acme/webapp/pull/42 — preview: https://webapp-git-x.vercel.app";

describe("EdgeWorker - verify-before-client-sees (PON-152)", () => {
	let worker: EdgeWorker;
	let mirror: ReturnType<typeof spyMirror>;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
		privates(worker).config.linearWorkspaces = {
			[GATED_WS]: { linearToken: "t1" },
			[OPTOUT_WS]: { linearToken: "t2", verifyBeforeDelivery: false },
		};
		// The gate requires a working approval surface: a configured cockpit
		// with a declared approver.
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

	const hold = (sessionId = SESSION_ID, content = SUMMARY, isError = false) =>
		privates(worker).holdCompletionForVerification(sessionId, content, isError);

	describe("suppress-and-store", () => {
		it("holds a gated delegated completion and mirrors in-verification", () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);

			expect(hold()).toBe(true);

			const record = privates(worker).verificationGate.get(ISSUE_ID);
			expect(record?.state).toBe("in-verification");
			expect(record?.summary).toBe(SUMMARY);
			expect(record?.prUrls).toEqual([
				"https://github.com/acme/webapp/pull/42",
			]);
			// Runner not running (none attached) → mirror transition fires here.
			expect(mirror.upsert).toHaveBeenCalledWith(
				expect.objectContaining({ issueId: ISSUE_ID }),
				GATED_WS,
				"in-verification",
				expect.objectContaining({ note: expect.stringContaining("pull/42") }),
			);
		});

		it("defers the mirror transition while the runner still streams", () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			const session =
				privates(worker).agentSessionManager.getSession(SESSION_ID);
			session.agentRunner = { isRunning: () => true };

			expect(hold()).toBe(true);
			expect(mirror.upsert).not.toHaveBeenCalled();

			// The runner's actual end lands the transition.
			privates(worker).handleLaneSessionEnded(SESSION_ID, "runner_complete");
			expect(mirror.upsert).toHaveBeenCalledWith(
				expect.objectContaining({ issueId: ISSUE_ID }),
				GATED_WS,
				"in-verification",
				expect.anything(),
			);
			expect(mirror.close).not.toHaveBeenCalled();
		});

		it("does not hold in an opted-out workspace", () => {
			registerSession(worker);
			privates(worker).repositories.get("repo-gated").linearWorkspaceId =
				OPTOUT_WS;
			expect(hold()).toBe(false);
			expect(privates(worker).verificationGate.get(ISSUE_ID)).toBeUndefined();
		});

		it("does not hold mention or child sessions", () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			privates(worker).mentionSessionIds.add(SESSION_ID);
			expect(hold()).toBe(false);

			privates(worker).mentionSessionIds.delete(SESSION_ID);
			privates(worker).globalSessionRegistry.setParentSession(
				SESSION_ID,
				"parent-1",
			);
			expect(hold()).toBe(false);
		});

		it("posts normally again after delivery", () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			hold();
			privates(worker).verificationGate.markDelivered(ISSUE_ID);
			expect(hold(SESSION_ID, "follow-up answer")).toBe(false);
		});

		it("the real interceptor suppresses the Linear sync", async () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			const asm = privates(worker).agentSessionManager;
			const sink = {
				postActivity: vi.fn().mockResolvedValue({ activityId: "a1" }),
				createAgentSession: vi.fn().mockResolvedValue("s1"),
			};
			asm.setActivitySink(SESSION_ID, sink);

			await asm.completeSession(SESSION_ID, {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: SUMMARY,
				total_cost_usd: 0,
				usage: { input_tokens: 1, output_tokens: 1 },
				session_id: "sdk-1",
			});

			// The completion summary never reached the client's thread…
			const responsePosts = sink.postActivity.mock.calls.filter((call) =>
				JSON.stringify(call[0]).includes(SUMMARY.slice(0, 20)),
			);
			expect(responsePosts).toHaveLength(0);
			// …and is held instead.
			expect(privates(worker).verificationGate.isPending(ISSUE_ID)).toBe(true);
		});
	});

	describe("delivery on approval", () => {
		beforeEach(() => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			hold();
			mirror.upsert.mockClear();
			// PR scoping: the session repo's origin, resolved without git.
			privates(worker).sessionRepoOriginRef = vi
				.fn()
				.mockResolvedValue({ owner: "acme", repo: "webapp" });
		});

		it("marks the PR ready BEFORE posting the client summary, then delivered", async () => {
			const order: string[] = [];
			privates(worker).mintGitHubTokenForRepo = vi.fn(async () => {
				return "gh-token";
			});
			const readySpy = vi.fn(async () => {
				order.push("pr-ready");
				return "ready";
			});
			// Patch the imported symbol via the worker's own indirection: stub
			// the module-level call through a wrapper on the instance.
			privates(worker).deliverVerifiedWork =
				privates(worker).deliverVerifiedWork.bind(worker);
			const asm = privates(worker).agentSessionManager;
			asm.postResponseActivityStrict = vi.fn(async () => {
				order.push("client-summary");
				return "activity-1";
			});

			// Replace markPullRequestReady used inside deliverVerifiedWork by
			// intercepting fetch (the helper's only IO).
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string, init: { body: string }) => {
					const { query } = JSON.parse(init.body) as { query: string };
					if (query.includes("markPullRequestReadyForReview")) {
						order.push("pr-ready");
						return {
							ok: true,
							status: 200,
							json: async () => ({
								data: {
									markPullRequestReadyForReview: {
										pullRequest: { isDraft: false },
									},
								},
							}),
						};
					}
					return {
						ok: true,
						status: 200,
						json: async () => ({
							data: {
								repository: {
									pullRequest: { id: "PR_1", isDraft: true },
								},
							},
						}),
					};
				}),
			);
			void readySpy;

			const report = await privates(worker).deliverVerifiedWork(ISSUE_ID);
			vi.unstubAllGlobals();

			expect(order).toEqual(["pr-ready", "client-summary"]);
			expect(report).toContain("marked ready");
			expect(report).toContain("Client summary posted");
			expect(privates(worker).verificationGate.get(ISSUE_ID)?.state).toBe(
				"delivered",
			);
			expect(mirror.upsert).toHaveBeenCalledWith(
				expect.objectContaining({ issueId: ISSUE_ID }),
				GATED_WS,
				"delivered",
			);
		});

		it("a failed summary post leaves the record pending and retryable — via the REAL strict post", async () => {
			privates(worker).mintGitHubTokenForRepo = vi.fn(async () => undefined);
			// No activity sink is registered for the session, so the REAL
			// postResponseActivityStrict throws — the lenient path would have
			// swallowed this and false-delivered (the review's critical
			// finding).
			const report = await privates(worker).deliverVerifiedWork(ISSUE_ID);

			expect(report).toContain("FAILED");
			expect(privates(worker).verificationGate.isPending(ISSUE_ID)).toBe(true);
		});

		it("delivery succeeds through the real strict post when a sink exists", async () => {
			privates(worker).mintGitHubTokenForRepo = vi.fn(async () => undefined);
			privates(worker).agentSessionManager.setActivitySink(SESSION_ID, {
				postActivity: vi.fn().mockResolvedValue({ activityId: "a-1" }),
				createAgentSession: vi.fn(),
			} as never);

			const report = await privates(worker).deliverVerifiedWork(ISSUE_ID);

			expect(report).toContain("Client summary posted");
			expect(privates(worker).verificationGate.get(ISSUE_ID)?.state).toBe(
				"delivered",
			);
		});

		it("a PR outside the session repository is never touched", async () => {
			privates(worker).verificationGate.get(ISSUE_ID).prUrls = [
				"https://github.com/client-b/platform/pull/99",
			];
			const mint = vi.fn(async () => "gh-token");
			privates(worker).mintGitHubTokenForRepo = mint;
			privates(worker).agentSessionManager.setActivitySink(SESSION_ID, {
				postActivity: vi.fn().mockResolvedValue({ activityId: "a-1" }),
				createAgentSession: vi.fn(),
			} as never);

			const report = await privates(worker).deliverVerifiedWork(ISSUE_ID);

			expect(mint).not.toHaveBeenCalled();
			expect(report).toContain("outside this session");
		});

		it("a replayed approval reports already-delivered and does nothing", async () => {
			privates(worker).mintGitHubTokenForRepo = vi.fn(async () => undefined);
			const strictPost = vi.fn(async () => "activity-1");
			privates(worker).agentSessionManager.postResponseActivityStrict =
				strictPost;
			await privates(worker).deliverVerifiedWork(ISSUE_ID);
			const postCalls = strictPost.mock.calls.length;

			const report = await privates(worker).deliverVerifiedWork(ISSUE_ID);

			expect(report).toContain("Already delivered");
			expect(strictPost.mock.calls).toHaveLength(postCalls);
		});
	});

	describe("rejection", () => {
		it("returns the work to the agent and tells the client nothing", async () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			hold();
			privates(worker).sessionRepositories.set(SESSION_ID, "repo-1");
			privates(worker).repositories.set("repo-1", {
				id: "repo-1",
				repositoryPath: "/test/repo",
				baseBranch: "main",
			});
			const resume = vi
				.spyOn(privates(worker), "resumeAgentSession" as never)
				.mockResolvedValue(undefined as never);
			const clientPost = vi.spyOn(
				privates(worker).agentSessionManager,
				"createResponseActivity",
			);

			const report = await privates(worker).rejectVerifiedWork(
				ISSUE_ID,
				"the export misses the header row",
			);

			expect(report).toContain("told nothing");
			expect(privates(worker).verificationGate.get(ISSUE_ID)).toBeUndefined();
			expect(resume).toHaveBeenCalledTimes(1);
			const prompt = resume.mock.calls[0]![4] as string;
			expect(prompt).toContain("the export misses the header row");
			expect(prompt).toContain("draft");
			expect(clientPost).not.toHaveBeenCalled();
			expect(mirror.upsert).toHaveBeenCalledWith(
				expect.objectContaining({ issueId: ISSUE_ID }),
				GATED_WS,
				"active",
			);
		});
	});

	describe("mirror-mention actions", () => {
		const mirrorWebhook = (body: string, actorId = "approver-user-id") =>
			({
				type: "AgentSessionEvent",
				action: "created",
				organizationId: "cockpit-ws",
				agentSession: {
					id: "mirror-session-1",
					issue: { id: MIRROR_ISSUE_ID, identifier: "PON-900" },
					comment: { body },
					creator: { id: actorId, name: "Approver" },
				},
			}) as never;
		const mirrorAction = (body: string, actorId = "approver-user-id") => ({
			organizationId: "cockpit-ws",
			mirrorSessionId: "mirror-session-1",
			actorId,
			actorName: "Approver",
			rawBody: body,
		});

		beforeEach(() => {
			mirror.clientIssueIdFor.mockImplementation((id: string) =>
				id === MIRROR_ISSUE_ID ? ISSUE_ID : undefined,
			);
			privates(worker).issueTrackers.set("cockpit-ws", {
				createAgentActivity: vi.fn().mockResolvedValue(undefined),
			});
		});

		it("a created webhook on a mirror issue is intercepted before any lane or runner work", async () => {
			const action = vi
				.spyOn(privates(worker), "handleMirrorAction" as never)
				.mockResolvedValue(undefined as never);
			const acquire = vi.spyOn(privates(worker).laneManager, "acquire");

			await privates(worker).handleAgentSessionCreatedWebhook(
				mirrorWebhook("@cyrussh approve"),
				[],
			);

			expect(action).toHaveBeenCalledWith(expect.anything(), ISSUE_ID);
			expect(acquire).not.toHaveBeenCalled();
		});

		it("approve delivers and replies with the report", async () => {
			const deliver = vi
				.spyOn(privates(worker), "deliverVerifiedWork" as never)
				.mockResolvedValue("✅ delivered" as never);

			await privates(worker).handleMirrorAction(
				mirrorAction("@cyrussh approve"),
				ISSUE_ID,
			);

			expect(deliver).toHaveBeenCalledWith(ISSUE_ID);
			const tracker = privates(worker).issueTrackers.get("cockpit-ws");
			expect(tracker.createAgentActivity).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.objectContaining({ body: "✅ delivered" }),
				}),
			);
		});

		it("reject with feedback routes to rejection", async () => {
			const reject = vi
				.spyOn(privates(worker), "rejectVerifiedWork" as never)
				.mockResolvedValue("sent back" as never);

			await privates(worker).handleMirrorAction(
				mirrorAction("@cyrussh reject: header row missing"),
				ISSUE_ID,
			);

			expect(reject).toHaveBeenCalledWith(ISSUE_ID, "header row missing");
		});

		it("reject without feedback asks for it, anything else gets usage help", async () => {
			const reject = vi.spyOn(privates(worker), "rejectVerifiedWork" as never);
			await privates(worker).handleMirrorAction(
				mirrorAction("@cyrussh reject:"),
				ISSUE_ID,
			);
			expect(reject).not.toHaveBeenCalled();

			await privates(worker).handleMirrorAction(
				mirrorAction("@cyrussh what is this?"),
				ISSUE_ID,
			);
			const tracker = privates(worker).issueTrackers.get("cockpit-ws");
			const bodies = tracker.createAgentActivity.mock.calls.map(
				(c: never[]) => (c[0] as { content: { body: string } }).content.body,
			);
			expect(bodies.some((b: string) => b.includes("feedback"))).toBe(true);
			expect(bodies.some((b: string) => b.includes("cockpit mirror"))).toBe(
				true,
			);
		});
	});

	describe("authorization and thread replies", () => {
		beforeEach(() => {
			mirror.clientIssueIdFor.mockImplementation((id: string) =>
				id === MIRROR_ISSUE_ID ? ISSUE_ID : undefined,
			);
			privates(worker).issueTrackers.set("cockpit-ws", {
				createAgentActivity: vi.fn().mockResolvedValue(undefined),
			});
		});
		const action = (body: string, actorId?: string, org = "cockpit-ws") => ({
			organizationId: org,
			mirrorSessionId: "mirror-session-1",
			actorId,
			actorName: "Someone",
			rawBody: body,
		});

		it("a non-approver cannot approve or reject", async () => {
			const deliver = vi.spyOn(
				privates(worker),
				"deliverVerifiedWork" as never,
			);
			await privates(worker).handleMirrorAction(
				action("approve", "client-guest-id"),
				ISSUE_ID,
			);
			expect(deliver).not.toHaveBeenCalled();
			const tracker = privates(worker).issueTrackers.get("cockpit-ws");
			expect(
				String(tracker.createAgentActivity.mock.calls[0]![0].content.body),
			).toContain("Only the configured approver");
		});

		it("a wrong-workspace webhook is refused outright", async () => {
			const deliver = vi.spyOn(
				privates(worker),
				"deliverVerifiedWork" as never,
			);
			await privates(worker).handleMirrorAction(
				action("approve", "approver-user-id", "tenant-ws"),
				ISSUE_ID,
			);
			expect(deliver).not.toHaveBeenCalled();
		});

		it("without a declared approver nothing can be delivered", async () => {
			privates(worker).config.cockpit.assigneeId = undefined;
			const deliver = vi.spyOn(
				privates(worker),
				"deliverVerifiedWork" as never,
			);
			await privates(worker).handleMirrorAction(
				action("approve", "approver-user-id"),
				ISSUE_ID,
			);
			expect(deliver).not.toHaveBeenCalled();
			const tracker = privates(worker).issueTrackers.get("cockpit-ws");
			expect(
				String(tracker.createAgentActivity.mock.calls[0]![0].content.body),
			).toContain("cockpit.assigneeId");
		});

		it("a REPLY in the mirror thread (prompted webhook) is intercepted too", async () => {
			const actionSpy = vi
				.spyOn(privates(worker), "handleMirrorAction" as never)
				.mockResolvedValue(undefined as never);
			await privates(worker).handleUserPromptedAgentActivity({
				type: "AgentSessionEvent",
				action: "prompted",
				organizationId: "cockpit-ws",
				agentSession: {
					id: "mirror-session-1",
					issue: { id: MIRROR_ISSUE_ID, identifier: "PON-900" },
					creator: { id: "approver-user-id", name: "Approver" },
				},
				agentActivity: { content: { body: "approve" } },
			} as never);
			expect(actionSpy).toHaveBeenCalledWith(
				expect.objectContaining({ rawBody: "approve" }),
				ISSUE_ID,
			);
		});
	});

	describe("scope and lifecycle guards", () => {
		it("non-Linear platform sessions are never held", () => {
			privates(worker).agentSessionManager.createCyrusAgentSession(
				"gh-session",
				"github:acme/webapp#12",
				{
					id: "github:acme/webapp#12",
					identifier: "acme/webapp#12",
					title: "PR question",
					description: "",
					branchName: "b",
				},
				{ path: "/test/repo", isGitWorktree: false },
				"github",
			);
			privates(worker).sessionRepositories.set("gh-session", "repo-gated");
			privates(worker).repositories.set("repo-gated", {
				id: "repo-gated",
				repositoryPath: "/test/repo",
				baseBranch: "main",
				linearWorkspaceId: GATED_WS,
			});
			expect(hold("gh-session", "PR answer")).toBe(false);
			expect(
				privates(worker).verificationGate.get("github:acme/webapp#12"),
			).toBeUndefined();
		});

		it("the gate is off when no cockpit is configured (no approval surface)", () => {
			registerSession(worker);
			privates(worker).config.cockpit = undefined;
			expect(hold()).toBe(false);
		});

		it("the mention marker survives session end and a restart", () => {
			registerSession(worker);
			privates(worker).mentionSessionIds.add(SESSION_ID);
			// The runner-already-stopped ordering: session end runs FIRST…
			privates(worker).handleLaneSessionEnded(SESSION_ID, "runner_complete");
			// …and the interceptor still sees the marker.
			expect(hold()).toBe(false);

			// Restart: the marker is persisted and restored.
			const state = worker.serializeMappings();
			expect(state.mentionSessionIds).toContain(SESSION_ID);
			const restored = createTestWorker([]);
			restored.restoreMappings(state);
			expect(privates(restored).mentionSessionIds.has(SESSION_ID)).toBe(true);
		});

		it("unassignment keeps a pending mirror alive instead of closing it", async () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			hold();
			privates(worker).postComment = vi.fn().mockResolvedValue(undefined);

			await privates(worker).handleIssueUnassigned(
				{ id: ISSUE_ID, identifier: "DVV-42" },
				GATED_WS,
			);

			expect(mirror.close).not.toHaveBeenCalled();
			expect(mirror.commentOnMirror).toHaveBeenCalledWith(
				ISSUE_ID,
				expect.stringContaining("unassigned"),
			);
			expect(privates(worker).verificationGate.isPending(ISSUE_ID)).toBe(true);
		});
	});

	describe("escalation ladder — louder, never delivering", () => {
		it("escalates once, delay-notes once, and never posts the summary", async () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			hold();
			// Age the record far past both thresholds.
			privates(worker).verificationGate.get(ISSUE_ID).completedAt = new Date(
				Date.now() - 48 * 3600_000,
			).toISOString();
			const clientComment = vi.fn().mockResolvedValue(undefined);
			privates(worker).issueTrackers.set(GATED_WS, {
				createComment: clientComment,
			});
			const summaryPost = vi.spyOn(
				privates(worker).agentSessionManager,
				"createResponseActivity",
			);

			await privates(worker).runVerificationLadder();
			await privates(worker).runVerificationLadder(); // second pass: no repeats

			expect(mirror.commentOnMirror).toHaveBeenCalledTimes(1);
			expect(clientComment).toHaveBeenCalledTimes(1);
			expect(String(clientComment.mock.calls[0]![1].body)).toContain(
				"longer than planned",
			);
			// The one rule: the ladder never delivers.
			expect(summaryPost).not.toHaveBeenCalled();
			expect(privates(worker).verificationGate.isPending(ISSUE_ID)).toBe(true);
		});
	});

	describe("admin endpoint and persistence", () => {
		it("GET /admin/verification counts pending work, loopback-only", async () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			hold();
			const routes: Record<string, (req: unknown, rep: unknown) => unknown> =
				{};
			privates(worker).sharedApplicationServer = {
				getFastifyInstance: () => ({
					get: (path: string, handler: never) => {
						routes[path] = handler;
					},
				}),
			};
			privates(worker).registerLanesEndpoint();

			const out: { code?: number; body?: unknown } = {};
			const rep = {
				status: (code: number) => ({
					send: (body: unknown) => {
						out.code = code;
						out.body = body;
					},
				}),
			};
			await routes["/admin/verification"]!(
				{ ip: "127.0.0.1", headers: {} },
				rep,
			);
			expect(out.code).toBe(200);
			expect((out.body as { pendingCount: number }).pendingCount).toBe(1);

			await routes["/admin/verification"]!(
				{ ip: "203.0.113.9", headers: {} },
				rep,
			);
			expect(out.code).toBe(404);
		});

		it("pending deliveries round-trip through serializeMappings/restoreMappings", () => {
			registerSession(worker);
			privates(worker).laneManager.acquire(GATED_WS, SESSION_ID);
			hold();

			const state = worker.serializeMappings();
			expect(state.pendingDeliveries?.[ISSUE_ID]?.state).toBe(
				"in-verification",
			);

			const restoredWorker = createTestWorker([]);
			restoredWorker.restoreMappings(state);
			expect(
				privates(restoredWorker).verificationGate.isPending(ISSUE_ID),
			).toBe(true);
		});
	});
});
