import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");

/**
 * PON-112 regression, found during the PON-115 audit.
 *
 * saveOAuthTokens used to REBUILD config.linearWorkspaces[id] from scratch,
 * carrying forward only the refresh token and workspace name. Every other
 * per-workspace setting was silently dropped — so a routine token refresh
 * turned a tenant's serialized lane back off, and would drop any setting
 * added to that object later.
 */
describe("EdgeWorker.saveOAuthTokens (PON-112 regression)", () => {
	let configPath: string;
	let worker: EdgeWorker;

	const WS = "workspace-1";

	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-oauth-save-"));
		configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				repositories: [],
				linearWorkspaces: {
					[WS]: {
						linearToken: "old-token",
						linearRefreshToken: "old-refresh",
						linearWorkspaceName: "Tenant One",
						linearWorkspaceSlug: "tenant-one",
						laneSerialization: true,
					},
				},
			}),
			"utf-8",
		);

		// Exercise saveOAuthTokens directly; constructing a full EdgeWorker is
		// unnecessary for this unit.
		worker = Object.create(EdgeWorker.prototype) as EdgeWorker;
		(worker as any).configPath = configPath;
		(worker as any).logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const readWorkspace = () =>
		JSON.parse(readFileSync(configPath, "utf-8")).linearWorkspaces[WS];

	it("preserves laneSerialization across a token refresh", async () => {
		await (worker as any).saveOAuthTokens({
			linearToken: "new-token",
			linearRefreshToken: "new-refresh",
			linearWorkspaceId: WS,
		});

		const ws = readWorkspace();
		expect(ws.linearToken).toBe("new-token");
		expect(ws.linearRefreshToken).toBe("new-refresh");
		// The whole point: settings unrelated to credentials survive.
		expect(ws.laneSerialization).toBe(true);
		expect(ws.linearWorkspaceSlug).toBe("tenant-one");
		expect(ws.linearWorkspaceName).toBe("Tenant One");
	});

	it("preserves unknown/future per-workspace fields", async () => {
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		config.linearWorkspaces[WS].someFutureSetting = { nested: true };
		writeFileSync(configPath, JSON.stringify(config), "utf-8");

		await (worker as any).saveOAuthTokens({
			linearToken: "new-token",
			linearWorkspaceId: WS,
		});

		expect(readWorkspace().someFutureSetting).toEqual({ nested: true });
	});

	it("keeps the existing refresh token when the refresh response omits one", async () => {
		await (worker as any).saveOAuthTokens({
			linearToken: "new-token",
			linearWorkspaceId: WS,
		});

		expect(readWorkspace().linearRefreshToken).toBe("old-refresh");
	});

	it("creates a workspace entry that did not exist before", async () => {
		await (worker as any).saveOAuthTokens({
			linearToken: "tok",
			linearWorkspaceId: "workspace-2",
			linearWorkspaceName: "Tenant Two",
		});

		const all = JSON.parse(readFileSync(configPath, "utf-8")).linearWorkspaces;
		expect(all["workspace-2"]).toEqual({
			linearToken: "tok",
			linearWorkspaceName: "Tenant Two",
		});
		// and the other tenant is untouched
		expect(all[WS].laneSerialization).toBe(true);
	});

	it("tightens config file permissions to 0600 (it holds tenant tokens)", async () => {
		await (worker as any).saveOAuthTokens({
			linearToken: "new-token",
			linearWorkspaceId: WS,
		});

		expect(statSync(configPath).mode & 0o777).toBe(0o600);
	});
});
