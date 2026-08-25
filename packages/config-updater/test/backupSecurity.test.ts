import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneBackups } from "../src/backupRetention.js";
import { handleCyrusConfig } from "../src/handlers/cyrusConfig.js";
import { handleCyrusEnv } from "../src/handlers/cyrusEnv.js";

/**
 * PON-148: config-updater wrote tenant tokens to world-readable files — 75
 * 0644 backups accumulated before being shredded. Every write is now 0600
 * by construction (mode on create + chmod for pre-existing files), and
 * backups are bounded.
 */

const mode = (path: string) => statSync(path).mode & 0o777;

describe("config-updater write security (PON-148)", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cyrus-148-"));
	});

	it("config update writes the file AND its backup at 0600", async () => {
		writeFileSync(join(home, "config.json"), "{}", { mode: 0o600 });
		const result = await handleCyrusConfig(
			{ repositories: [], backupConfig: true } as never,
			home,
		);
		expect(result.success).toBe(true);
		expect(mode(join(home, "config.json"))).toBe(0o600);
		const backup = readdirSync(home).find((f) =>
			f.startsWith("config.backup-"),
		);
		expect(backup).toBeDefined();
		expect(mode(join(home, backup as string))).toBe(0o600);
	});

	it("a rewrite of a pre-existing 0644 config CORRECTS it to 0600 — not accidentally correct", async () => {
		writeFileSync(join(home, "config.json"), "{}");
		chmodSync(join(home, "config.json"), 0o644);
		await handleCyrusConfig({ repositories: [] } as never, home);
		expect(mode(join(home, "config.json"))).toBe(0o600);
	});

	it("env update writes the file AND its backup at 0600", async () => {
		writeFileSync(join(home, ".env"), "A=b\n", { mode: 0o600 });
		const result = await handleCyrusEnv(
			{ variables: { A: "c" }, backupEnv: true } as never,
			home,
		);
		expect(result.success).toBe(true);
		expect(mode(join(home, ".env"))).toBe(0o600);
		const backup = readdirSync(home).find((f) => f.startsWith(".env.backup-"));
		expect(backup).toBeDefined();
		expect(mode(join(home, backup as string))).toBe(0o600);
	});

	it("the acceptance sweep finds nothing world-readable after a rotation", async () => {
		writeFileSync(join(home, "config.json"), "{}");
		chmodSync(join(home, "config.json"), 0o644);
		await handleCyrusConfig(
			{ repositories: [], backupConfig: true } as never,
			home,
		);
		const offenders = readdirSync(home).filter(
			(f) => (statSync(join(home, f)).mode & 0o044) !== 0,
		);
		expect(offenders).toEqual([]);
	});

	it("backups are bounded: the newest 5 survive, older ones are pruned", () => {
		for (let i = 0; i < 9; i++) {
			writeFileSync(
				join(home, `config.backup-2026-08-0${i + 1}T00-00-00-000Z.json`),
				"{}",
				{ mode: 0o600 },
			);
		}
		pruneBackups(home, /^config\.backup-.*\.json$/);
		const remaining = readdirSync(home)
			.filter((f) => f.startsWith("config.backup-"))
			.sort();
		expect(remaining).toHaveLength(5);
		expect(remaining[0]).toContain("2026-08-05"); // oldest survivor
	});

	it("retention never fails the write — a vanished directory is swallowed", () => {
		expect(() =>
			pruneBackups(join(home, "does-not-exist"), /backup/),
		).not.toThrow();
		expect(existsSync(join(home, "does-not-exist"))).toBe(false);
	});
});
