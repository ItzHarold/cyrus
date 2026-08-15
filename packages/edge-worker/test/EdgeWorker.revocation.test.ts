import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { LaneManager } from "../src/LaneManager.js";

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");

/**
 * PON-115: Linear's PermissionChange webhook reports team access changing —
 * it is not an explicit "uninstalled" event, and its payload carries only the
 * delta, not the resulting access set. Revocation is therefore confirmed with
 * the tenant's own token rather than inferred, and a confirmed revocation
 * must stop that tenant without touching any other.
 */
describe("EdgeWorker tenant revocation (PON-115)", () => {
	const WS_A = "workspace-aaaa";
	const WS_B = "workspace-bbbb";

	let configPath: string;
	let worker: any;
	let trackerA: any;
	let trackerB: any;
	let stoppedSessions: string[];

	const permissionChange = (ws: string, overrides: any = {}) => ({
		type: "PermissionChange",
		action: "update",
		organizationId: ws,
		appUserId: `app-${ws}`,
		oauthClientId: "client-1",
		addedTeamIds: [],
		removedTeamIds: ["team-1"],
		canAccessAllPublicTeams: false,
		createdAt: new Date().toISOString(),
		...overrides,
	});

	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-revocation-"));
		configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				repositories: [],
				linearWorkspaces: {
					[WS_A]: { linearToken: "tok-a", appUserId: `app-${WS_A}` },
					[WS_B]: { linearToken: "tok-b", appUserId: `app-${WS_B}` },
				},
			}),
			"utf-8",
		);

		stoppedSessions = [];
		trackerA = {
			fetchTeams: vi.fn().mockResolvedValue({ nodes: [{ id: "team-1" }] }),
			fetchCurrentUser: vi.fn().mockResolvedValue({ id: `app-${WS_A}` }),
		};
		trackerB = {
			fetchTeams: vi.fn().mockResolvedValue({ nodes: [{ id: "team-9" }] }),
			fetchCurrentUser: vi.fn().mockResolvedValue({ id: `app-${WS_B}` }),
		};

		worker = Object.create(EdgeWorker.prototype);
		worker.configPath = configPath;
		worker.config = {
			linearWorkspaces: JSON.parse(readFileSync(configPath, "utf-8"))
				.linearWorkspaces,
		};
		worker.issueTrackers = new Map([
			[WS_A, trackerA],
			[WS_B, trackerB],
		]);
		worker.repositories = new Map([
			["repo-a", { id: "repo-a", linearWorkspaceId: WS_A }],
			["repo-b", { id: "repo-b", linearWorkspaceId: WS_B }],
		]);
		worker.sessionRepositories = new Map([
			["s-a", "repo-a"],
			["s-b", "repo-b"],
		]);
		worker.laneManager = new LaneManager(() => true);
		worker.laneGraceTimers = new Map();
		worker.agentSessionManager = {
			getSession: vi.fn().mockReturnValue({ agentRunner: { stop: vi.fn() } }),
			requestSessionStop: vi.fn((id: string) => stoppedSessions.push(id)),
		};
		worker.logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			event: vi.fn(),
		};
		worker.savePersistedState = vi.fn().mockResolvedValue(undefined);
	});

	const readWs = () =>
		JSON.parse(readFileSync(configPath, "utf-8")).linearWorkspaces;

	it("does NOT deactivate when access remains after a scope change", async () => {
		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(readWs()[WS_A].active).toBeUndefined();
		expect(stoppedSessions).toEqual([]);
	});

	it("deactivates when the tenant's token no longer authenticates", async () => {
		trackerA.fetchTeams.mockRejectedValue(new Error("401 Unauthorized"));
		trackerA.fetchCurrentUser.mockRejectedValue(new Error("401 Unauthorized"));

		await worker.handlePermissionChange(permissionChange(WS_A));

		const ws = readWs();
		expect(ws[WS_A].active).toBe(false);
		expect(ws[WS_A].revokedAt).toBeTruthy();
		// the other tenant is untouched
		expect(ws[WS_B].active).toBeUndefined();
	});

	it("deactivates when no teams remain reachable", async () => {
		trackerA.fetchTeams.mockResolvedValue({ nodes: [] });

		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(readWs()[WS_A].active).toBe(false);
	});

	it("stops only the revoked tenant's sessions", async () => {
		trackerA.fetchTeams.mockResolvedValue({ nodes: [] });

		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(stoppedSessions).toEqual(["s-a"]);
	});

	it("frees the revoked tenant's lane and drops its queue, leaving the other lane alone", async () => {
		trackerA.fetchTeams.mockResolvedValue({ nodes: [] });
		worker.laneManager.acquire(WS_A, "s-a");
		worker.laneManager.enqueue(WS_A, {
			sessionId: "s-a2",
			enqueuedAt: new Date().toISOString(),
			webhook: {},
			kind: "created",
		});
		worker.laneManager.acquire(WS_B, "s-b");

		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(worker.laneManager.activeSessionOf(WS_A)).toBe(null);
		expect(worker.laneManager.queueLength(WS_A)).toBe(0);
		// Tenant B keeps working
		expect(worker.laneManager.activeSessionOf(WS_B)).toBe("s-b");
	});

	it("drops the revoked tenant's tracker so no further API calls are possible", async () => {
		trackerA.fetchTeams.mockResolvedValue({ nodes: [] });

		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(worker.issueTrackers.has(WS_A)).toBe(false);
		expect(worker.issueTrackers.has(WS_B)).toBe(true);
	});

	it("stays active when the probe fails for a transient reason", async () => {
		// A network blip must not deactivate a paying tenant.
		trackerA.fetchTeams.mockRejectedValue(new Error("ETIMEDOUT"));
		trackerA.fetchCurrentUser.mockRejectedValue(new Error("ETIMEDOUT"));

		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(readWs()[WS_A].active).toBeUndefined();
		expect(stoppedSessions).toEqual([]);
	});

	it("ignores a permission change for a different app installation", async () => {
		await worker.handlePermissionChange(
			permissionChange(WS_A, { appUserId: "some-other-app" }),
		);

		expect(trackerA.fetchTeams).not.toHaveBeenCalled();
		expect(readWs()[WS_A].active).toBeUndefined();
	});

	it("ignores a permission change for an unconfigured workspace", async () => {
		await worker.handlePermissionChange(permissionChange("workspace-unknown"));

		expect(worker.logger.event).toHaveBeenCalledWith(
			"webhook_unknown_workspace",
			expect.objectContaining({ organizationId: "workspace-unknown" }),
		);
	});

	it("treats a deactivated tenant as unknown for future webhooks", async () => {
		trackerA.fetchTeams.mockResolvedValue({ nodes: [] });
		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(worker.isKnownWorkspace(WS_A)).toBe(false);
		expect(worker.isKnownWorkspace(WS_B)).toBe(true);
	});

	// A full uninstall produces NO webhook — Linear stops delivering to an app
	// it has cut off — so the only signal is a 401 that a refresh cannot fix.
	describe("access loss without a webhook (uninstall)", () => {
		it("deactivates the tenant when its credentials die", async () => {
			await worker.handleTenantAccessLost(WS_A, new Error("401 Unauthorized"));

			const ws = readWs();
			expect(ws[WS_A].active).toBe(false);
			expect(ws[WS_A].revokedAt).toBeTruthy();
			expect(ws[WS_B].active).toBeUndefined();
		});

		it("stops the dead tenant's sessions and frees its lane", async () => {
			worker.laneManager.acquire(WS_A, "s-a");
			worker.laneManager.acquire(WS_B, "s-b");

			await worker.handleTenantAccessLost(WS_A, new Error("401"));

			expect(stoppedSessions).toEqual(["s-a"]);
			expect(worker.laneManager.activeSessionOf(WS_A)).toBe(null);
			expect(worker.laneManager.activeSessionOf(WS_B)).toBe("s-b");
		});

		it("does not re-probe — the caller already proved the token is dead", async () => {
			await worker.handleTenantAccessLost(WS_A, new Error("401"));

			expect(trackerA.fetchTeams).not.toHaveBeenCalled();
			expect(trackerA.fetchCurrentUser).not.toHaveBeenCalled();
		});

		it("collapses repeated failures from in-flight requests into one teardown", async () => {
			await Promise.all([
				worker.handleTenantAccessLost(WS_A, new Error("401")),
				worker.handleTenantAccessLost(WS_A, new Error("401")),
				worker.handleTenantAccessLost(WS_A, new Error("401")),
			]);

			expect(stoppedSessions).toEqual(["s-a"]);
		});

		it("ignores access loss for an unconfigured workspace", async () => {
			await worker.handleTenantAccessLost(
				"workspace-unknown",
				new Error("401"),
			);

			expect(stoppedSessions).toEqual([]);
		});
	});

	it("is idempotent — a repeat revocation does not re-stop sessions", async () => {
		trackerA.fetchTeams.mockResolvedValue({ nodes: [] });
		await worker.handlePermissionChange(permissionChange(WS_A));
		stoppedSessions.length = 0;
		worker.issueTrackers.set(WS_A, trackerA);

		await worker.handlePermissionChange(permissionChange(WS_A));

		expect(stoppedSessions).toEqual([]);
	});
});
