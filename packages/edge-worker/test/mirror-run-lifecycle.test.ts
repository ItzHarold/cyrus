import type { RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * A mirror-owned run that ends without handing anything over (v3.1 P1).
 *
 * Stop, crash, or process death on a run the reviewer started from the
 * mirror used to fall through to shouldCloseCockpitMirror, which had no
 * reason to say no: the mirror closed as Done ("stop_signal" is not a
 * discard reason) with the client's approved work half-built, and the
 * reviewer's next delegation landed on a closed issue. Found by reading,
 * one step ahead of the live Stop test that would have found it in front
 * of a client.
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

function setup() {
	const worker = createTestWorker([repo]);
	const p = privates(worker);
	p.issueTrackers.set(CLIENT_WS, {
		createAgentActivity: vi.fn(async () => ({ success: true })),
	});
	p.issueTrackers.set(COCKPIT_WS, {
		createAgentActivity: vi.fn(async () => ({ success: true })),
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
	p.scopeApprovals.markImplementationStarted(CLIENT_ISSUE);
	p.cockpitMirror.mirrorIssueIdFor = vi.fn().mockReturnValue(MIRROR_ISSUE);
	p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue(HAROLD);
	p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);
	p.cockpitMirror.close = vi.fn().mockResolvedValue(undefined);
	p.cockpitMirror.commentOnMirror = vi.fn().mockResolvedValue(undefined);
	p.mirrorInVerification = vi.fn();
	p.persistScopeApprovals = vi.fn().mockResolvedValue(undefined);
	p.savePersistedState = vi.fn().mockResolvedValue(undefined);
	p.startWorkFromMirror = vi.fn().mockResolvedValue(undefined);
	const issue = { id: CLIENT_ISSUE, identifier: "ACM-13", title: "Totals" };
	const workspace = {
		path: "/tmp/acme-ws/ws-acme/ACM-13",
		isGitWorktree: true,
	};
	for (const id of [CLIENT_SESSION, MIRROR_SESSION]) {
		p.agentSessionManager.sessions.set(id, {
			id,
			issueId: CLIENT_ISSUE,
			issue,
			workspace,
			repositories: [],
		});
		p.agentSessionManager.entries.set(id, []);
		p.sessionRepositories.set(id, repo.id);
	}
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
		ownsDelivery: true,
	});
	return { p };
}

const delegation = (actorId?: string) => ({
	organizationId: COCKPIT_WS,
	mirrorSessionId: MIRROR_SESSION,
	actorId,
	actorName: actorId ? "Harold" : undefined,
	rawBody: "",
});

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a mirror-owned run that ends without handing anything over", () => {
	it("Stop re-parks the work instead of closing the mirror as Done", () => {
		const { p } = setup();
		p.handleLaneSessionEnded(MIRROR_SESSION, "stop_signal");

		expect(p.cockpitMirror.close).not.toHaveBeenCalled();
		expect(p.cockpitMirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: CLIENT_ISSUE }),
			CLIENT_WS,
			"queued",
		);
		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(true);
		// v3.1: the sign-off is an inbox comment on the mirror, never a
		// thread — the implementation thread is the only one the mirror has.
		expect(p.cockpitMirror.commentOnMirror).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			expect.stringContaining("your move"),
		);
	});

	it("a crash re-parks it the same way", () => {
		const { p } = setup();
		p.handleLaneSessionEnded(MIRROR_SESSION, "runner_error");
		expect(p.cockpitMirror.close).not.toHaveBeenCalled();
		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(true);
	});

	it("re-delegation then resumes it through the same door a first start uses", async () => {
		const { p } = setup();
		p.handleLaneSessionEnded(MIRROR_SESSION, "stop_signal");

		await p.handleMirrorAction(delegation(HAROLD), CLIENT_ISSUE);

		expect(p.startWorkFromMirror).toHaveBeenCalledWith(
			expect.objectContaining({ mirrorSessionId: MIRROR_SESSION }),
			CLIENT_ISSUE,
			{ instruction: "" },
		);
	});

	it("a run that handed its work over still goes to verification, not back to the queue", () => {
		const { p } = setup();
		p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: CLIENT_WS,
			issueIdentifier: "ACM-13",
			sessionId: MIRROR_SESSION,
			summary: "Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/1",
			isError: false,
		});
		p.handleLaneSessionEnded(MIRROR_SESSION, "result");
		expect(p.mirrorInVerification).toHaveBeenCalledWith(CLIENT_ISSUE);
		expect(p.cockpitMirror.upsert).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"queued",
		);
		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(false);
	});

	it("an operator review turn (no ownsDelivery) is untouched by this", () => {
		const { p } = setup();
		p.operatorSessions.register({
			...p.operatorSessions.get(MIRROR_SESSION),
			ownsDelivery: false,
		});
		p.handleLaneSessionEnded(MIRROR_SESSION, "stop_signal");
		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(false);
		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
	});
});

describe("a reviewer talking to a RUNNING mirror run", () => {
	it("streams the message into the run instead of answering with a canned line", async () => {
		const { p } = setup();
		const addStreamMessage = vi.fn();
		p.agentSessionManager.sessions.get(MIRROR_SESSION).agentRunner = {
			isRunning: () => true,
			supportsStreamingInput: true,
			addStreamMessage,
		};
		const cockpit = p.issueTrackers.get(COCKPIT_WS);

		await p.handleMirrorAction(
			{ ...delegation(HAROLD), rawBody: "use the existing Mailer helper" },
			CLIENT_ISSUE,
		);

		expect(addStreamMessage).toHaveBeenCalledWith(
			"use the existing Mailer helper",
		);
		const canned = cockpit.createAgentActivity.mock.calls.find((c: any) =>
			String(c[0]?.content?.body ?? "").includes("Work is underway"),
		);
		expect(canned).toBeUndefined();
	});
});

describe("a restart during a mirror-owned run", () => {
	it("re-parks the work on boot instead of reporting a run that is not there", async () => {
		const { p } = setup();
		const reconcile = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.reconcile = reconcile;
		p.cockpitMirror.resyncOperatorOrdering = vi
			.fn()
			.mockResolvedValue(undefined);
		p.pruneEndedScopeConversations = vi.fn().mockResolvedValue(undefined);

		await p.reconcileCockpitMirror();

		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(true);
		expect(reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				parked: expect.arrayContaining([
					expect.objectContaining({
						issue: expect.objectContaining({ issueId: CLIENT_ISSUE }),
					}),
				]),
			}),
		);
		expect(p.cockpitMirror.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ issueId: CLIENT_ISSUE }),
			CLIENT_WS,
			"queued",
		);
	});

	it("leaves a run that handed its work over alone", async () => {
		const { p } = setup();
		p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: CLIENT_WS,
			issueIdentifier: "ACM-13",
			sessionId: MIRROR_SESSION,
			summary: "Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/1",
			isError: false,
		});
		p.cockpitMirror.reconcile = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.resyncOperatorOrdering = vi
			.fn()
			.mockResolvedValue(undefined);
		p.pruneEndedScopeConversations = vi.fn().mockResolvedValue(undefined);

		await p.reconcileCockpitMirror();

		expect(p.scopeApprovals.isImplementationDeferred(CLIENT_ISSUE)).toBe(false);
	});
});

describe("the WIP refusal", () => {
	it("stays silent for machinery and speaks only to a person", async () => {
		const { p } = setup();
		p.cockpitMirror.clientWorkInFlight = vi.fn().mockReturnValue({
			inFlight: [{ issueIdentifier: "ACM-1", state: "active" }],
			limit: 1,
		});
		const silent = await p.mayStartParkedWork({}, CLIENT_ISSUE);
		expect(silent.ok).toBe(false);
		expect(silent.say).toBeUndefined();
		const spoken = await p.mayStartParkedWork(
			{ actorId: HAROLD },
			CLIENT_ISSUE,
		);
		expect(spoken.ok).toBe(false);
		expect(spoken.say).toMatch(/work in flight/);
	});
});

describe("the delivery signature", () => {
	it("names the mirror's assignee, and nobody else", async () => {
		const { p } = setup();
		p.issueTrackers.set(COCKPIT_WS, {
			createAgentActivity: vi.fn(async () => ({ success: true })),
			fetchUser: vi.fn(async (id: string) =>
				id === HAROLD ? { displayName: "Harold Ponte da Costa" } : undefined,
			),
		});
		const link = p.operatorSessions.get(MIRROR_SESSION);
		expect(await p.deliverySignature(CLIENT_ISSUE, link)).toBe(
			"Implemented by Ponte Digital · Reviewed by Harold Ponte da Costa",
		);
	});

	it("omits the line rather than naming the last person who typed", async () => {
		const { p } = setup();
		p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue(undefined);
		p.issueTrackers.set(COCKPIT_WS, {
			createAgentActivity: vi.fn(async () => ({ success: true })),
			fetchUser: vi.fn(async () => ({ displayName: "Somebody Else" })),
		});
		const link = {
			...p.operatorSessions.get(MIRROR_SESSION),
			reviewerId: "user-colleague",
		};
		expect(await p.deliverySignature(CLIENT_ISSUE, link)).toBeUndefined();
	});
});
