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
		const closeOut = vi.fn(async () => {});
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
