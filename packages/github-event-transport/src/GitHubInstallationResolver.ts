import {
	findInstallationForRepo,
	type GitHubAppGitAuthConfig,
	type GitHubOperation,
	type GitHubRepoRef,
	mintInstallationToken,
	NoInstallationForRepositoryError,
	parseGitHubRepoUrl,
} from "./GitHubAppGitAuth.js";

/**
 * Resolves and caches "which installation covers this repository" (PON-143).
 *
 * Replaces a single process-wide `GITHUB_APP_INSTALLATION_ID`. That variable
 * could only ever name one installation, so on a box serving two client orgs the
 * provider did not fail for the second — it *succeeded*, minting a valid token
 * for the first client's installation. Nothing errored, because nothing was
 * wrong with the token; it was simply scoped to the wrong tenant.
 *
 * The rule this implements: **the installation is resolved from the repository
 * the operation targets.** Never from routing state, never from configuration.
 * Routing decides where work happens; GitHub decides which credential covers a
 * repository. Those are different facts and must not be able to disagree — which
 * is also why the installation id is asked for at runtime rather than stored. A
 * configured id is a second source of truth that drifts the moment a client
 * moves, uninstalls, or re-installs the app.
 */

/** How long a resolved installation id is trusted before re-asking GitHub. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
	installationId: string;
	resolvedAt: number;
}

export interface GitHubInstallationResolverOptions {
	/** Cache lifetime for a resolved installation id. Default 10 minutes. */
	ttlMs?: number;
}

export class GitHubInstallationResolver {
	private readonly config: GitHubAppGitAuthConfig;
	private readonly ttlMs: number;
	private readonly cache = new Map<string, CacheEntry>();

	constructor(
		config: GitHubAppGitAuthConfig,
		options: GitHubInstallationResolverOptions = {},
	) {
		this.config = config;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	}

	private static key(ref: GitHubRepoRef): string {
		// GitHub owners and repos are case-insensitive; normalise so two spellings
		// of the same repository do not occupy two cache entries and, worse, are
		// not treated as two different tenants.
		return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
	}

	/**
	 * The installation covering this repository, or throw.
	 *
	 * Cached with a bounded TTL rather than forever: a client who uninstalls the
	 * app must stop working within the TTL, without a restart. A cache that never
	 * expires would keep minting tokens against an installation the client
	 * believes they have revoked — which is exactly the control the GitHub App
	 * model promises them.
	 */
	async resolveInstallationId(
		ref: GitHubRepoRef,
		operation?: GitHubOperation,
	): Promise<string> {
		const key = GitHubInstallationResolver.key(ref);
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.resolvedAt < this.ttlMs) {
			return hit.installationId;
		}

		const installationId = await findInstallationForRepo(this.config, ref);
		if (!installationId) {
			// Drop any stale entry: the app has been uninstalled or lost access,
			// and continuing to serve a cached id would be the wrong-tenant bug
			// in slow motion.
			this.cache.delete(key);
			throw new NoInstallationForRepositoryError(
				ref.owner,
				ref.repo,
				operation,
			);
		}

		this.cache.set(key, { installationId, resolvedAt: Date.now() });
		return installationId;
	}

	/**
	 * Resolve from a repository URL, e.g. a worktree's `origin` remote.
	 *
	 * Returns null for a non-GitHub remote so callers can leave it alone rather
	 * than failing it for a GitHub misconfiguration it cannot have.
	 */
	async resolveFromUrl(
		url: string,
		operation?: GitHubOperation,
	): Promise<string | null> {
		const ref = parseGitHubRepoUrl(url);
		if (!ref) return null;
		return this.resolveInstallationId(ref, operation);
	}

	/**
	 * Mint an installation token scoped to this repository's own installation.
	 *
	 * Throws `NoInstallationForRepositoryError` when nothing covers it. Callers
	 * must not catch that and reach for another credential — refusing is the
	 * behaviour being bought here.
	 */
	async mintTokenForRef(
		ref: GitHubRepoRef,
		operation?: GitHubOperation,
	): Promise<string> {
		const installationId = await this.resolveInstallationId(ref, operation);
		return mintInstallationToken(this.config, installationId);
	}

	/**
	 * Forget a cached resolution — call after a 401/403 from GitHub, where the
	 * most likely explanation is that the installation changed under us.
	 */
	invalidate(ref: GitHubRepoRef): void {
		this.cache.delete(GitHubInstallationResolver.key(ref));
	}

	/** Cached entry count. For tests and diagnostics; never logs a token. */
	get size(): number {
		return this.cache.size;
	}
}
