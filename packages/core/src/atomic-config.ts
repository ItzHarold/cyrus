/**
 * Safe writes to `config.json` (PON-190 item 3).
 *
 * This file holds every tenant's credentials, and it has four independent
 * writers across two processes: the CLI's onboarding commands, and the
 * running service's config-updater and token-liveness paths. Every one of
 * them was a plain `writeFileSync` over a read-modify-write.
 *
 * Two distinct failures, needing two distinct protections:
 *
 *   TORN FILE   — two writes interleaving into JSON that no longer parses.
 *                 Fixed by temp + rename, which is atomic on POSIX.
 *   LOST UPDATE — A reads, B reads, A writes, B writes, and A's tenant is
 *                 gone. Rename does NOT fix this: both writes are individually
 *                 perfect and the second still erases the first. It needs a
 *                 lock held across the read AND the write.
 *
 * `PersistenceManager.saveEdgeWorkerState` solved the first for the state
 * file with temp+rename and an in-process chain. An in-process chain is not
 * enough here, because the racing writers are different processes.
 *
 * The lock is an exclusive-create lockfile: portable, no dependency, and
 * visible on disk when something goes wrong. It is deliberately NOT a
 * long-lived lock — it wraps one read-modify-write and nothing else.
 */

import {
	chmodSync,
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

/**
 * How long before a lockfile is presumed abandoned.
 *
 * A holder that crashes between create and unlink would otherwise block every
 * future write forever — the failure mode is worse than the race, because it
 * is permanent and needs a human with shell access. Ten seconds is far longer
 * than any read-modify-write here (a file read, a JSON parse, a rename) and
 * far shorter than a human noticing.
 */
const STALE_LOCK_MS = 10_000;
const RETRY_DELAY_MS = 25;
const MAX_WAIT_MS = 5_000;

/** Makes each writer's temp file its own, so two can never collide. */
let tempCounter = 0;

function sleepSync(ms: number): void {
	// Deliberately blocking: every caller is a synchronous write path, and an
	// async lock here would mean making four call sites async across two
	// packages for a wait that is measured in milliseconds.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath: string): number {
	const deadline = Date.now() + MAX_WAIT_MS;
	for (;;) {
		try {
			// 'wx' — create, or fail if it exists. The atomicity is the point.
			return openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let age = 0;
			try {
				age = Date.now() - statSync(lockPath).mtimeMs;
			} catch {
				// It vanished between the failed create and the stat — the
				// holder released. Retry immediately.
				continue;
			}
			if (age > STALE_LOCK_MS) {
				try {
					unlinkSync(lockPath);
				} catch {
					// Someone else broke it first; either way, retry.
				}
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`Timed out waiting for the config lock at ${lockPath}. Another process is writing, or a lockfile was left behind.`,
				);
			}
			sleepSync(RETRY_DELAY_MS);
		}
	}
}

function releaseLock(lockPath: string, fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// Nothing useful to do; the unlink below is what matters.
	}
	try {
		unlinkSync(lockPath);
	} catch {
		// Already gone (broken as stale by another writer). Not an error:
		// failing here would turn a successful write into a reported failure.
	}
}

/**
 * Run one read-modify-write against a config file, exclusively.
 *
 * `mutate` receives the parsed contents (or undefined when the file does not
 * exist yet) and returns what to write. The read happens INSIDE the lock —
 * that is the whole point, and passing already-read contents in would
 * reintroduce the lost update this exists to prevent.
 */
export function updateConfigFile<T>(
	configPath: string,
	mutate: (current: T | undefined) => T,
	options: { mode?: number; indent?: string | number } = {},
): T {
	const lockPath = `${configPath}.lock`;
	const fd = acquireLock(lockPath);
	try {
		let current: T | undefined;
		try {
			current = JSON.parse(readFileSync(configPath, "utf8")) as T;
		} catch (error) {
			// A missing file is a first write. Anything else — malformed
			// JSON, a permissions problem — must NOT be silently replaced
			// with fresh content: that would delete every tenant on the box
			// because one byte was wrong.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const next = mutate(current);
		writeConfigAtomicUnlocked(configPath, next, options);
		return next;
	} finally {
		releaseLock(lockPath, fd);
	}
}

/**
 * Replace a config file's contents atomically, without taking the lock.
 *
 * For callers that genuinely have nothing to merge. Prefer
 * `updateConfigFile`: a caller that read the file itself and then writes it
 * back through here has the lost-update race the lock exists to close.
 */
export function writeConfigAtomicUnlocked(
	configPath: string,
	value: unknown,
	options: { mode?: number; indent?: string | number } = {},
): void {
	const mode = options.mode ?? 0o600;
	const indent = options.indent ?? 2;
	// Unique per writer. Under `updateConfigFile` the lock already makes this
	// exclusive, but this function is also exported for callers with nothing
	// to merge — and two of those sharing one `<path>.tmp` would have each
	// writing half a file into the other's, then renaming the mess over
	// config.json. The lock must not be the only thing standing between a
	// concurrent write and every tenant's credentials.
	tempCounter = (tempCounter + 1) % 1_000_000;
	const tempPath = `${configPath}.${process.pid}.${tempCounter}.tmp`;
	writeFileSync(tempPath, JSON.stringify(value, null, indent), { mode });
	// `mode` only applies when the file is CREATED, so a temp file left over
	// from an earlier run at 0644 would keep its permissions and carry them
	// through the rename onto a file full of credentials. The chmod is what
	// makes this correct rather than accidentally correct — the same reason
	// PON-148 pairs the two on every config write.
	chmodSync(tempPath, mode);
	renameSync(tempPath, configPath);
}
