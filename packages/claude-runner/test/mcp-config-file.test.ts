import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SDK passes `mcpServers` to the CLI as `--mcp-config <inline JSON>`, so
 * every header in it — the tenant's Linear OAuth bearer token among them —
 * sat in the child's argv for the whole session, readable by any local
 * process (`/proc/<pid>/cmdline`). Found on agent-prod on 2026-09-01 by a
 * process listing that printed it (PON-223, finding B).
 *
 * The CLI also accepts a file for --mcp-config. These tests pin: the token
 * is not in anything argv-bound, the file is 0600 in a 0700 directory, it is
 * deleted when the session ends, in-process servers stay inline, and a write
 * failure falls back inline rather than refusing to start.
 */

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../src/sandbox-requirements", () => ({
	checkLinuxSandboxRequirements: vi.fn(() => ({
		supported: true,
		platform: "linux",
		failures: [],
	})),
	logSandboxRequirementFailures: vi.fn(),
	resetSandboxRequirementsCacheForTesting: vi.fn(),
}));
vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
	chmodSync: vi.fn(),
	unlinkSync: vi.fn(),
}));
vi.mock("os", () => ({ homedir: vi.fn(() => "/mock/home") }));

import * as fs from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

const TOKEN = "lin_oauth_TESTTOKEN_0123456789abcdef";
const HOME = "/tmp/test-cyrus-home";

const linear = {
	type: "http",
	url: "https://mcp.linear.app/mcp",
	headers: { Authorization: `Bearer ${TOKEN}` },
};

function config(extra: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig {
	return {
		cyrusHome: HOME,
		workingDirectory: "/tmp/wd",
		mcpConfig: { linear } as never,
		...extra,
	};
}

function lastOptions(): Record<string, any> {
	const calls = vi.mocked(query).mock.calls;
	return (calls[calls.length - 1]?.[0] as any).options;
}

describe("the MCP config stays off the child's argv", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// clearAllMocks keeps implementations; the write-failure test below
		// installs a throwing one, so restore the default here.
		vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
		vi.mocked(query).mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "Done" }] },
				parent_tool_use_id: null,
				session_id: "test-session",
			} as any;
		});
	});

	it("hands the CLI a 0600 file instead of inline JSON, and the token is in nothing argv-bound", async () => {
		await new ClaudeRunner(config()).start("hi");

		const opts = lastOptions();
		expect(opts.mcpServers).toBeUndefined();
		const path = opts.extraArgs?.["mcp-config"];
		expect(path).toMatch(
			new RegExp(`^${HOME}/runtime/mcp/mcp-[0-9a-f]{16}\\.json$`),
		);
		expect(JSON.stringify(opts)).not.toContain(TOKEN);
		expect(opts.strictMcpConfig).toBe(true);

		expect(fs.mkdirSync).toHaveBeenCalledWith(`${HOME}/runtime/mcp`, {
			recursive: true,
			mode: 0o700,
		});
		const written = vi
			.mocked(fs.writeFileSync)
			.mock.calls.find((c) => c[0] === path);
		expect(written).toBeDefined();
		expect(JSON.parse(String(written?.[1])).mcpServers.linear).toEqual(linear);
		expect(written?.[2]).toEqual({ mode: 0o600 });
		expect(fs.chmodSync).toHaveBeenCalledWith(path, 0o600);
	});

	it("deletes the file when the session ends", async () => {
		await new ClaudeRunner(config()).start("hi");

		const path = lastOptions().extraArgs["mcp-config"];
		expect(fs.unlinkSync).toHaveBeenCalledWith(path);
	});

	it("keeps an in-process (sdk) server inline — it cannot live in a file and carries no credential", async () => {
		const tools = { type: "sdk", name: "tools", instance: {} };
		await new ClaudeRunner(
			config({ mcpConfig: { linear, tools } as never }),
		).start("hi");

		const opts = lastOptions();
		expect(Object.keys(opts.mcpServers)).toEqual(["tools"]);
		const path = opts.extraArgs["mcp-config"];
		const written = vi
			.mocked(fs.writeFileSync)
			.mock.calls.find((c) => c[0] === path);
		expect(Object.keys(JSON.parse(String(written?.[1])).mcpServers)).toEqual([
			"linear",
		]);
	});

	it("still starts the session, inline, when the file cannot be written", async () => {
		// A session that cannot start is worse for the client than a
		// credential visible to root on a box root already owns. The lapse is
		// a warning in the journal, not a refusal — a deliberate fail-open.
		vi.mocked(fs.writeFileSync).mockImplementation((p) => {
			if (String(p).includes("/runtime/mcp/")) throw new Error("EROFS");
		});
		await new ClaudeRunner(config()).start("hi");

		const opts = lastOptions();
		expect(opts.mcpServers?.linear).toEqual(linear);
		expect(opts.extraArgs?.["mcp-config"]).toBeUndefined();
		expect(fs.unlinkSync).not.toHaveBeenCalled();
	});

	it("passes user extraArgs through alongside the file", async () => {
		await new ClaudeRunner(config({ extraArgs: { verbose: null } })).start(
			"hi",
		);

		const opts = lastOptions();
		expect(opts.extraArgs.verbose).toBeNull();
		expect(opts.extraArgs["mcp-config"]).toBeDefined();
	});
});
