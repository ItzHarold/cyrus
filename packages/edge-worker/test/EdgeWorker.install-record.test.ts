import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");

/**
 * PON-115: each Linear installation issues its own app-user id. Linear's
 * platform docs recommend storing it alongside the token so the agent can
 * identify itself per tenant. Installs authorized before the field existed
 * are backfilled once on boot, using that tenant's own tracker.
 */
describe("EdgeWorker install-record backfill (PON-115)", () => {
	const WS_A = "workspace-aaa";
	const WS_B = "workspace-bbb";

	let configPath: string;
	let worker: EdgeWorker;
	let trackers: Map<string, { fetchCurrentUser: ReturnType<typeof vi.fn> }>;

	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-install-record-"));
		configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				repositories: [],
				linearWorkspaces: {
					[WS_A]: { linearToken: "token-a", laneSerialization: true },
					[WS_B]: {
						linearToken: "token-b",
						appUserId: "already-known",
						installedAt: "2026-01-01T00:00:00.000Z",
					},
				},
			}),
			"utf-8",
		);

		trackers = new Map([
			[WS_A, { fetchCurrentUser: vi.fn().mockResolvedValue({ id: "app-a" }) }],
			[WS_B, { fetchCurrentUser: vi.fn().mockResolvedValue({ id: "app-b" }) }],
		]);

		worker = Object.create(EdgeWorker.prototype) as EdgeWorker;
		(worker as any).configPath = configPath;
		(worker as any).issueTrackers = trackers;
		(worker as any).config = {
			linearWorkspaces: JSON.parse(readFileSync(configPath, "utf-8"))
				.linearWorkspaces,
		};
		(worker as any).logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			event: vi.fn(),
		};
	});

	const readWorkspaces = () =>
		JSON.parse(readFileSync(configPath, "utf-8")).linearWorkspaces;

	it("resolves and persists the app user id for an incomplete install", async () => {
		await (worker as any).backfillWorkspaceInstallRecords();

		const ws = readWorkspaces()[WS_A];
		expect(ws.appUserId).toBe("app-a");
		expect(ws.installedAt).toBeTruthy();
		// existing settings survive the write
		expect(ws.laneSerialization).toBe(true);
		expect(ws.linearToken).toBe("token-a");
	});

	it("uses each tenant's own tracker, never another's", async () => {
		await (worker as any).backfillWorkspaceInstallRecords();

		expect(trackers.get(WS_A)!.fetchCurrentUser).toHaveBeenCalledTimes(1);
		// WS_B is already complete — no call, and certainly not A's id
		expect(trackers.get(WS_B)!.fetchCurrentUser).not.toHaveBeenCalled();
		expect(readWorkspaces()[WS_B].appUserId).toBe("already-known");
	});

	it("leaves a complete install untouched", async () => {
		const before = readWorkspaces()[WS_B];
		await (worker as any).backfillWorkspaceInstallRecords();
		expect(readWorkspaces()[WS_B]).toEqual(before);
	});

	it("a failing tenant does not block the others", async () => {
		trackers
			.get(WS_A)!
			.fetchCurrentUser.mockRejectedValue(new Error("401 revoked"));
		// make WS_B incomplete so there is a second tenant to backfill
		(worker as any).config.linearWorkspaces[WS_B].appUserId = undefined;

		await (worker as any).backfillWorkspaceInstallRecords();

		const ws = readWorkspaces();
		// A failed to resolve but did not throw or abort the pass
		expect(ws[WS_A].appUserId).toBeUndefined();
		expect(ws[WS_B].appUserId).toBe("app-b");
	});

	it("is a no-op — no API calls and no write — when every install is complete", async () => {
		(worker as any).config.linearWorkspaces[WS_A].appUserId = "app-a";
		(worker as any).config.linearWorkspaces[WS_A].installedAt =
			"2026-02-02T00:00:00.000Z";
		const fileBefore = readFileSync(configPath, "utf-8");

		await (worker as any).backfillWorkspaceInstallRecords();

		expect(trackers.get(WS_A)!.fetchCurrentUser).not.toHaveBeenCalled();
		expect(trackers.get(WS_B)!.fetchCurrentUser).not.toHaveBeenCalled();
		// Nothing to persist, so the file is not rewritten at all.
		expect(readFileSync(configPath, "utf-8")).toBe(fileBefore);
	});
});
