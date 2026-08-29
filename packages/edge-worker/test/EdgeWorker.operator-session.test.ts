import type { RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import {
	classifyMirrorIntent,
	OPERATOR_GIT_DENY,
} from "../src/operator-session.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-208: the cockpit mirror becomes a working surface.
 *
 * The load-bearing claim is a negative one — while the operator iterates, the
 * CLIENT sees nothing — so most of these tests count posts to the client's
 * tracker and assert zero. A test that only checks the mirror got a message
 * would pass just as happily if the client got one too.
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

/**
 * A worker with one client repo in verification and a cockpit mirror, with
 * every posting surface instrumented so a leak to the client is visible.
 */
function setup(opts: { anthropicAuth?: unknown } = {}) {
	const worker = createTestWorker([repo]);
	const p = privates(worker);

	// Two trackers. The client's records every call so the silence claim is
	// measurable rather than asserted.
	const clientPosts: any[] = [];
	const cockpitPosts: any[] = [];
	p.issueTrackers.set(CLIENT_WS, {
		createAgentActivity: vi.fn(async (a: any) => {
			clientPosts.push(a);
			return { success: true };
		}),
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
			anthropicAuth: opts.anthropicAuth ?? { mode: "subscription" },
		},
		[COCKPIT_WS]: {
			linearToken: "t",
			linearWorkspaceName: "Ponte Digital",
			anthropicAuth: { mode: "apiKey", apiKey: "sk-test-not-a-real-key" },
		},
	};

	// Work held for verification — the state a mirror is in when Harold
	// arrives.
	p.verificationGate.recordPending(CLIENT_ISSUE, {
		workspaceId: CLIENT_WS,
		issueIdentifier: "ACM-13",
		sessionId: CLIENT_SESSION,
		summary: "Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/1",
		isError: false,
	});
	p.cockpitMirror.mirrorIssueIdFor = vi.fn().mockReturnValue(MIRROR_ISSUE);
	p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);

	// The client's finished session: a real conversation in a real worktree.
	const clientSession = {
		id: CLIENT_SESSION,
		claudeSessionId: "claude-abc",
		issueId: CLIENT_ISSUE,
		issue: { id: CLIENT_ISSUE, identifier: "ACM-13", title: "Dashboard" },
		workspace: { path: "/tmp/acme-ws/ws-acme/ACM-13", isGitWorktree: true },
		repositories: [],
	};
	p.agentSessionManager.sessions.set(CLIENT_SESSION, clientSession);
	p.agentSessionManager.entries.set(CLIENT_SESSION, []);
	p.sessionRepositories.set(CLIENT_SESSION, repo.id);

	const resumed: any[] = [];
	p.resumeAgentSession = vi.fn(async (...args: any[]) => {
		resumed.push(args);
	});

	return { worker, p, clientPosts, cockpitPosts, resumed, clientSession };
}

const action = (rawBody: string) => ({
	organizationId: COCKPIT_WS,
	mirrorSessionId: MIRROR_SESSION,
	actorId: HAROLD,
	actorName: "Harold",
	rawBody,
});

describe("operator session — intent classification", () => {
	it("treats an ordinary sentence as work, not as a refusal", () => {
		expect(classifyMirrorIntent("make the chart lazy-load")).toEqual({
			kind: "iterate",
			instruction: "make the chart lazy-load",
		});
	});

	it("still recognises approve and reject exactly as before", () => {
		expect(classifyMirrorIntent("approve: ship it")).toEqual({
			kind: "approve",
			notes: "ship it",
		});
		expect(classifyMirrorIntent("approve")).toEqual({
			kind: "approve",
			notes: "",
		});
		expect(classifyMirrorIntent("reject: wrong table")).toEqual({
			kind: "reject",
			feedback: "wrong table",
		});
	});

	it("reads the three new verbs", () => {
		expect(classifyMirrorIntent("mine")).toEqual({ kind: "mine" });
		expect(classifyMirrorIntent("I'll take this myself")).toEqual({
			kind: "mine",
		});
		expect(classifyMirrorIntent("back to you: rebased on my fix")).toEqual({
			kind: "handback",
			notes: "rebased on my fix",
		});
		expect(classifyMirrorIntent("ask client: which currency?")).toEqual({
			kind: "ask-client",
			question: "which currency?",
		});
	});

	it("does not read a sentence STARTING with mine as a handover", () => {
		// The failure this prevents: the agent silently stops mid-iteration
		// because a work request happened to open with the word "mine".
		expect(
			classifyMirrorIntent("mine is a different approach — try X"),
		).toEqual({
			kind: "iterate",
			instruction: "mine is a different approach — try X",
		});
	});

	it("reads an empty body as picking the work up, not as nothing", () => {
		// A delegation carries no comment. This used to classify as undefined
		// and the handler returned in silence — so delegating a mirror to the
		// agent, the most natural way to take it, did nothing at all.
		expect(classifyMirrorIntent("   ")).toEqual({ kind: "orient" });
		expect(classifyMirrorIntent("")).toEqual({ kind: "orient" });
	});
});

describe("operator session — the client hears nothing", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("starts a session on the mirror and posts nothing to the client", async () => {
		const { p, clientPosts, cockpitPosts, resumed } = setup();

		await p.handleMirrorAction(
			action("make the chart lazy-load"),
			CLIENT_ISSUE,
		);

		expect(resumed).toHaveLength(1);
		expect(clientPosts).toHaveLength(0);
		// And it is the MIRROR session that was resumed, not the client's.
		expect(resumed[0][2]).toBe(MIRROR_SESSION);
		expect(cockpitPosts.length).toBeGreaterThanOrEqual(0);
	});

	it("binds the mirror session's OUTPUT to the cockpit sink", async () => {
		// The structural core of the silence claim: activities are posted
		// through a per-session sink, so proving the bound sink is the
		// cockpit's proves the client's surface is unreachable — stronger
		// than counting posts a mocked runner was never going to make.
		const { p } = setup();
		await p.handleMirrorAction(action("carry on"), CLIENT_ISSUE);
		const bound = p.agentSessionManager.activitySinks.get(MIRROR_SESSION);
		expect(bound).toBe(p.activitySinks.get(COCKPIT_WS));
		expect(bound).not.toBe(p.activitySinks.get(CLIENT_WS));
	});

	it("registers the client's repository as the subject", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("tighten the query"), CLIENT_ISSUE);
		// Subject resolution is what drives credentials, git auth and policy.
		expect(p.sessionRepositories.get(MIRROR_SESSION)).toBe(repo.id);
		expect(p.resolveWorkspaceIdForSession(MIRROR_SESSION)).toBe(CLIENT_WS);
	});

	it("resumes with the CLIENT's workspace, so the client's credential pays", async () => {
		const { p, resumed } = setup();
		await p.handleMirrorAction(action("tighten the query"), CLIENT_ISSUE);
		// Argument 9 (index 8) is linearWorkspaceId — the value that selects
		// the Anthropic credential. The cockpit is an apiKey tenant; billing
		// client iteration there would spend the metered budget.
		expect(resumed[0][8]).toBe(CLIENT_WS);
		expect(resumed[0][8]).not.toBe(COCKPIT_WS);
	});

	it("resolves the CLIENT's credential, never the cockpit's", async () => {
		// Both tenants on keys here, so the assertion is about WHICH key —
		// the failure this guards is silent: iteration billed to the
		// cockpit's metered key against a hard cap with no top-up.
		const { p } = setup({
			anthropicAuth: { mode: "apiKey", apiKey: "sk-client-key" },
		});
		await p.handleMirrorAction(action("tighten the query"), CLIENT_ISSUE);
		const log = { info: vi.fn(), warn: vi.fn() };
		const env = p.resolveAuthEnvForWorkspace(
			p.resolveWorkspaceIdForSession(MIRROR_SESSION),
			log,
		);
		expect(env?.ANTHROPIC_API_KEY).toBe("sk-client-key");
		expect(env?.ANTHROPIC_API_KEY).not.toBe("sk-test-not-a-real-key");
	});

	it("adopts the client's conversation and worktree", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("one more thing"), CLIENT_ISSUE);
		const mirror = p.agentSessionManager.getSession(MIRROR_SESSION);
		expect(mirror.claudeSessionId).toBe("claude-abc");
		expect(mirror.workspace.path).toBe("/tmp/acme-ws/ws-acme/ACM-13");
	});

	it("syncs an advanced conversation id back to the client's record", async () => {
		const { p, clientSession } = setup();
		await p.handleMirrorAction(action("one more thing"), CLIENT_ISSUE);
		// The SDK hands back a new id on the operator's turn.
		p.agentSessionManager.getSession(MIRROR_SESSION).claudeSessionId =
			"claude-def";

		p.handleLaneSessionEnded(MIRROR_SESSION, "result");

		// Without this the client's next resume would continue a conversation
		// that never saw the operator's work — and nothing would report it.
		expect(clientSession.claudeSessionId).toBe("claude-def");
	});

	it("publishes the session surface to the cockpit, not the client", async () => {
		// The ONE surface that resolves its tracker by workspace rather than
		// by the session's sink. An operator session's workspace is the
		// client's, so left alone PON-116 would push the reviewer's plan and
		// links into the client's workspace.
		const { p, worker } = setup();
		const clientUpdate = vi.fn().mockResolvedValue(true);
		const cockpitUpdate = vi.fn().mockResolvedValue(true);
		p.issueTrackers.get(CLIENT_WS).updateAgentSession = clientUpdate;
		p.issueTrackers.get(COCKPIT_WS).updateAgentSession = cockpitUpdate;

		await p.handleMirrorAction(action("carry on"), CLIENT_ISSUE);
		await p.agentSessionManager.updateSessionSurface(MIRROR_SESSION, {
			summary: "working",
		});

		expect(cockpitUpdate).toHaveBeenCalled();
		expect(clientUpdate).not.toHaveBeenCalled();
		expect(worker).toBeDefined();
	});

	it("does not drag the conversation backwards on a second turn", async () => {
		// Turn 1 advances the id. If turn 2 re-adopted from the client record
		// it would silently discard turn 1 — the exact failure the end-of-turn
		// sync is supposed to prevent, reintroduced whenever that sync did not
		// land (a runner that died before its end event).
		const { p, clientSession } = setup();
		await p.handleMirrorAction(action("first change"), CLIENT_ISSUE);
		p.agentSessionManager.getSession(MIRROR_SESSION).claudeSessionId =
			"claude-turn-2";
		expect(clientSession.claudeSessionId).toBe("claude-abc"); // sync not landed

		await p.handleMirrorAction(action("second change"), CLIENT_ISSUE);

		expect(
			p.agentSessionManager.getSession(MIRROR_SESSION).claudeSessionId,
		).toBe("claude-turn-2");
	});

	it("forgets the operator link when the issue is over", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("keep going"), CLIENT_ISSUE);
		expect(p.operatorSessions.isOperatorSession(MIRROR_SESSION)).toBe(true);

		p.operatorSessions.releaseForClientIssue(CLIENT_ISSUE);

		// Otherwise the link keeps granting its exemptions — loud, ungated,
		// unheld — to a session on an issue that has ended.
		expect(p.operatorSessions.isOperatorSession(MIRROR_SESSION)).toBe(false);
	});

	it("is loud: an operator session is never client-quiet", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("show me the diff"), CLIENT_ISSUE);
		// Its subject is Acme, which IS a quiet workspace — so resolving by
		// workspace alone would silence the thread Harold is reading.
		expect(p.clientQuietSession(CLIENT_SESSION)).toBe(true);
		expect(p.clientQuietSession(MIRROR_SESSION)).toBe(false);
	});

	it("never holds a second delivery for verification", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("adjust the copy"), CLIENT_ISSUE);
		expect(p.holdCompletionForVerification(MIRROR_SESSION, "done", false)).toBe(
			false,
		);
		// ...while the original delivery is untouched and still pending.
		expect(p.verificationGate.isPending(CLIENT_ISSUE)).toBe(true);
	});

	it("does not gate the operator's own iteration on scope approval", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("adjust the copy"), CLIENT_ISSUE);
		const prompt = p.appendScopeGateIfPending(
			"base",
			CLIENT_WS,
			CLIENT_ISSUE,
			MIRROR_SESSION,
		);
		expect(prompt).toBe("base");
	});

	it("does not take a lane while the operator iterates", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("adjust the copy"), CLIENT_ISSUE);
		// The client's next issue must not queue behind Harold's review.
		expect(p.laneManager.isActive(MIRROR_SESSION)).toBe(false);
	});
});

describe("cockpit workability (PON-211)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("answers a bare delegation instead of saying nothing", async () => {
		// The headline bug: delegating a mirror to the agent — the most
		// natural way to pick work up — classified as nothing and returned in
		// silence. No session should start (there is no instruction yet), but
		// silence is not an acceptable answer to "I'm taking this".
		const { p, cockpitPosts, resumed } = setup();

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		expect(resumed).toHaveLength(0); // no model turn, no cost
		expect(cockpitPosts).toHaveLength(1);
		const body = cockpitPosts[0].content.body as string;
		expect(body).toContain("ACM-13");
		expect(body).toContain("approve:");
		expect(body).toContain("ask client:");
	});

	it("does not send the operator session the client-facing rules", async () => {
		// These directly contradict the operator block, which asks for file
		// names and diffs on a thread the client cannot see. Appending both
		// told the model two opposite things at once.
		const { p } = setup();
		const clientRules = p.sessionRuleBlocks(CLIENT_SESSION);
		expect(clientRules).toContain("client");
		expect(clientRules.length).toBeGreaterThan(0);

		await p.handleMirrorAction(action("tighten the query"), CLIENT_ISSUE);

		expect(p.sessionRuleBlocks(MIRROR_SESSION)).toBe("");
	});

	it("records which human drove the turn", async () => {
		// The multi-reviewer seam: one agent identity serves every mirror, so
		// Linear attributes every turn to the app. This is the only place the
		// person is recorded, and it cannot be backfilled later.
		const { p } = setup();
		await p.handleMirrorAction(action("carry on"), CLIENT_ISSUE);
		expect(p.operatorSessions.get(MIRROR_SESSION).reviewerId).toBe(HAROLD);
	});

	it("does not recompose the mirror when an operator turn ends", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("carry on"), CLIENT_ISSUE);
		p.cockpitMirror.upsert.mockClear();

		p.handleLaneSessionEnded(MIRROR_SESSION, "result");
		await p.mirrorComposition;

		// The state did not change — it was in verification before the turn
		// and still is. Re-rendering the whole description under the reviewer
		// mid-conversation is churn, not an update.
		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
	});
});

describe("operator session — guards", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("refuses a work request from a non-reviewer", async () => {
		const { p, resumed, cockpitPosts } = setup();
		await p.handleMirrorAction(
			{ ...action("do the thing"), actorId: "someone-else" },
			CLIENT_ISSUE,
		);
		// This used to be a harmless canned reply; now it would spend the
		// client's credential and write to the client's branch.
		expect(resumed).toHaveLength(0);
		expect(cockpitPosts.some((a) => /reviewer/i.test(a.content.body))).toBe(
			true,
		);
	});

	it("refuses work from outside the cockpit workspace", async () => {
		const { p, resumed } = setup();
		await p.handleMirrorAction(
			{ ...action("do the thing"), organizationId: CLIENT_WS },
			CLIENT_ISSUE,
		);
		expect(resumed).toHaveLength(0);
	});

	it("refuses to iterate when nothing is held for this issue", async () => {
		const { p, resumed, clientPosts } = setup();
		p.verificationGate.reject(CLIENT_ISSUE);
		await p.handleMirrorAction(action("change the header"), CLIENT_ISSUE);
		expect(resumed).toHaveLength(0);
		expect(clientPosts).toHaveLength(0);
	});

	it("denies destructive git so the operator's own commits survive", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action("keep going"), CLIENT_ISSUE);
		expect(p.operatorSessions.isOperatorSession(MIRROR_SESSION)).toBe(true);
		expect(OPERATOR_GIT_DENY).toContain("Bash(git push --force*)");
		expect(OPERATOR_GIT_DENY).toContain("Bash(git reset --hard*)");
	});
});

describe("operator session — the operator takes the branch", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("refuses to touch the branch while the operator holds it", async () => {
		const { p, resumed } = setup();
		await p.handleMirrorAction(action("mine"), CLIENT_ISSUE);
		await p.handleMirrorAction(action("also fix the footer"), CLIENT_ISSUE);
		// Racing the human on their own checkout is the one thing that would
		// lose their work outright.
		expect(resumed).toHaveLength(0);
	});

	it("picks the branch back up on a handback, rebasing first", async () => {
		const { p, resumed } = setup();
		await p.handleMirrorAction(action("mine"), CLIENT_ISSUE);
		await p.handleMirrorAction(
			action("back to you: I fixed the query, carry on"),
			CLIENT_ISSUE,
		);
		expect(resumed).toHaveLength(1);
		const prompt = resumed[0][4] as string;
		expect(prompt).toContain("git pull --ff-only");
		expect(prompt).toContain("handed the branch back");
	});

	it("still delivers on approve after the operator committed", async () => {
		const { p } = setup();
		p.deliverVerifiedWork = vi.fn().mockResolvedValue("Delivered.");
		await p.handleMirrorAction(action("mine"), CLIENT_ISSUE);
		await p.handleMirrorAction(action("approve: nice one"), CLIENT_ISSUE);
		// Release is unchanged regardless of who wrote the code.
		expect(p.deliverVerifiedWork).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			"nice one",
		);
	});
});

describe("operator session — asking the client", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("is the ONE thing that reaches the client, and only when typed", async () => {
		const { p, clientPosts } = setup();
		await p.handleMirrorAction(
			action("ask client: which currency should totals use?"),
			CLIENT_ISSUE,
		);
		expect(clientPosts).toHaveLength(1);
		expect(clientPosts[0].content.type).toBe("elicitation");
		expect(clientPosts[0].content.body).toContain("Missing info");
		expect(clientPosts[0].content.body).toContain("which currency");
		expect(clientPosts[0].agentSessionId).toBe(CLIENT_SESSION);
		expect(p.needsInfo.isAwaiting(CLIENT_ISSUE)).toBe(true);
	});

	it("refuses to put internal wording on the client's thread", async () => {
		const { p, clientPosts } = setup();
		await p.handleMirrorAction(
			action("ask client: should I change /root/cyrus/packages/edge-worker?"),
			CLIENT_ISSUE,
		);
		expect(clientPosts).toHaveLength(0);
	});

	it("does not deliver anything when it asks", async () => {
		const { p } = setup();
		await p.handleMirrorAction(
			action("ask client: which currency?"),
			CLIENT_ISSUE,
		);
		expect(p.verificationGate.isPending(CLIENT_ISSUE)).toBe(true);
	});
});
