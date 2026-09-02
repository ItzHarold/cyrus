import type { RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { classifyMirrorIntent } from "../src/operator-session.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * `cancel: <reason>` from the mirror (v3.1, Harold's ruling 2026-09-02):
 * never silent toward the client. The reason is the note they receive;
 * their issue goes to Canceled; the terminal path closes the mirror and
 * advances the queue. Delegating the issue again reopens it.
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

function setup() {
	const p = privates(createTestWorker([repo]));
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
		[CLIENT_WS]: { linearToken: "t", anthropicAuth: { mode: "subscription" } },
		[COCKPIT_WS]: { linearToken: "t", anthropicAuth: { mode: "subscription" } },
	};
	p.scopeApprovals.recordProposed(CLIENT_ISSUE, {
		workspaceId: CLIENT_WS,
		issueIdentifier: "ACM-13",
	});
	p.scopeApprovals.recordApproved(CLIENT_ISSUE);
	p.cockpitMirror.mirrorIssueIdFor = vi.fn().mockReturnValue(MIRROR_ISSUE);
	p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue(HAROLD);
	p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);
	p.moveIssueToTerminalState = vi.fn().mockResolvedValue(undefined);
	p.startWorkFromMirror = vi.fn().mockResolvedValue(undefined);
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
		ownsDelivery: true,
	});
	return { p, clientPosts, cockpitPosts };
}

const action = (rawBody: string, actorId: string | undefined = HAROLD) => ({
	organizationId: COCKPIT_WS,
	mirrorSessionId: MIRROR_SESSION,
	actorId,
	actorName: actorId ? "Someone" : undefined,
	rawBody,
});

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reading a cancel", () => {
	it("requires a reason, and keeps it whole", () => {
		expect(
			classifyMirrorIntent("cancel: the client moved to another vendor"),
		).toEqual({
			kind: "cancel",
			reason: "the client moved to another vendor",
		});
		expect(classifyMirrorIntent("cancel")).toEqual({ kind: "cancel-unclear" });
		expect(classifyMirrorIntent("cancel:")).toEqual({ kind: "cancel-unclear" });
	});
});

describe("cancelling from the mirror", () => {
	it("tells the client in their words, cancels their issue, and says so on the mirror", async () => {
		const { p, clientPosts, cockpitPosts } = setup();
		await p.handleMirrorAction(
			action("cancel: this overlaps with work already in your next release"),
			CLIENT_ISSUE,
		);
		const note = clientPosts.find((a) => a.content.type === "response");
		expect(note.agentSessionId).toBe(CLIENT_SESSION);
		expect(note.content.body).toContain("stopped work on this");
		expect(note.content.body).toContain(
			"overlaps with work already in your next release",
		);
		expect(note.content.body).toContain("delegate it to us");
		expect(p.moveIssueToTerminalState).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			CLIENT_WS,
			"canceled",
		);
		expect(cockpitPosts.at(-1).content.body).toContain("Cancelled");
		expect(p.startWorkFromMirror).not.toHaveBeenCalled();
	});

	it("without a reason, nothing is cancelled and the reviewer is told why", async () => {
		const { p, clientPosts } = setup();
		await p.handleMirrorAction(action("cancel"), CLIENT_ISSUE);
		expect(clientPosts).toHaveLength(0);
		expect(p.moveIssueToTerminalState).not.toHaveBeenCalled();
	});

	it("refuses internal wording rather than putting it on the client's thread", async () => {
		const { p, clientPosts } = setup();
		await p.handleMirrorAction(
			action("cancel: the worktree at /root/cyrus is broken"),
			CLIENT_ISSUE,
		);
		expect(clientPosts).toHaveLength(0);
		expect(p.moveIssueToTerminalState).not.toHaveBeenCalled();
	});

	it("only a reviewer may cancel", async () => {
		const { p, clientPosts } = setup();
		await p.handleMirrorAction(
			action("cancel: no longer needed", COLLEAGUE),
			CLIENT_ISSUE,
		);
		expect(clientPosts).toHaveLength(0);
		expect(p.moveIssueToTerminalState).not.toHaveBeenCalled();
	});

	it("does not cancel what it cannot tell the client about", async () => {
		const { p } = setup();
		p.issueTrackers.set(CLIENT_WS, {
			createAgentActivity: vi.fn(async () => {
				throw new Error("502");
			}),
		});
		await p.handleMirrorAction(
			action("cancel: no longer needed"),
			CLIENT_ISSUE,
		);
		expect(p.moveIssueToTerminalState).not.toHaveBeenCalled();
	});
});
