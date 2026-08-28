import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-200: a re-delegated issue went silent forever.
 *
 * Linear creates an AgentSession by itself on the FIRST delegation, so the
 * `issueAssignedToYou` notification was treated as redundant and dispatched to
 * `return`. On a RE-delegation it is the only signal there is: the issue
 * already carries a session, Linear creates nothing, and the notification was
 * dropped. Observed live on ACM-10 — a client unassigned and re-assigned the
 * agent twice, got two farewells and no work, and abandoned the issue.
 */

const WS = "ws-assign";
const ISSUE_ID = "issue-acm-10";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

const assignedWebhook = {
	type: "AppUserNotification",
	action: "issueAssignedToYou",
	organizationId: WS,
	notification: { issue: { id: ISSUE_ID, identifier: "ACM-10" } },
};

function setup(sessions: { id: string; status: AgentSessionStatus }[] = []) {
	const worker = createTestWorker([]);
	const p = privates(worker);
	p.assignmentRecoveryDelayMs = 5;
	p.agentSessionManager.getSessionsByIssueId = vi
		.fn()
		.mockReturnValue(sessions);
	const createAgentSessionOnIssue = vi
		.fn()
		.mockResolvedValue({ success: true });
	p.issueTrackers.set(WS, { createAgentSessionOnIssue });
	return { worker, p, createAgentSessionOnIssue };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("EdgeWorker - re-delegation recovery (PON-200)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("creates the session Linear did not, when the issue has none live", async () => {
		const { p, createAgentSessionOnIssue } = setup([
			{ id: "old", status: AgentSessionStatus.Complete },
		]);

		await p.handleIssueAssignedWebhook(assignedWebhook);
		await settle();

		expect(createAgentSessionOnIssue).toHaveBeenCalledWith({
			issueId: ISSUE_ID,
		});
	});

	it("does NOT create one when Linear already made a live session", async () => {
		// The first-delegation case: the notification and Linear's own session
		// arrive together, and creating here would give the issue two.
		const { p, createAgentSessionOnIssue } = setup([
			{ id: "live", status: AgentSessionStatus.Active },
		]);

		await p.handleIssueAssignedWebhook(assignedWebhook);
		await settle();

		expect(createAgentSessionOnIssue).not.toHaveBeenCalled();
	});

	it("checks AFTER the grace window, not on arrival", async () => {
		// A session that appears during the window (Linear's own) suppresses
		// the recovery — the check has to read the state at the end.
		const sessions: { id: string; status: AgentSessionStatus }[] = [];
		const { p, createAgentSessionOnIssue } = setup(sessions);

		await p.handleIssueAssignedWebhook(assignedWebhook);
		sessions.push({ id: "linears-own", status: AgentSessionStatus.Active });
		await settle();

		expect(createAgentSessionOnIssue).not.toHaveBeenCalled();
	});

	it("collapses a flurry of assignee flips into one recovery", async () => {
		const { p, createAgentSessionOnIssue } = setup();

		await p.handleIssueAssignedWebhook(assignedWebhook);
		await p.handleIssueAssignedWebhook(assignedWebhook);
		await p.handleIssueAssignedWebhook(assignedWebhook);
		await settle();

		expect(createAgentSessionOnIssue).toHaveBeenCalledTimes(1);
	});

	it("survives a failed creation — no worse than before the fix", async () => {
		const { p, createAgentSessionOnIssue } = setup();
		createAgentSessionOnIssue.mockRejectedValue(new Error("api down"));

		await p.handleIssueAssignedWebhook(assignedWebhook);
		await expect(settle()).resolves.toBeUndefined();
	});

	it("is actually WIRED — the dispatch reaches it (this branch used to `return`)", async () => {
		const { worker, p, createAgentSessionOnIssue } = setup();
		// Route the real webhook through the real dispatch, which is where the
		// bug lived: the branch existed and did nothing.
		await privates(worker).handleWebhook(assignedWebhook, [
			{ id: "repo-1", name: "Acme-Metrics", linearWorkspaceId: WS },
		]);
		await settle();

		expect(p.pendingAssignmentRecoveries.size).toBe(0);
		expect(createAgentSessionOnIssue).toHaveBeenCalledWith({
			issueId: ISSUE_ID,
		});
	});

	it("ignores a notification with no issue or no workspace", async () => {
		const { p, createAgentSessionOnIssue } = setup();

		await p.handleIssueAssignedWebhook({
			...assignedWebhook,
			notification: {},
		});
		await p.handleIssueAssignedWebhook({
			...assignedWebhook,
			organizationId: undefined,
		});
		await settle();

		expect(createAgentSessionOnIssue).not.toHaveBeenCalled();
	});
});
