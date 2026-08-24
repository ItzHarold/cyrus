import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EdgeConfigSchema } from "cyrus-core";
import { describe, expect, it } from "vitest";

/**
 * WorkerService builds the EdgeWorkerConfig by ENUMERATING fields off the
 * parsed config file — the startup twin of ConfigManager's hot-reload merge
 * whitelist. A field left out is silently dropped at boot even though a later
 * hot-reload would carry it, which is how PON-151's `cockpit` block shipped
 * configured-but-dead: the service booted, read the config, and mirrored
 * nothing, with no error anywhere.
 *
 * This test makes that class of omission fail loudly: every top-level
 * EdgeConfigSchema key must be referenced in the WorkerService mapping, or be
 * on the documented exception list below.
 */

/**
 * Keys mapped through a local variable rather than an `edgeConfig.<key>`
 * read (destructured params, env-derived values).
 */
const MAPPED_VIA_VARIABLE = new Set(["repositories", "ngrokAuthToken"]);

/**
 * Keys deliberately not mapped at startup. Each entry is a claim — remove
 * the entry when the key gets mapped.
 */
const KNOWN_UNMAPPED: Record<string, string> = {
	// Metadata written by auth/billing flows; EdgeWorker does not consume
	// them from its runtime config.
	linearWorkspaceSlug: "workspace metadata, read from config file directly",
	stripeCustomerId: "billing metadata, not runtime config",
	// PRE-EXISTING startup drops (they hot-reload via ConfigManager but are
	// lost at boot). Tracked as a follow-up — remove from this list when
	// fixed, and do NOT add new keys with this justification.
	cursorDefaultModel: "pre-existing startup drop — follow-up filed",
	cursorDefaultFallbackModel: "pre-existing startup drop — follow-up filed",
	defaultAllowedTools: "pre-existing startup drop — follow-up filed",
	slackThreadFollowing: "pre-existing startup drop — follow-up filed",
};

describe("WorkerService config mapping (startup twin of the hot-reload whitelist)", () => {
	it("maps every EdgeConfigSchema key into the EdgeWorkerConfig, or documents why not", () => {
		const source = readFileSync(join(__dirname, "WorkerService.ts"), "utf8");
		const missing: string[] = [];
		for (const key of Object.keys(EdgeConfigSchema.shape)) {
			if (key in KNOWN_UNMAPPED) continue;
			// A mapped key reads `edgeConfig.<key>` — the exact expression,
			// so a stray mention in a comment can never satisfy the check —
			// unless it is on the mapped-via-variable list.
			const referenced =
				source.includes(`edgeConfig.${key}`) || MAPPED_VIA_VARIABLE.has(key);
			if (!referenced) missing.push(key);
		}
		expect(
			missing,
			`EdgeConfigSchema key(s) not mapped in WorkerService — the config value will be silently dropped at startup: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("the createWorkspace handler forwards the git credential resolver (PON-162)", () => {
		// The handler's GitService is the CLI's instance with no
		// constructor-wired resolver; production worktree auth exists ONLY
		// through this forward. Found live on agent-prod: the line was
		// missing and every session-time fetch ran credential-less.
		const source = readFileSync(join(__dirname, "WorkerService.ts"), "utf8");
		expect(source).toContain("resolveGitAuth: options?.resolveGitAuth");
	});

	it("keys on the exception list are genuinely absent (stale entries get cleaned up)", () => {
		const source = readFileSync(join(__dirname, "WorkerService.ts"), "utf8");
		const stale = Object.keys(KNOWN_UNMAPPED).filter((key) =>
			source.includes(`edgeConfig.${key}`),
		);
		expect(
			stale,
			`Exception-list key(s) are now mapped — remove them from KNOWN_UNMAPPED: ${stale.join(", ")}`,
		).toEqual([]);
	});
});
