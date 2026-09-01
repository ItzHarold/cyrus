import type { RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Reviewer-triggered needs-info relay (v3.1 P2).
 *
 * The mirror session asks the client with the canonical `Missing info`
 * header; the question lands on the CLIENT's own thread and is parked under
 * the MIRROR session; the client's answer comes back into the mirror session
 * verbatim, with any files attached, and the reviewer is told. The client's
 * thread never runs work.
 *
 * Before this, `ask client:` needed a finished run (a verification record),
 * and the client's reply resumed the CLIENT session — a second runner on the
 * same branch, on the thread that must stay quiet.
 */

const CLIENT_WS = "ws-acme";
const COCKPIT_WS = "ws-cockpit";
const CLIENT_ISSUE = "issue-acm-13";
const MIRROR_ISSUE = "issue-ckp-9";
const CLIENT_SESSION = "sess-client";
const MIRROR_SESSION = "sess-mirror";
const HAROLD = "user-harold";

const repo: RepositoryConfig = {
	id: "repo-acme",
	name: "Acme-Metrics",
	repositoryPath: "/tmp/acme",
	workspaceBaseDir: "/tmp/acme-ws",
	baseBranch: "main",
	linearWorkspaceId: CLIENT_WS,
	linearToken: "t",
	isActive: true,
} as unknown as RepositoryConfig;

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

const CANONICAL = {
	question: "Which currency should the totals use?",
	header: "Missing info",
	options: [
		{ label: "Euros", description: "EUR everywhere" },
		{ label: "Local currency", description: "per customer" },
	],
	multiSelect: false,
};

function setup(opts: { held?: boolean } = {}) {
	const worker = createTestWorker([repo]);
	const p = privates(worker);
	const clientPosts: any[] = [];
	const cockpitPosts: any[] = [];
	const fetchComment = vi.fn().mockResolvedValue(null);
	p.issueTrackers.set(CLIENT_WS, {
		createAgentActivity: vi.fn(async (a: any) => {
			clientPosts.push(a);
			return { success: true };
		}),
		fetchComment,
	});
	p.issueTrackers.set(COCKPIT_WS, {
		createAgentActivity: vi.fn(async (a: any) => {
			cockpitPosts.push(a);
			return { success: true };
		}),
	});
	p.activitySinks.set(COCKPIT_WS, { postActivity: vi.fn() });
	p.activitySinks.set(CLIENT_WS, { postActivity: vi.fn() });
	p.config.cockpit = {
		linearWorkspaceId: COCKPIT_WS,
		workspaceName: "Ponte Digital",
		teamId: "team-ckp",
		reviewers: [HAROLD],
	};
	p.config.linearWorkspaces = {
		...p.config.linearWorkspaces,
		[CLIENT_WS]: {
			linearToken: "t",
			linearWorkspaceName: "Acme-Demo",
			anthropicAuth: { mode: "subscription" },
		},
		[COCKPIT_WS]: {
			linearToken: "t",
			linearWorkspaceName: "Ponte Digital",
			anthropicAuth: { mode: "subscription" },
		},
	};
	p.scopeApprovals.recordProposed(CLIENT_ISSUE, {
		workspaceId: CLIENT_WS,
		issueIdentifier: "ACM-13",
	});
	p.scopeApprovals.recordApproved(CLIENT_ISSUE);
	// The reviewer has started the run: the approval's parked flag is cleared
	// exactly as startWorkFromMirror clears it.
	p.scopeApprovals.markImplementationStarted(CLIENT_ISSUE);
	if (opts.held) {
		p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: CLIENT_WS,
			issueIdentifier: "ACM-13",
			sessionId: CLIENT_SESSION,
			summary: "Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/1",
			isError: false,
		});
	}
	p.cockpitMirror.mirrorIssueIdFor = vi.fn().mockReturnValue(MIRROR_ISSUE);
	p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);
	p.cockpitMirror.commentOnMirror = vi.fn().mockResolvedValue(undefined);
	p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
	p.savePersistedState = vi.fn().mockResolvedValue(undefined);
	p.handleNormalPromptedActivity = vi.fn();
	p.startWorkFromMirror = vi.fn().mockResolvedValue(undefined);
	p.runOperatorIteration = vi.fn().mockResolvedValue(undefined);
	const workspace = {
		path: "/tmp/acme-ws/ws-acme/ACM-13",
		isGitWorktree: true,
	};
	const issue = { id: CLIENT_ISSUE, identifier: "ACM-13", title: "Totals" };
	p.agentSessionManager.sessions.set(CLIENT_SESSION, {
		id: CLIENT_SESSION,
		issueId: CLIENT_ISSUE,
		issue,
		workspace,
		repositories: [],
	});
	p.agentSessionManager.entries.set(CLIENT_SESSION, []);
	p.agentSessionManager.sessions.set(MIRROR_SESSION, {
		id: MIRROR_SESSION,
		issueId: CLIENT_ISSUE,
		issue,
		workspace,
		repositories: [],
	});
	p.agentSessionManager.entries.set(MIRROR_SESSION, []);
	p.sessionRepositories.set(CLIENT_SESSION, repo.id);
	p.sessionRepositories.set(MIRROR_SESSION, repo.id);
	p.operatorSessions.register({
		mirrorSessionId: MIRROR_SESSION,
		mirrorIssueId: MIRROR_ISSUE,
		clientSessionId: CLIENT_SESSION,
		clientIssueId: CLIENT_ISSUE,
		clientIssueIdentifier: "ACM-13",
		clientWorkspaceId: CLIENT_WS,
		cockpitWorkspaceId: COCKPIT_WS,
		repositoryId: repo.id,
		startedAt: new Date().toISOString(),
		reviewerId: HAROLD,
	});
	return { p, clientPosts, cockpitPosts, fetchComment };
}

const answer = (body: string, sourceCommentId?: string) => ({
	type: "AgentSessionEvent",
	action: "prompted",
	organizationId: CLIENT_WS,
	agentSession: {
		id: CLIENT_SESSION,
		issue: { id: CLIENT_ISSUE, identifier: "ACM-13" },
	},
	agentActivity: {
		id: "act-1",
		content: { type: "prompt", body },
		...(sourceCommentId ? { sourceCommentId } : {}),
	},
});

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the mirror session asks the client", () => {
	it("posts the canonical ask on the CLIENT's thread and parks it under the MIRROR session", async () => {
		const { p, clientPosts, cockpitPosts } = setup();
		const cb = p.createAskUserQuestionCallback(MIRROR_SESSION, CLIENT_WS);
		const pending = cb(
			{ questions: [{ ...CANONICAL }] },
			"claude-x",
			new AbortController().signal,
		);
		await tick();

		const ask = clientPosts.find((a) => a.content.type === "elicitation");
		expect(ask).toBeDefined();
		expect(ask.agentSessionId).toBe(CLIENT_SESSION);
		expect(ask.content.body).toContain("Which currency");
		expect(cockpitPosts).toHaveLength(0);
		expect(p.askUserQuestionHandler.hasPendingQuestion(MIRROR_SESSION)).toBe(
			true,
		);
		expect(p.askUserQuestionHandler.hasPendingQuestion(CLIENT_SESSION)).toBe(
			false,
		);
		const wait = p.needsInfo.get(CLIENT_ISSUE);
		expect(wait.state).toBe("awaiting");
		expect(wait.relaySessionId).toBe(MIRROR_SESSION);
		expect(wait.relayWorkspaceId).toBe(COCKPIT_WS);
		expect(p.cockpitMirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: CLIENT_ISSUE }),
			CLIENT_WS,
			"needs-info",
		);
		p.askUserQuestionHandler.cancelPendingQuestion(MIRROR_SESSION, "test");
		await pending;
	});

	it("only the canonical header is relayed — any other question is not the client's", async () => {
		const { p, clientPosts } = setup();
		const cb = p.createAskUserQuestionCallback(MIRROR_SESSION, CLIENT_WS);
		const pending = cb(
			{ questions: [{ ...CANONICAL, header: "Approach" }] },
			"claude-x",
			new AbortController().signal,
		);
		await tick();

		expect(
			clientPosts.filter((a) => a.agentSessionId === CLIENT_SESSION),
		).toHaveLength(0);
		expect(p.needsInfo.get(CLIENT_ISSUE)).toBeUndefined();
		p.askUserQuestionHandler.cancelPendingQuestion(MIRROR_SESSION, "test");
		await pending;
	});

	it("refuses internal wording rather than sanitizing it onto the client's thread", async () => {
		const { p, clientPosts } = setup();
		const cb = p.createAskUserQuestionCallback(MIRROR_SESSION, CLIENT_WS);
		const result = await cb(
			{
				questions: [
					{
						...CANONICAL,
						question:
							"Should I change /root/cyrus/packages/edge-worker or the worktree?",
					},
				],
			},
			"claude-x",
			new AbortController().signal,
		);

		expect(result.answered).toBe(false);
		expect(result.message).toMatch(/rephrase/i);
		expect(clientPosts).toHaveLength(0);
		expect(p.needsInfo.get(CLIENT_ISSUE)).toBeUndefined();
	});
});

describe("the client answers", () => {
	it("resolves the parked question with their words unchanged, tells the reviewer, and never resumes the client thread", async () => {
		const { p, clientPosts, cockpitPosts } = setup();
		const cb = p.createAskUserQuestionCallback(MIRROR_SESSION, CLIENT_WS);
		const pending = cb(
			{ questions: [{ ...CANONICAL }] },
			"claude-x",
			new AbortController().signal,
		);
		await tick();
		const body =
			"Euros\n\nAnd please round to whole cents, our finance team asked.";

		await p.handleUserPromptedAgentActivity(answer(body));

		const result = await pending;
		expect(result.answered).toBe(true);
		expect(Object.values(result.answers)[0]).toBe(body);
		expect(p.handleNormalPromptedActivity).not.toHaveBeenCalled();
		expect(p.startWorkFromMirror).not.toHaveBeenCalled();
		// Reviewer register: the thread and the inbox, verbatim.
		const relayed = cockpitPosts.find(
			(a) => a.agentSessionId === MIRROR_SESSION,
		);
		expect(relayed.content.body).toContain(body);
		expect(p.cockpitMirror.commentOnMirror).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			expect.stringContaining("The client answered"),
		);
		// The client gets one acknowledgement and no work.
		const acks = clientPosts.filter((a) => a.content.type === "response");
		expect(acks).toHaveLength(1);
		expect(acks[0].content.body).toMatch(/back on it/);
		expect(p.needsInfo.get(CLIENT_ISSUE).state).toBe("answered");
		expect(p.cockpitMirror.upsert).toHaveBeenLastCalledWith(
			expect.objectContaining({ issueId: CLIENT_ISSUE }),
			CLIENT_WS,
			"active",
		);
	});

	it("carries their attachments along with their words", async () => {
		const { p, cockpitPosts, fetchComment } = setup();
		fetchComment.mockResolvedValue({
			body: "see the attached spec",
			user: Promise.resolve({ displayName: "Jo at Acme" }),
			createdAt: new Date(),
		});
		p.attachmentService.downloadCommentAttachments = vi.fn().mockResolvedValue({
			totalNewAttachments: 1,
			newAttachmentMap: { "spec.pdf": "/tmp/attachment_1.pdf" },
			newImageMap: {},
			failedCount: 0,
		});
		p.attachmentService.generateNewAttachmentManifest = vi
			.fn()
			.mockReturnValue("Attachments:\n- spec.pdf -> /tmp/attachment_1.pdf");
		const cb = p.createAskUserQuestionCallback(MIRROR_SESSION, CLIENT_WS);
		const pending = cb(
			{ questions: [{ ...CANONICAL }] },
			"claude-x",
			new AbortController().signal,
		);
		await tick();

		await p.handleUserPromptedAgentActivity(
			answer("see the attached spec", "c-1"),
		);

		const result = await pending;
		const text = Object.values(result.answers)[0] as string;
		expect(text).toContain("see the attached spec");
		expect(text).toContain("attachment_1.pdf");
		expect(
			cockpitPosts.find((a) => a.agentSessionId === MIRROR_SESSION).content
				.body,
		).toContain("Jo at Acme");
	});

	it("after a restart, resumes the mirror session through the delegation door with the answer", async () => {
		const { p } = setup();
		p.needsInfo.recordAsked(CLIENT_ISSUE, {
			question: CANONICAL.question,
			sessionId: CLIENT_SESSION,
			workspaceId: CLIENT_WS,
			issueIdentifier: "ACM-13",
			relaySessionId: MIRROR_SESSION,
			relayWorkspaceId: COCKPIT_WS,
		});

		await p.handleUserPromptedAgentActivity(answer("Euros"));

		expect(p.handleNormalPromptedActivity).not.toHaveBeenCalled();
		expect(p.startWorkFromMirror).toHaveBeenCalledWith(
			{ organizationId: COCKPIT_WS, mirrorSessionId: MIRROR_SESSION },
			CLIENT_ISSUE,
			{ instruction: expect.stringContaining("Euros") },
		);
	});

	it("after a restart on HELD work, iterates instead of starting", async () => {
		const { p } = setup({ held: true });
		p.needsInfo.recordAsked(CLIENT_ISSUE, {
			question: CANONICAL.question,
			sessionId: CLIENT_SESSION,
			workspaceId: CLIENT_WS,
			relaySessionId: MIRROR_SESSION,
			relayWorkspaceId: COCKPIT_WS,
		});

		await p.handleUserPromptedAgentActivity(answer("Euros"));

		expect(p.startWorkFromMirror).not.toHaveBeenCalled();
		expect(p.runOperatorIteration).toHaveBeenCalledWith(
			{ organizationId: COCKPIT_WS, mirrorSessionId: MIRROR_SESSION },
			CLIENT_ISSUE,
			expect.objectContaining({
				instruction: expect.stringContaining("Euros"),
			}),
		);
	});

	it("a wait with no relay target still takes the old path", async () => {
		// A pre-v3 ask (client session asked, no mirror) keeps resuming the
		// client session; the relay is only for questions the mirror asked.
		const { p } = setup();
		p.needsInfo.recordAsked(CLIENT_ISSUE, {
			question: "q",
			sessionId: CLIENT_SESSION,
			workspaceId: CLIENT_WS,
		});
		await p.handleUserPromptedAgentActivity(answer("Euros"));
		expect(p.startWorkFromMirror).not.toHaveBeenCalled();
		expect(p.handleNormalPromptedActivity).toHaveBeenCalled();
	});
});

describe("the reviewer's own `ask client:` mid-work", () => {
	it("reaches the client before any run has finished, and routes the answer to the mirror", async () => {
		const { p, clientPosts } = setup();
		await p.handleMirrorAction(
			{
				organizationId: COCKPIT_WS,
				mirrorSessionId: MIRROR_SESSION,
				actorId: HAROLD,
				actorName: "Harold",
				rawBody: "ask client: which currency should totals use?",
			},
			CLIENT_ISSUE,
		);
		const ask = clientPosts.find((a) => a.content.type === "elicitation");
		expect(ask).toBeDefined();
		expect(ask.agentSessionId).toBe(CLIENT_SESSION);
		expect(ask.content.body).toContain("Missing info");
		const wait = p.needsInfo.get(CLIENT_ISSUE);
		expect(wait.state).toBe("awaiting");
		expect(wait.relaySessionId).toBe(MIRROR_SESSION);
	});
});

describe("the waiting room", () => {
	it("lists a mid-work question beside the scope conversations", () => {
		const { p } = setup();
		const sync = vi.fn();
		p.scopeWaitingRoom = { sync };
		p.needsInfo.recordAsked(CLIENT_ISSUE, {
			question: CANONICAL.question,
			workspaceId: CLIENT_WS,
			issueIdentifier: "ACM-13",
			relaySessionId: MIRROR_SESSION,
		});
		p.syncScopeWaitingRoom();
		expect(sync).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ issueId: CLIENT_ISSUE, state: "needs-info" }),
			]),
		);
	});
});

describe("a client message while the mirror owns the run (finding G)", () => {
	function owned() {
		const ctx = setup();
		ctx.p.operatorSessions.register({
			...ctx.p.operatorSessions.get(MIRROR_SESSION),
			ownsDelivery: true,
		});
		return ctx;
	}

	it("reaches the reviewer, is acknowledged once, and never starts a run on the client's thread", async () => {
		const { p, clientPosts, cockpitPosts } = owned();

		await p.handleUserPromptedAgentActivity(answer("Any news on this?"));

		expect(p.handleNormalPromptedActivity).not.toHaveBeenCalled();
		expect(p.startWorkFromMirror).not.toHaveBeenCalled();
		const relayed = cockpitPosts.find(
			(a) => a.agentSessionId === MIRROR_SESSION,
		);
		expect(relayed.content.body).toContain("Any news on this?");
		expect(p.cockpitMirror.commentOnMirror).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			expect.stringContaining("wrote mid-work"),
		);
		const acks = clientPosts.filter((a) => a.content.type === "response");
		expect(acks).toHaveLength(1);
		expect(acks[0].content.body).toMatch(/working on this/);
	});

	it("still holds while the work is under review, not only while it runs", async () => {
		const { p } = owned();
		p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: CLIENT_WS,
			sessionId: MIRROR_SESSION,
			summary: "done https://github.com/o/r/pull/6",
			isError: false,
		});
		await p.handleUserPromptedAgentActivity(answer("Any news?"));
		expect(p.handleNormalPromptedActivity).not.toHaveBeenCalled();
	});

	it("after delivery, the client's thread keeps its own conversation", async () => {
		const { p } = owned();
		p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: CLIENT_WS,
			sessionId: MIRROR_SESSION,
			summary: "done https://github.com/o/r/pull/6",
			isError: false,
		});
		p.verificationGate.markDelivered(CLIENT_ISSUE);
		await p.handleUserPromptedAgentActivity(
			answer("Why did you do it this way?"),
		);
		expect(p.handleNormalPromptedActivity).toHaveBeenCalled();
	});
});
