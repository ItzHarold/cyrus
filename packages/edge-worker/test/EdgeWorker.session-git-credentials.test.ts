import { describe, expect, it, vi } from "vitest";
import {
	buildClientSurfaceRuleBlock,
	findClientContentViolations,
} from "../src/client-content-policy.js";
import { CLIENT_MESSAGES } from "../src/client-messages.js";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-202: the session — the thing that pushes the branch and opens the pull
 * request, which is the whole deliverable — was handed no git credential, no
 * gh credential and no HOME.
 *
 * The machinery authenticated its own clones from the start, so this stayed
 * invisible: sessions coped by writing their own token minters and embedding
 * credentials in remote URLs, and that worked on exactly one account — the one
 * whose installation id was in the box-wide env. The first client repository
 * under a different installation got "Repository not found", and the client
 * was told the GitHub integration was not connected.
 */

const WORKTREE = "/root/.cyrus-community/worktrees/ws/ACM-13";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

describe("EdgeWorker - session git credentials (PON-202)", () => {
	it("gives the session a push credential, a gh credential and a HOME", async () => {
		const worker = createTestWorker([]);
		const p = privates(worker);
		p.resolveGitAuthForRepoPath = vi.fn().mockResolvedValue({
			env: {
				GIT_ASKPASS: "/opt/askpass.mjs",
				CYRUS_GIT_TOKEN: "ghs_installation_token",
				GIT_TERMINAL_PROMPT: "0",
			},
			args: ["-c", "credential.helper="],
		});

		const env = await p.buildSessionGitEnv(WORKTREE);

		// git push
		expect(env.GIT_ASKPASS).toBe("/opt/askpass.mjs");
		expect(env.CYRUS_GIT_TOKEN).toBe("ghs_installation_token");
		// Never block on a username prompt under systemd.
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		// gh pr create
		expect(env.GH_TOKEN).toBe("ghs_installation_token");
		// "fatal: $HOME not set" — what the first client push actually hit.
		expect(env.HOME).toBeTruthy();
	});

	it("resolves the credential for a PUSH, from the worktree's own remote", async () => {
		const worker = createTestWorker([]);
		const p = privates(worker);
		const resolve = vi.fn().mockResolvedValue({
			env: { CYRUS_GIT_TOKEN: "t" },
			args: [],
		});
		p.resolveGitAuthForRepoPath = resolve;

		await p.buildSessionGitEnv(WORKTREE);

		// Per-repository, not the box-wide installation id that made the one
		// prod push work by coincidence.
		expect(resolve).toHaveBeenCalledWith(WORKTREE, "push");
	});

	it("injects nothing when the remote is not GitHub — behaviour unchanged", async () => {
		const worker = createTestWorker([]);
		const p = privates(worker);
		p.resolveGitAuthForRepoPath = vi.fn().mockResolvedValue(null);

		expect(await p.buildSessionGitEnv(WORKTREE)).toEqual({});
	});

	it("never fails session start when a token cannot be minted", async () => {
		const worker = createTestWorker([]);
		const p = privates(worker);
		p.resolveGitAuthForRepoPath = vi
			.fn()
			.mockRejectedValue(new Error("no installation for repository"));

		await expect(p.buildSessionGitEnv(WORKTREE)).resolves.toEqual({});
	});
});

describe("client copy: never hand our outage to the client (PON-202)", () => {
	it("the intrinsic rules forbid branches, diffs and client-run commands", () => {
		const block = buildClientSurfaceRuleBlock();
		expect(block).toContain("Never ask the client to do our work");
		expect(block).toMatch(/never offer to hand over a branch/i);
		expect(block).toMatch(/never paste a diff or a patch/i);
		expect(block).toMatch(/delivery is delayed while we fix it/i);
	});

	it("the blocked-delivery message says only that, and passes the policy", () => {
		const message = CLIENT_MESSAGES.deliveryBlocked();
		expect(message).toMatch(/delayed/i);
		expect(message).toMatch(/Nothing is needed from you/i);
		// No diagnosis, no workaround, no ask.
		expect(message).not.toMatch(
			/branch|diff|patch|token|credential|GitHub App/i,
		);
		expect(findClientContentViolations(message)).toEqual([]);
	});
});
