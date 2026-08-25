import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAppJwt } from "./GitHubAppTokenProvider.js";
import { journalTokenMinted } from "./github-token-journal.js";

/**
 * GitHub App authentication for **git operations**, as opposed to REST calls.
 *
 * `GitHubAppTokenProvider` mints tokens for the GitHub API — reactions,
 * comments, PR replies. Nothing was ever wired into git itself, so `git clone`,
 * `git fetch` and `git push` ran with whatever ambient credential the host
 * happened to have. On a box with `gh auth login` configured that silently
 * works, using a person's account for every repository; on a clean box it stops
 * at `Username for 'https://github.com':` and waits forever.
 *
 * This module closes that gap with three properties that matter:
 *
 * 1. **Per operation.** A token is minted for the specific repository being
 *    acted on and lives for one git invocation.
 * 2. **Never persisted.** Not into `.git/config`, not into the saved remote
 *    URL, and not into argv — `-c http.extraheader=...` would put the token in
 *    `ps` output for every local user to read. It goes in the environment of a
 *    single child process and dies with it.
 * 3. **Never guessed.** If no installation covers the repository we refuse and
 *    name it. Minting against a default installation would hand one tenant's
 *    credential to another tenant's request, which is the defect PON-143
 *    exists to remove.
 */

export interface GitHubAppGitAuthConfig {
	appId: string;
	privateKeyPath: string;
	/** GitHub API base URL (default: https://api.github.com) */
	apiBaseUrl?: string;
}

export interface GitHubRepoRef {
	owner: string;
	repo: string;
}

/**
 * Extract owner/repo from a GitHub remote URL.
 *
 * Handles the forms `self-add-repo` actually receives: https with or without
 * `.git`, and scp-style `git@github.com:owner/repo.git`. Returns null for
 * anything that is not GitHub, so non-GitHub remotes fall through untouched
 * rather than being failed loudly for the wrong reason.
 */
export function parseGitHubRepoUrl(url: string): GitHubRepoRef | null {
	const trimmed = url.trim().replace(/\.git$/, "");

	const scp = trimmed.match(/^git@github\.com:([^/]+)\/(.+)$/);
	if (scp?.[1] && scp[2]) return { owner: scp[1], repo: scp[2] };

	const https = trimmed.match(
		/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/,
	);
	if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] };

	return null;
}

/**
 * What a token was being minted for. Named in the error so a failure says both
 * *which repository* could not be resolved and *what we were trying to do* —
 * "no installation for acme/widget" sends you to GitHub settings, while "…while
 * pushing" also tells you which session just stopped and why.
 */
export type GitHubOperation =
	| "clone"
	| "fetch"
	| "ls-remote"
	| "push"
	| "github-api";

/** Raised when the App is configured but no installation covers the repo. */
export class NoInstallationForRepositoryError extends Error {
	readonly owner: string;
	readonly repo: string;
	readonly operation: GitHubOperation | undefined;

	constructor(owner: string, repo: string, operation?: GitHubOperation) {
		const during = operation ? ` while attempting: ${operation}` : "";
		super(
			`No GitHub App installation covers ${owner}/${repo}${during}.\n` +
				`   Install the app into the ${owner} organization and grant it access\n` +
				`   to ${repo}, then retry. Refusing rather than minting a token for a\n` +
				`   different installation — that would use another tenant's credential.`,
		);
		this.name = "NoInstallationForRepositoryError";
		this.owner = owner;
		this.repo = repo;
		this.operation = operation;
	}
}

/**
 * Find the installation covering a repository.
 *
 * Asks GitHub rather than trusting configuration: `GET /repos/{owner}/{repo}/installation`
 * answers "which installation, if any, can see this repo". A 404 is the
 * authoritative "none", not an error to be retried.
 *
 * Resolving per repository at runtime is also what PON-143 needs — this is the
 * lookup that replaces a single process-wide `GITHUB_APP_INSTALLATION_ID`.
 */
export async function findInstallationForRepo(
	config: GitHubAppGitAuthConfig,
	ref: GitHubRepoRef,
): Promise<string | null> {
	const pem = await readFile(config.privateKeyPath, "utf-8");
	const jwt = createAppJwt(config.appId, pem);
	const apiBase = config.apiBaseUrl ?? "https://api.github.com";

	const response = await fetch(
		`${apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/installation`,
		{
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (response.status === 404) return null;

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Failed to look up the GitHub App installation for ${ref.owner}/${ref.repo}: ` +
				`${response.status} ${response.statusText} - ${body}`,
		);
	}

	const data = (await response.json()) as { id: number };
	return String(data.id);
}

/**
 * Mint an installation access token for a specific installation.
 *
 * Every repository-scoped mint in the process bottoms out here — the CLI's
 * `self-add-repo` clone and both GitService instances' session-time fetches
 * alike — so this is where the mint is journaled (PON-176). Putting the line
 * here rather than at each caller makes observability a property of minting
 * rather than a habit of callers: a future path that mints a token cannot forget
 * to announce it.
 *
 * `context` is required for the same reason it carries `ref`: an installation id
 * on its own does not answer *whose* credential this is, which is the only
 * question the journal line exists to settle.
 */
export async function mintInstallationToken(
	config: GitHubAppGitAuthConfig,
	installationId: string,
	context: { ref: GitHubRepoRef; operation?: GitHubOperation },
): Promise<string> {
	const pem = await readFile(config.privateKeyPath, "utf-8");
	const jwt = createAppJwt(config.appId, pem);
	const apiBase = config.apiBaseUrl ?? "https://api.github.com";

	const response = await fetch(
		`${apiBase}/app/installations/${installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Failed to create a GitHub App installation token: ${response.status} ${response.statusText} - ${body}`,
		);
	}

	const data = (await response.json()) as { token: string };
	journalTokenMinted(installationId, context);
	return data.token;
}

/**
 * Mint a token scoped to exactly this repository's installation.
 *
 * Throws `NoInstallationForRepositoryError` when nothing covers it. Callers
 * must not catch that and continue — the whole point is that we refuse rather
 * than reach for a credential belonging to someone else.
 */
export async function mintTokenForRepo(
	config: GitHubAppGitAuthConfig,
	ref: GitHubRepoRef,
	operation?: GitHubOperation,
): Promise<string> {
	const installationId = await findInstallationForRepo(config, ref);
	if (!installationId) {
		throw new NoInstallationForRepositoryError(ref.owner, ref.repo, operation);
	}
	return mintInstallationToken(config, installationId, { ref, operation });
}

/** Absolute path to the askpass helper, resolved next to this module. */
export function askpassPath(): string {
	return fileURLToPath(new URL("./git-askpass.mjs", import.meta.url));
}

/**
 * Environment for one authenticated git invocation.
 *
 * `GIT_TERMINAL_PROMPT=0` matters as much as the credential: without it, a git
 * that cannot authenticate blocks on a username prompt forever. On an
 * interactive terminal that looks like a hang; under systemd it is a wedged
 * process. Failing immediately is strictly better.
 */
export function gitAuthEnv(token: string): Record<string, string> {
	return {
		GIT_ASKPASS: askpassPath(),
		CYRUS_GIT_TOKEN: token,
		GIT_TERMINAL_PROMPT: "0",
	};
}

/**
 * `git -c` arguments that stop an ambient credential helper from answering
 * first.
 *
 * Git consults `credential.helper` before `GIT_ASKPASS`. A host with
 * `gh auth git-credential` configured would therefore keep using a personal
 * account even with App auth wired up — the exact situation that hid this bug:
 * the dev box worked because a human's credential was answering for every
 * repository. Clearing the helper list for the invocation makes the App the
 * only thing that can authenticate, so a misconfiguration surfaces instead of
 * being papered over.
 *
 * Safe in argv: this sets an empty value, it carries no secret.
 */
export const GIT_NO_AMBIENT_CREDENTIALS = ["-c", "credential.helper="] as const;
