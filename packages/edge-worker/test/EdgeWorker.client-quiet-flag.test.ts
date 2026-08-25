import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * The clientQuiet flag (PON-182): explicit value wins, independent of the
 * gates; absent falls back to gate-derived — preserving pre-flag behaviour
 * with zero config edits.
 */

const WS = "ws-flag-test";
const SESSION_ID = "agent-session-flag-1";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function setup(workspaceConfig: Record<string, unknown>) {
	const worker = createTestWorker([]);
	privates(worker).config.linearWorkspaces = { [WS]: workspaceConfig };
	privates(worker).agentSessionManager.createCyrusAgentSession(
		SESSION_ID,
		"issue-1",
		{
			id: "issue-1",
			identifier: "FLG-1",
			title: "t",
			description: "d",
			branchName: "b",
		},
		{ path: "/test/repo", isGitWorktree: false },
	);
	privates(worker).sessionRepositories.set(SESSION_ID, "repo-1");
	privates(worker).repositories.set("repo-1", {
		id: "repo-1",
		linearWorkspaceId: WS,
	});
	return worker;
}

describe("EdgeWorker - clientQuiet flag (PON-182)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("clientQuiet: true quiets a workspace whose gates are OFF — no workflow change", () => {
		const worker = setup({
			linearToken: "t",
			scopeConfirmGate: false,
			verifyBeforeDelivery: false,
			clientQuiet: true,
		});
		expect(privates(worker).clientQuietSession(SESSION_ID)).toBe(true);
	});

	it("clientQuiet: false shows narration on a gated workspace", () => {
		const worker = setup({ linearToken: "t", clientQuiet: false });
		expect(privates(worker).clientQuietSession(SESSION_ID)).toBe(false);
	});

	it("absent = gate-derived: gates off → loud, gates default-on → quiet", () => {
		const loud = setup({
			linearToken: "t",
			scopeConfirmGate: false,
			verifyBeforeDelivery: false,
		});
		expect(privates(loud).clientQuietSession(SESSION_ID)).toBe(false);

		const quiet = setup({ linearToken: "t" });
		expect(privates(quiet).clientQuietSession(SESSION_ID)).toBe(true);
	});
});
