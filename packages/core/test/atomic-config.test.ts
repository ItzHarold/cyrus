import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { updateConfigFile, writeConfigAtomicUnlocked } from "../src/index.js";

/**
 * Safe writes to config.json (PON-190).
 *
 * This file holds every tenant's credentials and has four writers across two
 * processes. The properties below are the ones that make losing a client
 * impossible, so they are tested against the real filesystem rather than a
 * mock — a mocked rename proves nothing about atomicity.
 */

function tempConfig(contents?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-atomic-"));
	const path = join(dir, "config.json");
	if (contents !== undefined) {
		writeFileSync(path, JSON.stringify(contents, null, 2), { mode: 0o600 });
	}
	return path;
}

describe("updateConfigFile", () => {
	it("reads inside the lock, so a concurrent write is not lost", () => {
		const path = tempConfig({ workspaces: { a: 1 } });

		// Another process adds a workspace after our caller last read the file.
		writeFileSync(
			path,
			JSON.stringify({ workspaces: { a: 1, b: 2 } }, null, 2),
		);

		// Our caller still holds the stale copy, but the mutator is handed the
		// CURRENT contents — that is the whole point of reading inside the lock.
		updateConfigFile<{ workspaces: Record<string, number> }>(
			path,
			(current) => {
				expect(current?.workspaces).toEqual({ a: 1, b: 2 });
				current!.workspaces.c = 3;
				return current!;
			},
		);

		expect(JSON.parse(readFileSync(path, "utf8")).workspaces).toEqual({
			a: 1,
			b: 2,
			c: 3,
		});
	});

	it("treats a missing file as a first write", () => {
		const path = tempConfig();
		updateConfigFile(path, (current) => {
			expect(current).toBeUndefined();
			return { repositories: [] };
		});
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			repositories: [],
		});
	});

	it("refuses to overwrite a file it could not parse", () => {
		// Replacing malformed JSON with fresh content would delete every tenant
		// on the box because one byte was wrong. Failing loudly is the only
		// safe answer.
		const path = tempConfig();
		writeFileSync(path, "{ this is not json");

		expect(() =>
			updateConfigFile(path, () => ({ repositories: [] })),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe("{ this is not json");
	});

	it("writes credentials at 0600", () => {
		const path = tempConfig();
		updateConfigFile(path, () => ({ linearWorkspaces: { a: { token: "x" } } }));
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("tightens a temp file left behind at a loose mode", () => {
		// `mode` applies only on create, so a leftover 0644 temp file would
		// carry its permissions through the rename onto the credential file.
		const path = tempConfig({ a: 1 });
		writeFileSync(`${path}.tmp`, "{}", { mode: 0o644 });

		updateConfigFile(path, () => ({ a: 2 }));

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("releases the lock so the next write is not blocked", () => {
		const path = tempConfig({ n: 0 });
		for (let i = 1; i <= 3; i++) {
			updateConfigFile<{ n: number }>(path, (c) => ({ n: (c?.n ?? 0) + 1 }));
		}
		expect(JSON.parse(readFileSync(path, "utf8")).n).toBe(3);
	});

	it("breaks a lock left behind by a crashed writer", () => {
		const path = tempConfig({ a: 1 });
		// A holder that died between create and unlink. Without stale-breaking
		// this file could never be written again — a permanent outage needing
		// shell access, which is worse than the race it guards.
		writeFileSync(`${path}.lock`, "");
		const old = new Date(Date.now() - 60_000);
		execFileSync("touch", ["-d", old.toISOString(), `${path}.lock`]);

		updateConfigFile(path, () => ({ a: 2 }));

		expect(JSON.parse(readFileSync(path, "utf8")).a).toBe(2);
	});

	it("serialises genuinely concurrent writers from separate processes", async () => {
		// The real shape: the CLI and the running service writing at once.
		//
		// The children must run CONCURRENTLY for this to prove anything — an
		// earlier version of this test used execFileSync, which runs them one
		// after another, so it passed happily with the lock made
		// non-exclusive. It proved the lock does not break sequential writes
		// and nothing more.
		//
		// Each child sleeps inside the mutator, holding the lock and widening
		// the read-modify-write window so that an unlocked implementation
		// reliably loses updates rather than occasionally.
		const path = tempConfig({ n: 0 });
		const script = `
			const { updateConfigFile } = require(${JSON.stringify(
				join(process.cwd(), "dist/index.js"),
			)});
			updateConfigFile(${JSON.stringify(path)}, (c) => {
				const before = (c && c.n) || 0;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
				return { n: before + 1 };
			});
		`;
		await Promise.all(
			Array.from(
				{ length: 5 },
				() =>
					new Promise<void>((res, rej) => {
						const child = spawn(process.execPath, ["-e", script]);
						child.on("exit", (code) =>
							code === 0 ? res() : rej(new Error(`child exited ${code}`)),
						);
						child.on("error", rej);
					}),
			),
		);

		// Five increments, five recorded. Unlocked, the sleeping window makes
		// several children read the same value and the total comes in short.
		expect(JSON.parse(readFileSync(path, "utf8")).n).toBe(5);
	});
});

describe("writeConfigAtomicUnlocked", () => {
	it("leaves no temp file behind", () => {
		const path = tempConfig();
		writeConfigAtomicUnlocked(path, { a: 1 });
		expect(() => statSync(`${path}.tmp`)).toThrow();
		expect(JSON.parse(readFileSync(path, "utf8")).a).toBe(1);
	});
});
