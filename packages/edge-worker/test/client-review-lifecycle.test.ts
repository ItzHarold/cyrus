import { beforeEach, describe, expect, it, vi } from "vitest";
import { COCKPIT_STATES, COCKPIT_STATUS_NAMES } from "../src/CockpitMirror.js";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { stateRankOf } from "../src/operator-ordering.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-233: the cycle ends when the CLIENT merges, not when we deliver.
 *
 * Delivery hands the work to them; a merge is the only thing that finishes
 * it. The states in between have to be honest about whose move it is, and
 * — the sharpest trap — have to survive a restart, because reconcile closes
 * anything it cannot see and an item can sit in client review for days.
 */

const WS = "ws-acme";
const ISSUE = "issue-acm-21";
const SESSION = "sess-client";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function delivered(worker: EdgeWorker, opts: { watch?: boolean } = {}) {
	const p = privates(worker);
	p.verificationGate.recordPending(ISSUE, {
		workspaceId: WS,
		issueIdentifier: "ACM-21",
		sessionId: SESSION,
		summary: "Done. https://github.com/Ponte-Digital/Acme-Metrics/pull/6",
		isError: false,
	});
	p.verificationGate.markDelivered(ISSUE);
	if (opts.watch !== false)
		p.verificationGate.setMergeWatch(ISSUE, {
			owner: "Ponte-Digital",
			repo: "Acme-Metrics",
			number: 6,
		});
	return p;
}

describe("the states", () => {
	it("every state has a board column — adoption is by name and all-or-none", () => {
		// A name shipped before the status exists in the team drops EVERY
		// mirror into the default status, not just the new ones.
		for (const state of COCKPIT_STATES) {
			expect(COCKPIT_STATUS_NAMES[state]).toBeTruthy();
		}
		expect(COCKPIT_STATUS_NAMES["in-client-review"]).toBe("In client review");
		expect(COCKPIT_STATUS_NAMES.rework).toBe("Rework");
	});

	it("rework outranks fresh work but not work already on the reviewer's desk", () => {
		expect(stateRankOf("rework")).toBeLessThan(stateRankOf("active"));
		expect(stateRankOf("rework")).toBeLessThan(stateRankOf("queued"));
		expect(stateRankOf("rework")).toBeGreaterThan(
			stateRankOf("in-verification"),
		);
		expect(stateRankOf("rework")).toBeGreaterThan(stateRankOf("needs-info"));
	});

	it("client review sorts below anything actionable — it is nobody's turn here", () => {
		expect(stateRankOf("in-client-review")).toBeGreaterThan(
			stateRankOf("queued (#1)"),
		);
		expect(stateRankOf("in-client-review")).toBeLessThan(
			stateRankOf("delivered"),
		);
	});
});

describe("surviving a restart", () => {
	let worker: EdgeWorker;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
	});

	it("reconcile counts delivered-but-unmerged work as live", async () => {
		// The highest-severity trap in the change: without this, the first
		// restart after a delivery closes the mirror into CANCELED and the
		// reviewer sees the record of a delivery destroyed.
		const p = delivered(worker);
		const reconcile = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.reconcile = reconcile;

		await p.reconcileCockpitMirror();

		expect(reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				inClientReview: [
					expect.objectContaining({
						issue: expect.objectContaining({ issueId: ISSUE }),
						tenantWorkspaceId: WS,
					}),
				],
			}),
		);
	});

	it("a stray session ending does not close a mirror the client still holds", () => {
		const p = delivered(worker);
		expect(p.shouldCloseCockpitMirror(SESSION, ISSUE)).toBe(false);
	});

	it("once merged, the mirror may close as normal", () => {
		const p = delivered(worker);
		p.verificationGate.markMerged(ISSUE, "abc123");
		expect(p.shouldCloseCockpitMirror(SESSION, ISSUE)).toBe(true);
	});
});

describe("detecting the merge", () => {
	let worker: EdgeWorker;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
	});

	it("closes the cycle on a merge: client close-out first, THEN their issue", async () => {
		// Order is load-bearing. Completing their issue fires the terminal
		// path, which removes the record and closes the mirror — do it first
		// and the close-out is posted into a session already torn down.
		const p = delivered(worker);
		const order: string[] = [];
		p.mintGitHubTokenForRepo = vi.fn(async () => "tok");
		p.fetchPullRequestFacts = vi.fn(async () => ({
			headSha: "e4434f9",
			files: [],
			truncated: false,
			merged: true,
			closed: true,
			mergeCommitSha: "merge-sha",
		}));
		p.agentSessionManager.postResponseActivityStrict = vi.fn(async () => {
			order.push("client-close-out");
			return "a1";
		});
		p.cockpitMirror.commentOnMirror = vi.fn(async () => {
			order.push("mirror-comment");
		});
		p.moveIssueToCompletedState = vi.fn(async () => {
			order.push("client-issue-done");
		});

		await p.checkForClientMerge(ISSUE);

		expect(order).toEqual([
			"client-close-out",
			"mirror-comment",
			"client-issue-done",
		]);
		expect(p.verificationGate.get(ISSUE)?.mergedAt).toBeTruthy();
		expect(p.verificationGate.get(ISSUE)?.mergeCommitSha).toBe("merge-sha");
	});

	it("closes it exactly once, however many times the clock ticks", async () => {
		const p = delivered(worker);
		p.mintGitHubTokenForRepo = vi.fn(async () => "tok");
		p.fetchPullRequestFacts = vi.fn(async () => ({
			headSha: "x",
			files: [],
			truncated: false,
			merged: true,
			closed: true,
		}));
		// The close-out reports success; a falsy return means "retry".
		const closeOut = vi.fn(async () => true);
		p.closeOutMergedWork = closeOut;

		await p.checkForClientMerge(ISSUE);
		await p.checkForClientMerge(ISSUE);

		expect(closeOut).toHaveBeenCalledTimes(1);
	});

	it("a PR CLOSED without merging is not a completion", async () => {
		// A client who closes the pull request is rejecting the work. That
		// needs a human, not a Done transition.
		const p = delivered(worker);
		p.mintGitHubTokenForRepo = vi.fn(async () => "tok");
		p.fetchPullRequestFacts = vi.fn(async () => ({
			headSha: "x",
			files: [],
			truncated: false,
			merged: false,
			closed: true,
		}));
		const comment = vi.fn(async () => {});
		p.cockpitMirror.commentOnMirror = comment;
		const closeOut = vi.fn(async () => {});
		p.closeOutMergedWork = closeOut;

		await p.checkForClientMerge(ISSUE);
		await p.checkForClientMerge(ISSUE);

		expect(closeOut).not.toHaveBeenCalled();
		expect(p.verificationGate.get(ISSUE)?.mergedAt).toBeUndefined();
		// Told once, not once per tick.
		expect(comment).toHaveBeenCalledTimes(1);
		expect(comment.mock.calls[0][1]).toContain("without merging");
	});

	it("an unreadable answer is UNKNOWN, never 'not merged'", async () => {
		const p = delivered(worker);
		p.mintGitHubTokenForRepo = vi.fn(async () => undefined);
		const closeOut = vi.fn(async () => {});
		p.closeOutMergedWork = closeOut;

		await p.checkForClientMerge(ISSUE);

		expect(closeOut).not.toHaveBeenCalled();
		expect(p.verificationGate.get(ISSUE)?.mergedAt).toBeUndefined();
		// Still watched, so the next tick asks again.
		expect(p.verificationGate.awaitingMergeIssueIds()).toContain(ISSUE);
	});

	it("work with no watched PR is not polled at all", () => {
		const p = delivered(worker, { watch: false });
		expect(p.verificationGate.awaitingMergeIssueIds()).not.toContain(ISSUE);
	});
});

describe("one piece of work per company, across the lifecycle (PON-234)", () => {
	let worker: EdgeWorker;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
	});

	/** Two mirrors for one client, the first in the given state. */
	function board(firstState: string, opts: { lanes?: number } = {}) {
		const p = privates(worker);
		const mirrors = new Map<string, any>([
			[
				"issue-a",
				{
					mirrorIssueId: "CKP-1",
					state: firstState,
					issueIdentifier: "ACM-1",
					clientId: "acme",
					tenantWorkspaceId: WS,
				},
			],
			[
				ISSUE,
				{
					mirrorIssueId: "CKP-2",
					state: "queued",
					issueIdentifier: "ACM-21",
					clientId: "acme",
					tenantWorkspaceId: WS,
				},
			],
		]);
		p.cockpitMirror.mirrors = mirrors;
		p.cockpitMirror.deps = {
			...p.cockpitMirror.deps,
			resolveClient: () => ({ id: "acme", lanes: opts.lanes ?? 1 }),
		};
		return p;
	}

	it.each([
		"active",
		"needs-info",
		"in-verification",
		"in-client-review",
		"rework",
	])("counts %s as in flight — the hold spans the whole lifecycle, not the session", (state) => {
		const p = board(state);
		const wip = p.cockpitMirror.clientWorkInFlight(ISSUE);
		expect(wip.inFlight).toHaveLength(1);
		expect(wip.limit).toBe(1);
	});

	it("does not count work that is finished or not yet started", () => {
		for (const state of ["delivered", "queued"]) {
			const p = board(state);
			expect(p.cockpitMirror.clientWorkInFlight(ISSUE).inFlight).toHaveLength(
				0,
			);
		}
	});

	it("refuses a start while the client's slot is taken, naming what holds it", async () => {
		const p = board("in-client-review");
		p.config.cockpit = { linearWorkspaceId: "cockpit", reviewers: ["u1"] };
		p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue("u1");

		const verdict = await p.mayStartParkedWork({ actorId: "u1" }, ISSUE);

		expect(verdict.ok).toBe(false);
		expect(verdict.say).toContain("ACM-1");
		expect(verdict.say).toContain("in-client-review");
		expect(verdict.say).toContain("one lane");
	});

	it("a client who bought two lanes gets two", async () => {
		const p = board("active", { lanes: 2 });
		p.config.cockpit = { linearWorkspaceId: "cockpit", reviewers: ["u1"] };
		p.cockpitMirror.assigneeIdFor = vi.fn().mockResolvedValue("u1");

		const verdict = await p.mayStartParkedWork({ actorId: "u1" }, ISSUE);

		expect(verdict.ok).toBe(true);
	});

	it("unconfigured tenants are not serialised against each other", () => {
		// resolveClient returns the literal "unassigned" for every workspace
		// with no registry entry, so keying on the id alone would make every
		// unconfigured tenant one company.
		const p = privates(worker);
		p.cockpitMirror.mirrors = new Map<string, any>([
			[
				"other-tenant",
				{
					mirrorIssueId: "CKP-9",
					state: "active",
					issueIdentifier: "XYZ-1",
					clientId: "unassigned",
					tenantWorkspaceId: "ws-somebody-else",
				},
			],
			[
				ISSUE,
				{
					mirrorIssueId: "CKP-2",
					state: "queued",
					issueIdentifier: "ACM-21",
					clientId: "unassigned",
					tenantWorkspaceId: WS,
				},
			],
		]);
		p.cockpitMirror.deps = {
			...p.cockpitMirror.deps,
			resolveClient: () => ({ id: "unassigned", lanes: 1 }),
		};

		expect(p.cockpitMirror.clientWorkInFlight(ISSUE).inFlight).toHaveLength(0);
	});
});

describe("the client's summary is handed over, not scraped (PON-235)", () => {
	let worker: EdgeWorker;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
	});

	function mirrorRun(worker: EdgeWorker, startedAt: string) {
		const p = privates(worker);
		p.config.cockpit = {
			linearWorkspaceId: "cockpit",
			workspaceName: "Cockpit",
			teamId: "t",
			assigneeId: "u1",
		};
		p.config.linearWorkspaces = { [WS]: { linearToken: "t" } };
		p.agentSessionManager.createCyrusAgentSession(
			"sess-mirror",
			ISSUE,
			{
				id: ISSUE,
				identifier: "ACM-21",
				title: "t",
				description: "d",
				branchName: "b",
			},
			{ path: "/tmp/w", isGitWorktree: false },
		);
		p.sessionRepositories.set("sess-mirror", "repo-1");
		p.repositories.set("repo-1", { id: "repo-1", linearWorkspaceId: WS });
		p.operatorSessions.register({
			mirrorSessionId: "sess-mirror",
			mirrorIssueId: "CKP-1",
			clientSessionId: SESSION,
			clientIssueId: ISSUE,
			clientWorkspaceId: WS,
			cockpitWorkspaceId: "cockpit",
			repositoryId: "repo-1",
			startedAt,
			ownsDelivery: true,
		});
		return p;
	}

	it("holds what the run recorded for the client, not its closing words", () => {
		const p = mirrorRun(worker, new Date(Date.now() - 60_000).toISOString());
		p.scopeApprovals.recordOperatorNote(
			ISSUE,
			"internal reading",
			undefined,
			"Your dashboard now explains itself. See it: https://x/pull/9",
		);

		const held = p.holdCompletionForVerification(
			"sess-mirror",
			"Hand-off recorded. Two things flagged for you.\n\n---\n\nYour dashboard…",
			false,
		);

		expect(held).toBe(true);
		const summary = p.verificationGate.get(ISSUE)?.summary;
		expect(summary).toBe(
			"Your dashboard now explains itself. See it: https://x/pull/9",
		);
		// The reviewer-addressed preamble never becomes the client's text.
		expect(summary).not.toContain("flagged for you");
	});

	it("falls back to the final message when the run recorded nothing", () => {
		const p = mirrorRun(worker, new Date(Date.now() - 60_000).toISOString());

		p.holdCompletionForVerification(
			"sess-mirror",
			"All done. https://x/pull/9",
			false,
		);

		expect(p.verificationGate.get(ISSUE)?.summary).toBe(
			"All done. https://x/pull/9",
		);
	});

	it("ignores a summary recorded before this run started", () => {
		// The field persists across runs; a previous run's client text is
		// the same stale-artefact problem the hand-off guard already fixed.
		const p = mirrorRun(worker, new Date(Date.now() + 60_000).toISOString());
		p.scopeApprovals.recordOperatorNote(
			ISSUE,
			"reading",
			undefined,
			"A summary from a previous run.",
		);

		p.holdCompletionForVerification(
			"sess-mirror",
			"This run's message.",
			false,
		);

		expect(p.verificationGate.get(ISSUE)?.summary).toBe("This run's message.");
	});
});

describe("restart and merge hygiene (v3.1)", () => {
	let worker: EdgeWorker;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
	});
	const mergedFacts = async () => ({
		headSha: "x",
		files: [],
		truncated: false,
		merged: true,
		closed: true,
		mergeCommitSha: "m1",
	});

	it("a close-out that fails to post is retried, and the client's issue is not completed in silence", async () => {
		const p = delivered(worker);
		p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
		p.mintGitHubTokenForRepo = vi.fn(async () => "tok");
		p.fetchPullRequestFacts = vi.fn(mergedFacts);
		const post = vi
			.fn()
			.mockRejectedValueOnce(new Error("502"))
			.mockResolvedValue("a1");
		p.agentSessionManager.postResponseActivityStrict = post;
		const comment = vi.fn(async () => {});
		p.cockpitMirror.commentOnMirror = comment;
		const complete = vi.fn(async () => {});
		p.moveIssueToCompletedState = complete;

		await p.checkForClientMerge(ISSUE);
		expect(complete).not.toHaveBeenCalled();
		expect(p.verificationGate.get(ISSUE)?.mergedAt).toBeUndefined();
		expect(
			comment.mock.calls.some((c) => String(c[1]).includes("did not post")),
		).toBe(true);

		await p.checkForClientMerge(ISSUE);
		expect(post).toHaveBeenCalledTimes(2);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(p.verificationGate.get(ISSUE)?.mergedAt).toBeTruthy();
	});

	it("the closed-without-merging notice survives a restart", async () => {
		const p = delivered(worker);
		p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
		p.mintGitHubTokenForRepo = vi.fn(async () => "tok");
		p.fetchPullRequestFacts = vi.fn(async () => ({
			headSha: "x",
			files: [],
			truncated: false,
			merged: false,
			closed: true,
		}));
		const comment = vi.fn(async () => {});
		p.cockpitMirror.commentOnMirror = comment;

		await p.checkForClientMerge(ISSUE);
		// A restart: the in-memory guards are gone, the record is restored.
		p.verificationGate.restore(p.verificationGate.serialize());
		await p.checkForClientMerge(ISSUE);

		expect(comment).toHaveBeenCalledTimes(1);
	});

	it("an unreadable poll is journaled once, not silent and not per tick", async () => {
		const p = delivered(worker);
		p.mintGitHubTokenForRepo = vi.fn(async () => undefined);
		const event = vi.spyOn(p.logger, "event");

		await p.checkForClientMerge(ISSUE);
		await p.checkForClientMerge(ISSUE);

		const lines = event.mock.calls.filter(
			(c) => c[0] === "merge_poll_unreadable",
		);
		expect(lines).toHaveLength(1);
		expect(lines[0][1]).toMatchObject({ reason: "no_github_token" });
	});
});
