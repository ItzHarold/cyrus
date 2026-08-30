import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

/**
 * A hot-reload must not drop a live tenant (PON-190).
 *
 * `config.json` has several writers across two processes, so a file that is
 * momentarily missing a workspace is a real event rather than a hypothetical.
 * Replacing the in-memory map wholesale turned that into a live client's
 * credentials disappearing and their agent silently stopping.
 *
 * The costs are asymmetric: an entry kept slightly too long is inert; an entry
 * dropped is an outage nobody is told about. Deliberate removal has its own
 * path (`active: false`), which must keep working.
 */
function managerWith(initial: Record<string, unknown>, onDisk: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-cfgmgr-"));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify(onDisk));
	const logger = {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		event: () => {},
		withContext: () => logger,
	} as never;
	const manager = new ConfigManager(
		{ linearWorkspaces: initial, repositories: [] } as never,
		logger,
		configPath,
		new Map(),
	);
	return { manager, configPath };
}

const priv = (m: ConfigManager) => m as never as Record<string, any>;

describe("ConfigManager — linearWorkspaces on hot-reload", () => {
	it("keeps a workspace the file no longer mentions", async () => {
		const { manager } = managerWith(
			{ "ws-a": { linearToken: "a" }, "ws-b": { linearToken: "b" } },
			{ repositories: [], linearWorkspaces: { "ws-a": { linearToken: "a" } } },
		);

		// NOTE: loadConfigSafely RETURNS the merged config; it does not assign
		// this.config. Asserting against the instance passed for the wrong
		// reason — it was reading the untouched in-memory map.
		const loaded = await priv(manager).loadConfigSafely();

		// ws-b is absent from the file. Before this fix it vanished, taking a
		// live client's token with it.
		const ws = loaded.linearWorkspaces;
		expect(Object.keys(ws).sort()).toEqual(["ws-a", "ws-b"]);
		expect(ws["ws-b"].linearToken).toBe("b");
	});

	it("lets the file win for a workspace it does mention", async () => {
		const { manager } = managerWith(
			{ "ws-a": { linearToken: "old" } },
			{
				repositories: [],
				linearWorkspaces: { "ws-a": { linearToken: "rotated" } },
			},
		);

		const loaded = await priv(manager).loadConfigSafely();

		// A rotated token must still take effect — the merge is per key, not
		// a refusal to update.
		expect(loaded.linearWorkspaces["ws-a"].linearToken).toBe("rotated");
	});

	it("still applies a deliberate deactivation", async () => {
		const { manager } = managerWith(
			{ "ws-a": { linearToken: "a", active: true } },
			{
				repositories: [],
				linearWorkspaces: { "ws-a": { linearToken: "a", active: false } },
			},
		);

		const loaded = await priv(manager).loadConfigSafely();

		// Removal is by flag, never by omission. That path must survive the
		// merge or this fix would have taken away the only way to remove a
		// tenant.
		expect(loaded.linearWorkspaces["ws-a"].active).toBe(false);
	});
});
