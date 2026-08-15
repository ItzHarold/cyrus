import { join } from "node:path";

/**
 * Shared constants used across Cyrus packages
 */

/**
 * Default proxy URL for Cyrus hosted services
 */
export const DEFAULT_PROXY_URL = "https://cyrus-proxy.ceedar.workers.dev";

/**
 * Default directory name for git worktrees
 */
export const DEFAULT_WORKTREES_DIR = "worktrees";

/**
 * Default directory name for cloned repositories
 */
export const DEFAULT_REPOS_DIR = "repos";

/**
 * Resolves the repos directory, preferring CYRUS_REPOS_DIR env var over the default.
 */
export function getDefaultReposDir(cyrusHome: string): string {
	return (
		process.env.CYRUS_REPOS_DIR?.trim() || join(cyrusHome, DEFAULT_REPOS_DIR)
	);
}

/**
 * Directory holding an issue's downloaded attachments (PON-115).
 *
 * Namespaced by Linear workspace, because issue identifiers are unique only
 * within a workspace: two tenants can each have `ENG-1`, and an un-namespaced
 * directory would let one tenant's attachments be served into the other's
 * session. Repositories with no Linear workspace keep the flat layout.
 *
 * Single source of truth — several call sites need this path and must agree,
 * or a session's readable directory diverges from where files were written.
 */
export function getAttachmentsDir(
	cyrusHome: string,
	workspaceFolderName: string,
	linearWorkspaceId?: string,
): string {
	return linearWorkspaceId
		? join(cyrusHome, linearWorkspaceId, workspaceFolderName, "attachments")
		: join(cyrusHome, workspaceFolderName, "attachments");
}

/**
 * Resolves the worktrees directory, preferring CYRUS_WORKTREES_DIR env var over the default.
 */
export function getDefaultWorktreesDir(cyrusHome: string): string {
	return (
		process.env.CYRUS_WORKTREES_DIR?.trim() ||
		join(cyrusHome, DEFAULT_WORKTREES_DIR)
	);
}

/**
 * Default base branch for new repositories
 */
export const DEFAULT_BASE_BRANCH = "main";

/**
 * Default config filename
 */
export const DEFAULT_CONFIG_FILENAME = "config.json";
