import {
	LINEAR_MCP_READ_TOOLS,
	LINEAR_MCP_WRITE_TOOLS,
	type RepositoryConfig,
} from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { ToolPermissionResolver } from "../src/ToolPermissionResolver.js";

/**
 * PON-194: a session holds the TENANT's own Linear OAuth token through the
 * Linear MCP server. A bare `mcp__linear` grant therefore let a model write
 * comments and issues into a client's tracker outside every content policy,
 * every quiet suppression and every static sweep — the one client surface no
 * posting funnel could see.
 *
 * Now that the machinery composes every client-facing message, sessions on
 * client-flow workspaces get the read half and nothing else.
 */

const CLIENT_WS = "ws-client";
const OURS_WS = "ws-ours";

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	event: vi.fn(),
} as never;

function repo(id: string, workspaceId: string, extra = {}): RepositoryConfig {
	return {
		id,
		name: id,
		repositoryPath: `/repo/${id}`,
		baseBranch: "main",
		linearWorkspaceId: workspaceId,
		workspaceBaseDir: "/w",
		isActive: true,
		...extra,
	} as RepositoryConfig;
}

function resolver(extraConfig = {}) {
	return new ToolPermissionResolver(
		{
			linearWorkspaces: {
				// Absent flags mean both gates are ON — a workspace nobody has
				// configured is treated as a client's.
				[CLIENT_WS]: { linearToken: "t" },
				// The dev partnership teams opted out of both gates.
				[OURS_WS]: {
					linearToken: "t",
					scopeConfirmGate: false,
					verifyBeforeDelivery: false,
				},
			},
			...extraConfig,
		} as never,
		logger,
	);
}

describe("Linear MCP write floor (PON-194)", () => {
	it("a client workspace gets the read half and no write tool", () => {
		const allowed = resolver().buildAllowedTools(repo("r1", CLIENT_WS));
		expect(allowed).not.toContain("mcp__linear");
		for (const write of LINEAR_MCP_WRITE_TOOLS) {
			expect(allowed).not.toContain(write);
		}
		for (const read of LINEAR_MCP_READ_TOOLS) {
			expect(allowed).toContain(read);
		}
	});

	it("names what stays reachable: its own issue, comments, teams, docs", () => {
		const allowed = resolver().buildAllowedTools(repo("r1", CLIENT_WS));
		expect(allowed).toContain("mcp__linear__get_issue");
		expect(allowed).toContain("mcp__linear__list_comments");
		expect(allowed).toContain("mcp__linear__list_issues");
		expect(allowed).toContain("mcp__linear__get_team");
		expect(allowed).toContain("mcp__linear__search_documentation");
		// And the machinery's own tools are untouched — the operator note and
		// the failure log do not go through the Linear server.
		expect(allowed).toContain("mcp__cyrus-tools");
	});

	it("denies the writes explicitly too, not only by omission", () => {
		const disallowed = resolver().buildDisallowedTools(repo("r1", CLIENT_WS));
		for (const write of LINEAR_MCP_WRITE_TOOLS) {
			expect(disallowed).toContain(write);
		}
	});

	it("leaves our own workspaces alone — the orchestrator still creates sub-issues", () => {
		const allowed = resolver().buildAllowedTools(repo("r1", OURS_WS));
		expect(allowed).toContain("mcp__linear");
		const disallowed = resolver().buildDisallowedTools(repo("r1", OURS_WS));
		expect(disallowed).not.toContain("mcp__linear__save_issue");
	});

	it("overrides operator config — no config path grants a client-tracker write", () => {
		// An operator naming the write tool explicitly still does not get it.
		const allowed = resolver().buildAllowedTools(
			repo("r1", CLIENT_WS, {
				allowedTools: ["Read", "mcp__linear__save_issue", "mcp__linear"],
			}),
		);
		expect(allowed).toContain("Read");
		expect(allowed).not.toContain("mcp__linear__save_issue");
		expect(allowed).not.toContain("mcp__linear");
		expect(allowed).toContain("mcp__linear__get_issue");
	});

	it("one client repository in a multi-repo session is enough — strictest wins", () => {
		// Allowed lists are unioned and disallowed lists intersected, so this
		// is the case where a floor applied per-repo would leak.
		const repos = [repo("ours", OURS_WS), repo("client", CLIENT_WS)];
		const allowed = resolver().buildAllowedTools(repos);
		expect(allowed).not.toContain("mcp__linear");
		expect(allowed).not.toContain("mcp__linear__save_comment");
		const disallowed = resolver().buildDisallowedTools(repos);
		expect(disallowed).toContain("mcp__linear__save_comment");
	});

	it("an unknown workspace is not treated as a client's", () => {
		// Nothing to gate on: this is the GitHub/standalone path, not a tenant.
		const allowed = resolver().buildAllowedTools(repo("r1", "ws-unknown"));
		expect(allowed).toContain("mcp__linear");
	});

	it("a workspace with only ONE gate on is still a client's", () => {
		const r = new ToolPermissionResolver(
			{
				linearWorkspaces: {
					"ws-half": {
						linearToken: "t",
						scopeConfirmGate: false,
						verifyBeforeDelivery: true,
					},
				},
			} as never,
			logger,
		);
		const allowed = r.buildAllowedTools(repo("r1", "ws-half"));
		expect(allowed).not.toContain("mcp__linear");
		expect(allowed).toContain("mcp__linear__get_issue");
	});

	it("the read and write halves are disjoint and cover the server", () => {
		const reads = new Set<string>(LINEAR_MCP_READ_TOOLS);
		const writes = new Set<string>(LINEAR_MCP_WRITE_TOOLS);
		for (const w of writes) expect(reads.has(w)).toBe(false);
		// 57 tools enumerated live from mcp.linear.app on 2026-08-28.
		expect(reads.size + writes.size).toBe(57);
	});
});
