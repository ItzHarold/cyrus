import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Workspace token liveness (PON-136). The tick is a new CLOCK for existing
 * behaviour: it pings through `tenantStillHasAccess` (whose tracker client
 * auto-refreshes on 401, so the ping DRIVES refresh) and routes conclusive
 * failures through the PON-115 path. A passing ping is silent; inactive
 * workspaces are skipped (recovery is hot-reload's job).
 */

const WS_A = "ws-live-a";
const WS_B = "ws-live-b";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function setup(workspaces: Record<string, Record<string, unknown>>) {
	const worker = createTestWorker([]);
	privates(worker).config.linearWorkspaces = workspaces;
	for (const id of Object.keys(workspaces)) {
		privates(worker).issueTrackers.set(id, { fetchTeams: vi.fn() });
	}
	return worker;
}

describe("EdgeWorker - workspace liveness (PON-136)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("a passing ping is silent — no deactivation, no events", async () => {
		const worker = setup({ [WS_A]: { linearToken: "t" } });
		privates(worker).tenantStillHasAccess = vi.fn().mockResolvedValue(true);
		const lost = vi
			.spyOn(privates(worker), "handleTenantAccessLost" as never)
			.mockResolvedValue(undefined as never);

		await privates(worker).runWorkspaceLivenessTick();

		expect(privates(worker).tenantStillHasAccess).toHaveBeenCalledWith(WS_A);
		expect(lost).not.toHaveBeenCalled();
	});

	it("a conclusive failure routes through the PON-115 path", async () => {
		const worker = setup({
			[WS_A]: { linearToken: "t" },
			[WS_B]: { linearToken: "t2" },
		});
		privates(worker).tenantStillHasAccess = vi
			.fn()
			.mockImplementation(async (id: string) => id !== WS_B);
		const lost = vi
			.spyOn(privates(worker), "handleTenantAccessLost" as never)
			.mockResolvedValue(undefined as never);

		await privates(worker).runWorkspaceLivenessTick();

		expect(lost).toHaveBeenCalledTimes(1);
		expect(lost.mock.calls[0]?.[0]).toBe(WS_B);
	});

	it("inactive workspaces are skipped — recovery belongs to hot-reload", async () => {
		const worker = setup({
			[WS_A]: { linearToken: "t", active: false },
		});
		const probe = vi.fn().mockResolvedValue(true);
		privates(worker).tenantStillHasAccess = probe;

		await privates(worker).runWorkspaceLivenessTick();

		expect(probe).not.toHaveBeenCalled();
	});

	it("workspaces without a tracker are skipped (not yet initialized)", async () => {
		const worker = setup({ [WS_A]: { linearToken: "t" } });
		privates(worker).issueTrackers.delete(WS_A);
		const probe = vi.fn().mockResolvedValue(true);
		privates(worker).tenantStillHasAccess = probe;

		await privates(worker).runWorkspaceLivenessTick();

		expect(probe).not.toHaveBeenCalled();
	});

	it("ticks serialize — a slow tick is never stacked behind itself", async () => {
		const worker = setup({ [WS_A]: { linearToken: "t" } });
		let resolveFirst: (v: boolean) => void = () => {};
		const probe = vi
			.fn()
			.mockImplementationOnce(
				() => new Promise<boolean>((r) => (resolveFirst = r)),
			)
			.mockResolvedValue(true);
		privates(worker).tenantStillHasAccess = probe;

		const first = privates(worker).runWorkspaceLivenessTick();
		const second = privates(worker).runWorkspaceLivenessTick(); // no-op
		resolveFirst(true);
		await Promise.all([first, second]);

		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("armWorkspaceLiveness registers exactly one interval and unrefs it", () => {
		const worker = setup({ [WS_A]: { linearToken: "t" } });
		vi.useFakeTimers();
		try {
			privates(worker).armWorkspaceLiveness();
			const timer = privates(worker).workspaceLivenessTimer;
			expect(timer).toBeDefined();
			privates(worker).armWorkspaceLiveness(); // idempotent
			expect(privates(worker).workspaceLivenessTimer).toBe(timer);
		} finally {
			const timer = privates(worker).workspaceLivenessTimer;
			if (timer) clearInterval(timer);
			vi.useRealTimers();
		}
	});
});
