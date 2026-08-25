import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Bounded backup retention (PON-148). 75 world-readable copies of a
 * credentials file accumulated over two months before anyone looked — an
 * unbounded pile of token files is a growing target with no upside. Keep
 * the newest few, delete the rest. Best-effort: retention must never fail
 * the write that triggered it.
 */
export const BACKUP_RETENTION_COUNT = 5;

export function pruneBackups(dir: string, pattern: RegExp): void {
	try {
		const backups = readdirSync(dir)
			.filter((name) => pattern.test(name))
			.sort(); // ISO timestamps in the names sort chronologically
		const excess = backups.slice(
			0,
			Math.max(0, backups.length - BACKUP_RETENTION_COUNT),
		);
		for (const name of excess) {
			try {
				unlinkSync(join(dir, name));
			} catch {
				// Best-effort per file.
			}
		}
	} catch {
		// Best-effort overall.
	}
}
