import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Operator-note delivery (PON-169). The `record_operator_note` MCP tool
 * hands (cwd, note) to the EdgeWorker; these tests exercise the harness
 * side: cwd → session resolution, the scope-record write, the cockpit
 * push — and that a failed resolution reports honestly instead of
 * recording against the wrong issue.
 */

const GATED_WS = "gated-workspace-id";
const ISSUE_ID = "issue-uuid-0001";
const SESSION_ID = "agent-session-0001";
const WORKSPACE_PATH = "/test/workspaces/DVV-42";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function registerSession(worker: EdgeWorker) {
	privates(worker).agentSessionManager.createCyrusAgentSession(
		SESSION_ID,
		ISSUE_ID,
		{
			id: ISSUE_ID,
			identifier: "DVV-42",
			title: "Add CSV export",
			description: "Customers want to export the table",
			branchName: "dvv-42",
		},
		{ path: WORKSPACE_PATH, isGitWorktree: false },
	);
}

describe("EdgeWorker - operator note delivery (PON-169)", () => {
	let worker: EdgeWorker;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
		privates(worker).config.linearWorkspaces = {
			[GATED_WS]: { linearToken: "t1" },
		};
		privates(worker).savePersistedStateStrict = vi
			.fn()
			.mockResolvedValue(undefined);
		registerSession(worker);
	});

	it("records the note on the issue's scope record, keyed by the session's cwd", async () => {
		const result = await privates(worker).deliverOperatorNote(
			WORKSPACE_PATH,
			"## Approach\ninternal reading",
		);
		expect(result).toEqual({ ok: true });
		expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.operatorNote).toBe(
			"## Approach\ninternal reading",
		);
	});

	it("a cwd inside the workspace resolves too (session shells in a subdirectory)", async () => {
		const result = await privates(worker).deliverOperatorNote(
			`${WORKSPACE_PATH}/packages/api`,
			"reading",
		);
		expect(result).toEqual({ ok: true });
		expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.operatorNote).toBe(
			"reading",
		);
	});

	it("pushes the note into the cockpit mirror for the session's workspace", async () => {
		privates(worker).sessionRepositories.set(SESSION_ID, "repo-1");
		privates(worker).repositories.set("repo-1", {
			id: "repo-1",
			linearWorkspaceId: GATED_WS,
		});
		const setOperatorNote = vi
			.spyOn(privates(worker).cockpitMirror, "setOperatorNote")
			.mockResolvedValue(undefined);

		await privates(worker).deliverOperatorNote(WORKSPACE_PATH, "reading");

		expect(setOperatorNote).toHaveBeenCalledWith(
			{ issueId: ISSUE_ID, issueIdentifier: "DVV-42" },
			GATED_WS,
			"reading",
			undefined,
		);
	});

	it("an unresolvable cwd reports NOT recorded and stores nothing", async () => {
		const result = await privates(worker).deliverOperatorNote(
			"/nowhere/else",
			"reading",
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("/nowhere/else");
		expect(privates(worker).scopeApprovals.size).toBe(0);
	});

	it("the cyrus-tools options always carry the delivery hook", () => {
		const options = privates(worker).createCyrusToolsOptions("parent-1");
		expect(options.operatorNotes?.deliver).toBeTypeOf("function");
	});

	it("captures the client scope alongside the note and hands both to the mirror (PON-170)", async () => {
		privates(worker).sessionRepositories.set(SESSION_ID, "repo-1");
		privates(worker).repositories.set("repo-1", {
			id: "repo-1",
			linearWorkspaceId: GATED_WS,
		});
		const setOperatorNote = vi
			.spyOn(privates(worker).cockpitMirror, "setOperatorNote")
			.mockResolvedValue(undefined);

		await privates(worker).deliverOperatorNote(
			WORKSPACE_PATH,
			"internal reading",
			"**Outcome** — export works.",
		);

		expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.clientScope).toBe(
			"**Outcome** — export works.",
		);
		expect(setOperatorNote).toHaveBeenCalledWith(
			{ issueId: ISSUE_ID, issueIdentifier: "DVV-42" },
			GATED_WS,
			"internal reading",
			"**Outcome** — export works.",
		);
	});

	it("scope approval composes the operator brief onto the mirror (PON-170)", async () => {
		const upsert = vi
			.spyOn(privates(worker).cockpitMirror, "upsert")
			.mockResolvedValue(undefined);
		await privates(worker).deliverOperatorNote(
			WORKSPACE_PATH,
			"internal reading",
			"**Outcome** — export works.",
		);

		await privates(worker).interpretScopeConfirmReply({
			type: "AgentSessionEvent",
			action: "prompted",
			organizationId: GATED_WS,
			agentSession: {
				id: SESSION_ID,
				issue: { id: ISSUE_ID, identifier: "DVV-42" },
			},
			agentActivity: { content: { body: "Approve scope" } },
		});

		const record = privates(worker).scopeApprovals.get(ISSUE_ID);
		expect(record?.state).toBe("approved");
		expect(upsert).toHaveBeenCalledWith(
			// PON-219: this write is the mirror's BIRTH now, so it has to
			// carry the title and the internal reading. Before, both arrived
			// on an earlier transition that no longer happens — the mirror
			// would have rendered "(untitled)" with no reading on it.
			{
				issueId: ISSUE_ID,
				issueIdentifier: "DVV-42",
				title: "Add CSV export",
				url: undefined,
			},
			GATED_WS,
			// PON-224: born queued — approval parks the work.
			"queued",
			{
				operatorNote: "internal reading",
				// No reviewers configured in this harness — empty, not absent.
				subscriberIds: [],
				brief: {
					clientScope: "**Outcome** — export works.",
					approvedAt: record?.approvedAt,
					revisions: 0,
				},
			},
		);
	});

	it("a broken cockpit does not fail the recording (record is authoritative)", async () => {
		privates(worker).sessionRepositories.set(SESSION_ID, "repo-1");
		privates(worker).repositories.set("repo-1", {
			id: "repo-1",
			linearWorkspaceId: GATED_WS,
		});
		vi.spyOn(
			privates(worker).cockpitMirror,
			"setOperatorNote",
		).mockRejectedValue(new Error("cockpit down"));

		const result = await privates(worker).deliverOperatorNote(
			WORKSPACE_PATH,
			"reading",
		);
		expect(result).toEqual({ ok: true });
		expect(privates(worker).scopeApprovals.get(ISSUE_ID)?.operatorNote).toBe(
			"reading",
		);
	});
});
