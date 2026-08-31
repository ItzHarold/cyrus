import type { RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-225: delegating a queued mirror starts the client's implementation run.
 *
 * Two claims carry this feature and both are negatives, so they are measured
 * rather than asserted: the CLIENT's thread stays silent throughout, and the
 * run's closing summary is HELD rather than posted. A test that only checked
 * the mirror got a session would pass just as happily if the client got the
 * work in progress too.
 */

const CLIENT_WS = "ws-acme";
const COCKPIT_WS = "ws-cockpit";
const CLIENT_ISSUE = "issue-acm-13";
const MIRROR_ISSUE = "issue-ckp-9";
const CLIENT_SESSION = "sess-client";
const MIRROR_SESSION = "sess-mirror";
const HAROLD = "user-harold";
const COLLEAGUE = "user-colleague";

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
 * A worker with one client issue whose scope is approved and PARKED — the
 * state a mirror is in when the reviewer arrives to start it.
 */
function setup(opts: { parked?: boolean } = {}) {
	const worker = createTestWorker([repo]);
	const p = privates(worker);

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
			anthropicAuth: { mode: "apiKey", apiKey: "sk-test-not-a-real-key" },
		},
		[COCKPIT_WS]: {
			linearToken: "t",
			linearWorkspaceName: "Ponte Digital",
			anthropicAuth: { mode: "subscription" },
		},
	};

	// Scope approved. Parked unless the test says otherwise.
	p.scopeApprovals.recordProposed(CLIENT_ISSUE, {
		workspaceId: CLIENT_WS,
		issueIdentifier: "ACM-13",
	});
	p.scopeApprovals.recordOperatorNote(
		CLIENT_ISSUE,
		"internal reading",
		"**Outcome** — the dashboard loads fast.",
	);
	p.scopeApprovals.recordApproved(CLIENT_ISSUE, {
		workspaceId: CLIENT_WS,
		issueIdentifier: "ACM-13",
	});
	if (opts.parked === false) {
		p.scopeApprovals.markImplementationStarted(CLIENT_ISSUE);
	}

	p.cockpitMirror.mirrorIssueIdFor = vi.fn().mockReturnValue(MIRROR_ISSUE);
	p.cockpitMirror.clientIssueIdFor = vi.fn().mockReturnValue(CLIENT_ISSUE);
	// Claimed by the reviewer — §8.3's gesture is assign, then delegate.
	p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue(HAROLD);
	p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);
	p.cockpitMirror.close = vi.fn().mockResolvedValue(undefined);
	p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
	p.savePersistedState = vi.fn().mockResolvedValue(undefined);

	// The scoping conversation: a real worktree on the client's repo, which
	// is what binds this issue to a repository and a branch.
	const clientSession = {
		id: CLIENT_SESSION,
		claudeSessionId: "claude-scoping",
		issueId: CLIENT_ISSUE,
		issue: { id: CLIENT_ISSUE, identifier: "ACM-13", title: "Dashboard" },
		issueContext: { issueIdentifier: "ACM-13", trackerId: "linear" },
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

const action = (rawBody: string, actorId = HAROLD) => ({
	organizationId: COCKPIT_WS,
	mirrorSessionId: MIRROR_SESSION,
	actorId,
	actorName: "Harold",
	rawBody,
});

describe("PON-225 — delegating a queued mirror starts the work", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("a bare delegation starts a real session on the mirror, against the client's repo", async () => {
		const { p, resumed, clientPosts } = setup();

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		expect(resumed).toHaveLength(1);
		const [session, repository, sessionId, , prompt, , isNewSession] =
			resumed[0];
		expect(sessionId).toBe(MIRROR_SESSION);
		expect(repository.id).toBe(repo.id);
		// The subject is the CLIENT's issue: the worktree and branch are named
		// from it, and every issue-keyed lookup downstream expects it.
		expect(session.issueId ?? session.issue?.id).toBe(CLIENT_ISSUE);
		// A new conversation — there is no earlier implementation run.
		expect(isNewSession).toBe(true);
		expect(prompt).toContain("<mirror_implementation_session>");
		// The approved scope travels into the run.
		expect(prompt).toContain("the dashboard loads fast");
		// The client heard nothing.
		expect(clientPosts).toHaveLength(0);
	});

	it("a comment on a queued mirror starts it too, carrying the instruction", async () => {
		const { p, resumed } = setup();

		await p.handleMirrorAction(
			action("go ahead, but keep it simple"),
			CLIENT_ISSUE,
		);

		expect(resumed).toHaveLength(1);
		expect(resumed[0][4]).toContain("go ahead, but keep it simple");
	});

	it("registers the link BEFORE resuming, marked as owning the delivery", async () => {
		const { p } = setup();
		let linkAtResume: any;
		p.resumeAgentSession = vi.fn(async () => {
			linkAtResume = p.operatorSessions.get(MIRROR_SESSION);
		});

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		// Every exemption is consulted while the runner is being built, so a
		// link registered afterwards is the same as no link at all.
		expect(linkAtResume).toMatchObject({
			mirrorSessionId: MIRROR_SESSION,
			mirrorIssueId: MIRROR_ISSUE,
			clientSessionId: CLIENT_SESSION,
			clientIssueId: CLIENT_ISSUE,
			clientWorkspaceId: CLIENT_WS,
			cockpitWorkspaceId: COCKPIT_WS,
			repositoryId: repo.id,
			reviewerId: HAROLD,
			ownsDelivery: true,
		});
	});

	it("clears the parked flag and moves the mirror to active", async () => {
		const { p } = setup();

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(false);
		expect(p.cockpitMirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: CLIENT_ISSUE }),
			CLIENT_WS,
			"active",
		);
	});

	it("takes the client's lane, and refuses when that client is already building", async () => {
		const { p, resumed, cockpitPosts } = setup();
		p.laneManager.isEnabled = vi.fn().mockReturnValue(true);
		p.laneManager.acquire = vi.fn().mockReturnValue(false);
		p.laneManager.activeSessionOf = vi.fn().mockReturnValue("other-session");
		p.agentSessionManager.sessions.set("other-session", {
			id: "other-session",
			issueContext: { issueIdentifier: "ACM-7" },
		});

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		expect(resumed).toHaveLength(0);
		expect(cockpitPosts.at(-1).content.body).toContain("ACM-7");
		// Refused, not silently parked: the reviewer chose this moment.
		expect(cockpitPosts.at(-1).content.body).toContain(
			"Nothing has been started",
		);
		// The park survives a refusal.
		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(true);
	});

	it("a delegation the machinery created still starts it, because the reviewer claimed it", async () => {
		// Found live on prod: delegating an issue arrives as a notification,
		// and the agent session is then created by our own recovery — so the
		// created webhook's creator is the app, not the person who delegated.
		// Authorising on the actor alone refuses the actual gesture.
		const { p, resumed } = setup();

		await p.handleMirrorAction(
			{ ...action(""), actorId: undefined, actorName: undefined },
			CLIENT_ISSUE,
		);

		expect(resumed).toHaveLength(1);
	});

	it("an unclaimed mirror does NOT start, and says nothing when nobody asked", async () => {
		// The hazard this guards: the machinery opens a session on the mirror
		// at birth (the narration thread). If that could start the work, the
		// auto-start PON-224 removed would be back, one layer down.
		const { p, resumed, cockpitPosts } = setup();
		p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue(undefined);
		const before = cockpitPosts.length;

		await p.handleMirrorAction(
			{ ...action(""), actorId: undefined },
			CLIENT_ISSUE,
		);

		expect(resumed).toHaveLength(0);
		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(true);
		// Silent: a refusal on every mirror birth is noise on the one surface
		// that has to stay readable.
		expect(cockpitPosts.length).toBe(before);
	});

	it("a person on an unclaimed mirror is told to claim it", async () => {
		const { p, resumed, cockpitPosts } = setup();
		p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue(undefined);

		await p.handleMirrorAction(action("", COLLEAGUE), CLIENT_ISSUE);

		expect(resumed).toHaveLength(0);
		expect(cockpitPosts.at(-1).content.body).toContain("Assign yourself");
		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(true);
	});

	it("a mirror claimed by someone who is not a reviewer does not start", async () => {
		const { p, resumed } = setup();
		p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue(COLLEAGUE);

		await p.handleMirrorAction(
			{ ...action(""), actorId: undefined },
			CLIENT_ISSUE,
		);

		expect(resumed).toHaveLength(0);
	});

	it("Linear's own thread boilerplate is not read as an instruction", async () => {
		// Left in, a delegation classifies as `iterate` carrying that sentence
		// as the work to do — observed on prod before this was stripped.
		const { p, resumed } = setup();

		await p.handleMirrorAction(
			action("This thread is for an agent session with @pontedigital"),
			CLIENT_ISSUE,
		);

		expect(resumed).toHaveLength(1);
		expect(resumed[0][4]).not.toContain("This thread is for an agent session");
		expect(resumed[0][4]).not.toContain("The reviewer added:");
	});

	it("tells the run that its LAST message is the client's, not the reviewer's", async () => {
		// The defect this pins, found on the first live run: the model wrote a
		// reviewer report and appended a client summary to it, the interceptor
		// captured the whole message, and the client was delivered "Here's the
		// state", a commit hash, a branch name and a "four things for you"
		// section. The block has to make the audience of the last message
		// unmistakable, because the whole of it is what the client receives.
		const { p, resumed } = setup();

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);
		const prompt: string = resumed[0][4];

		expect(prompt).toContain("Your LAST message is different");
		expect(prompt).toContain("posted to the CLIENT, word for word");
		expect(prompt).toContain(
			"say everything you have to say to the reviewer BEFORE you finish",
		);
		expect(prompt).toContain("The message IS the summary.");
	});

	it("refuses honestly when nothing binds the issue to a repository", async () => {
		const { p, resumed, cockpitPosts } = setup();
		p.sessionRepositories.delete(CLIENT_SESSION);

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		expect(resumed).toHaveLength(0);
		expect(cockpitPosts.at(-1).content.body).toContain(
			"can't reach the original conversation",
		);
	});

	it("'mine' on work that does not exist yet says so instead of minting a hold", async () => {
		const { p, cockpitPosts } = setup();

		await p.handleMirrorAction(action("mine"), CLIENT_ISSUE);

		expect(cockpitPosts.at(-1).content.body).toContain(
			"Nothing has been built on this issue yet",
		);
		expect(p.operatorSessions.forClientIssue(CLIENT_ISSUE)).toBeUndefined();
	});

	it("leaves an already-started mirror on the ordinary iteration path", async () => {
		// Not parked: this is PON-208's world, and it must not change.
		const { p, cockpitPosts } = setup({ parked: false });

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		// No verification record either, so orient answers — the point is that
		// startWorkFromMirror did NOT run.
		expect(p.operatorSessions.get(MIRROR_SESSION)).toBeUndefined();
		expect(cockpitPosts.length).toBeGreaterThan(0);
	});
});

describe("PON-225 — a delivery-owning session feeds the verification gate", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	/** Put the worker in the state it is in once the mirror run is live. */
	async function started() {
		const ctx = setup();
		await ctx.p.handleMirrorAction(action(""), CLIENT_ISSUE);
		// The runner registers the mirror session; the real path does this
		// inside resumeAgentSession, which is stubbed here.
		ctx.p.agentSessionManager.sessions.set(MIRROR_SESSION, {
			id: MIRROR_SESSION,
			issueId: CLIENT_ISSUE,
			issue: { id: CLIENT_ISSUE, identifier: "ACM-13" },
			issueContext: { issueIdentifier: "ACM-13", trackerId: "linear" },
			workspace: { path: "/tmp/acme-ws/ws-acme/ACM-13", isGitWorktree: true },
		});
		ctx.p.agentSessionManager.entries.set(MIRROR_SESSION, []);
		return ctx;
	}

	it("HOLDS the closing summary — the client is not delivered to directly", async () => {
		const { p } = await started();

		const held = p.holdCompletionForVerification(
			MIRROR_SESSION,
			"All done. https://github.com/Ponte-Digital/Acme-Metrics/pull/9",
			false,
		);

		expect(held).toBe(true);
		const record = p.verificationGate.get(CLIENT_ISSUE);
		expect(record?.state).toBe("in-verification");
		// The record names the CLIENT session: delivery posts to it, and
		// posting to the mirror session would deliver onto the cockpit thread
		// while marking the work delivered.
		expect(record?.sessionId).toBe(CLIENT_SESSION);
		expect(record?.workspaceId).toBe(CLIENT_WS);
		expect(record?.prUrls).toEqual([
			"https://github.com/Ponte-Digital/Acme-Metrics/pull/9",
		]);
	});

	it("an ordinary operator turn is still exempt — it must not overwrite the client's summary", async () => {
		const { p } = await started();
		// Same session, but a review turn rather than the run that owns the
		// delivery.
		const link = p.operatorSessions.get(MIRROR_SESSION);
		p.operatorSessions.register({ ...link, ownsDelivery: false });

		const held = p.holdCompletionForVerification(
			MIRROR_SESSION,
			"Rebased and re-ran the tests.",
			false,
		);

		expect(held).toBe(false);
		expect(p.verificationGate.get(CLIENT_ISSUE)).toBeUndefined();
	});

	it("links still publish immediately — the Preview button is the point of the mirror", async () => {
		const { p } = await started();
		// Wide exemption kept deliberately: release only ever fires on the
		// record's session id, so links held here would never be released.
		expect(p.linksHeldForSession(MIRROR_SESSION)).toBe(false);
	});

	it("the session end moves the mirror into verification instead of returning early", async () => {
		const { p } = await started();
		p.holdCompletionForVerification(
			MIRROR_SESSION,
			"Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/9",
			false,
		);
		const mirrorInVerification = vi.fn();
		p.mirrorInVerification = mirrorInVerification;

		p.handleLaneSessionEnded(MIRROR_SESSION, "result");

		expect(mirrorInVerification).toHaveBeenCalledWith(CLIENT_ISSUE);
	});

	it("reject: continues on the MIRROR session, not the client's thread", async () => {
		const { p, resumed } = await started();
		p.holdCompletionForVerification(
			MIRROR_SESSION,
			"Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/9",
			false,
		);
		p.sessionRepositories.set(MIRROR_SESSION, repo.id);
		resumed.length = 0;

		await p.handleMirrorAction(action("reject: wrong table"), CLIENT_ISSUE);

		expect(resumed).toHaveLength(1);
		expect(resumed[0][2]).toBe(MIRROR_SESSION);
	});
});

describe("PON-229 — a reviewer message is classified before it is acted on", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	async function iterating(body: string) {
		const ctx = setup({ parked: false });
		ctx.p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: CLIENT_WS,
			issueIdentifier: "ACM-13",
			sessionId: CLIENT_SESSION,
			summary: "Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/1",
			isError: false,
		});
		await ctx.p.handleMirrorAction(action(body), CLIENT_ISSUE);
		return ctx;
	}

	it("asks what the message is before working on it", async () => {
		// The live defect: "why did you make metric-definitions.ts its own
		// file?" reached the session as a work directive, and it rewrote the
		// branch the reviewer was mid-review of.
		const { resumed } = await iterating(
			"Why did you make metric-definitions.ts its own file instead of keeping the notes inline?",
		);

		expect(resumed).toHaveLength(1);
		const prompt: string = resumed[0][4];
		expect(prompt).toContain("<what_is_being_asked>");
		expect(prompt).toContain("Answer it and change NOTHING");
		// The reviewer's own words still reach the session — the block is
		// added to the instruction, it does not replace it.
		expect(prompt).toContain("metric-definitions.ts");
	});

	it("asks it of a plain directive too — the model classifies, not a regex", async () => {
		const { resumed } = await iterating(
			"make the glossary link open in a new tab",
		);

		expect(resumed[0][4]).toContain("<what_is_being_asked>");
	});

	it("does NOT second-guess a handback, which is a directive by construction", async () => {
		const ctx = setup({ parked: false });
		ctx.p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: CLIENT_WS,
			issueIdentifier: "ACM-13",
			sessionId: CLIENT_SESSION,
			summary: "Done.",
			isError: false,
		});
		ctx.p.cockpitMirror.mirrorIssueIdFor = vi
			.fn()
			.mockReturnValue(MIRROR_ISSUE);

		await ctx.p.handleMirrorAction(
			action("back to you: rebased on my fix"),
			CLIENT_ISSUE,
		);

		expect(ctx.resumed).toHaveLength(1);
		expect(ctx.resumed[0][4]).not.toContain("<what_is_being_asked>");
	});
});

describe("PON-228 — the reviewer gets a finished turn, on the right thread", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	async function held() {
		const ctx = setup();
		await ctx.p.handleMirrorAction(action(""), CLIENT_ISSUE);
		ctx.p.agentSessionManager.sessions.set(MIRROR_SESSION, {
			id: MIRROR_SESSION,
			issueId: CLIENT_ISSUE,
			issue: { id: CLIENT_ISSUE, identifier: "ACM-13" },
			issueContext: { issueIdentifier: "ACM-13", trackerId: "linear" },
			workspace: { path: "/tmp/acme-ws/ws-acme/ACM-13", isGitWorktree: true },
		});
		ctx.p.agentSessionManager.entries.set(MIRROR_SESSION, []);
		ctx.p.holdCompletionForVerification(
			MIRROR_SESSION,
			"Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/9",
			false,
		);
		// The composition helpers reach GitHub; the turn-closing is what is
		// under test, so they answer with nothing rather than being mocked
		// into telling a story.
		ctx.p.buildStartHereBlock = vi.fn().mockResolvedValue("");
		ctx.p.describePullRequests = vi.fn().mockResolvedValue("");
		ctx.p.buildCheckoutInstructions = vi.fn().mockResolvedValue("");
		ctx.p.cockpitMirror.commentOnMirror = vi.fn().mockResolvedValue(undefined);
		return ctx;
	}

	it("closes the turn on the IMPLEMENTATION thread, not the narration one", async () => {
		// The defect: the gate suppresses the final response — correctly, it
		// is the client's — but a Linear turn is closed only BY a response.
		// The session ran forever, the reviewer's messages queued behind it,
		// and nothing said the work was ready.
		const { p, cockpitPosts } = await held();
		const endNarrationTurn = vi.fn();
		p.endNarrationTurn = endNarrationTurn;

		await p.signOffIntoVerification(CLIENT_ISSUE);
		await new Promise((r) => setTimeout(r, 10));

		const closing = cockpitPosts.at(-1);
		expect(closing.agentSessionId).toBe(MIRROR_SESSION);
		expect(closing.content.type).toBe("response");
		expect(closing.content.body).toContain("Finished — over to you");
		// The narration thread is NOT where a mirror-started run signs off.
		expect(endNarrationTurn).not.toHaveBeenCalled();
	});

	it("carries the run's own hand-off, and the facts around it", async () => {
		const { p, cockpitPosts } = await held();
		// Recorded after the work started, so it is an account of the run.
		p.operatorSessions.register({
			...p.operatorSessions.get(MIRROR_SESSION),
			startedAt: new Date(Date.now() - 60_000).toISOString(),
		});
		p.scopeApprovals.recordOperatorNote(
			CLIENT_ISSUE,
			"Split the query because the join was the slow half.",
		);
		p.verificationGate.recordCapturedHead(CLIENT_ISSUE, "abc1234");

		await p.signOffIntoVerification(CLIENT_ISSUE);
		await new Promise((r) => setTimeout(r, 10));

		const body = cockpitPosts.at(-1).content.body;
		expect(body).toContain(
			"Split the query because the join was the slow half.",
		);
		expect(body).toContain("abc1234");
		expect(body).toContain("approve:");
	});

	it("will not pass off the pre-approval reading as an account of the run", async () => {
		// Seen on CKP-22: the scoping-time internal reading appeared under
		// "From the run" — a note about what the work was going to be,
		// presented as what it turned out to be.
		const { p, cockpitPosts } = await held();
		p.scopeApprovals.recordOperatorNote(
			CLIENT_ISSUE,
			"Reading of the issue before any work started.",
		);
		// The run started AFTER that note was written.
		p.operatorSessions.register({
			...p.operatorSessions.get(MIRROR_SESSION),
			startedAt: new Date(Date.now() + 60_000).toISOString(),
		});

		await p.signOffIntoVerification(CLIENT_ISSUE);
		await new Promise((r) => setTimeout(r, 10));

		const body = cockpitPosts.at(-1).content.body;
		expect(body).not.toContain("Reading of the issue before any work");
		expect(body).not.toContain("From the run");
	});

	it("notifies the reviewer with a comment — an activity does not reach an inbox", async () => {
		const { p } = await held();

		await p.signOffIntoVerification(CLIENT_ISSUE);
		await new Promise((r) => setTimeout(r, 10));

		expect(p.cockpitMirror.commentOnMirror).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			expect.stringContaining("Ready for review"),
		);
	});

	it("signs off once, however many times the mirror recomposes", async () => {
		const { p, cockpitPosts } = await held();
		const before = cockpitPosts.length;

		await p.signOffIntoVerification(CLIENT_ISSUE);
		await p.signOffIntoVerification(CLIENT_ISSUE);
		await new Promise((r) => setTimeout(r, 10));

		expect(cockpitPosts.length).toBe(before + 1);
	});

	it("points the narration thread at the live thread when work starts", async () => {
		const { p } = setup();
		const endNarrationTurn = vi.fn();
		p.endNarrationTurn = endNarrationTurn;

		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		expect(endNarrationTurn).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			expect.stringContaining("Work has started"),
		);
	});
});

describe("PON-225 — the Anthropic credential follows the cockpit", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("a mirror session resolves auth against the cockpit workspace, not the client's", async () => {
		const { p } = setup();
		await p.handleMirrorAction(action(""), CLIENT_ISSUE);

		const seen: string[] = [];
		p.resolveAuthEnvForWorkspace = vi.fn((workspaceId: string) => {
			seen.push(workspaceId);
			return {};
		});
		p.agentSessionManager.sessions.set(MIRROR_SESSION, {
			id: MIRROR_SESSION,
			issueId: CLIENT_ISSUE,
			issue: { id: CLIENT_ISSUE, identifier: "ACM-13" },
			workspace: { path: "/tmp/acme-ws/ws-acme/ACM-13", isGitWorktree: true },
		});

		await p.buildAgentRunnerConfig(
			p.agentSessionManager.getSession(MIRROR_SESSION),
			repo,
			MIRROR_SESSION,
			undefined,
			[],
			[],
			[],
			undefined,
			[],
			"desc",
			undefined,
			// The client's workspace is passed, as the real call site does —
			// it selects the tracker. The credential must still be the
			// cockpit's.
			CLIENT_WS,
		);

		expect(seen).toEqual([COCKPIT_WS]);
	});

	it("an ordinary client session is unaffected", async () => {
		const { p, clientSession } = setup();
		const seen: string[] = [];
		p.resolveAuthEnvForWorkspace = vi.fn((workspaceId: string) => {
			seen.push(workspaceId);
			return {};
		});

		await p.buildAgentRunnerConfig(
			clientSession,
			repo,
			CLIENT_SESSION,
			undefined,
			[],
			[],
			[],
			undefined,
			[],
			"desc",
			undefined,
			CLIENT_WS,
		);

		expect(seen).toEqual([CLIENT_WS]);
	});
});
