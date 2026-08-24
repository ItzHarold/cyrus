import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PersistenceManager } from "../src/PersistenceManager.js";

/**
 * State saves must be atomic and serialized (PON-151 review): the state file
 * carries every lane queue, session, and scope approval, and fire-and-forget
 * writers made concurrent saves routine. Interleaved plain writes could tear
 * the JSON, silently resetting ALL state at the next boot.
 */
describe("PersistenceManager - atomic serialized saves", () => {
	const makeManager = () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-persist-test-"));
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			event: vi.fn(),
			withContext: vi.fn().mockReturnThis(),
		} as never;
		return { manager: new PersistenceManager(dir, logger), dir };
	};

	it("many concurrent saves leave a valid file containing the last state", async () => {
		const { manager, dir } = makeManager();
		await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				manager.saveEdgeWorkerState({
					issueRepositoryCache: { [`issue-${i}`]: [`repo-${i}`] },
				}),
			),
		);
		const raw = await readFile(join(dir, "edge-worker-state.json"), "utf8");
		const parsed = JSON.parse(raw); // a torn write would throw here
		expect(parsed.state.issueRepositoryCache["issue-24"]).toEqual(["repo-24"]);

		const loaded = await manager.loadEdgeWorkerState();
		expect(loaded?.issueRepositoryCache?.["issue-24"]).toEqual(["repo-24"]);
	});

	it("no temp file is left behind after a save", async () => {
		const { manager, dir } = makeManager();
		await manager.saveEdgeWorkerState({ issueRepositoryCache: {} });
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(dir, "edge-worker-state.json.tmp"))).toBe(false);
		expect(existsSync(join(dir, "edge-worker-state.json"))).toBe(true);
	});
});
