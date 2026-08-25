import { createLogger, type ILogger } from "cyrus-core";
import type { GitHubOperation, GitHubRepoRef } from "./GitHubAppGitAuth.js";

/**
 * One place where the credential path says out loud which credential served a
 * request (PON-176).
 *
 * Per-repository App minting (PON-143/162) worked from the day it landed, and it
 * was completely silent. Every acceptance proof since has had to *infer* the
 * credential path backwards from a downstream success — "the private-repo fetch
 * worked, so a token must have been minted against the right installation". That
 * inference is precisely what the evidence discipline exists to remove, and it is
 * unsound in the one direction that matters: a fetch also succeeds when an
 * ambient personal credential answers first, which is the PON-143 defect wearing
 * a green checkmark.
 *
 * So each credential decision names itself, distinctly, so that telling
 * App-minted from PAT-fallback is a grep rather than a reading exercise:
 *
 * - `github_token_minted` — an App installation token was minted, naming the
 *   repository it was scoped to and the installation it came from.
 * - `github_token_ambient_fallback` — no App token was available; the
 *   process-wide, tenant-less credential (or none at all) served the operation.
 *
 * **The token value is never an attribute.** Ids, repository refs and the purpose
 * only. A journal is long-lived, widely readable, and forwarded to the structured
 * log stream — a credential that lands in one has effectively been published.
 */

/** Default sink, used when a caller has no context-carrying logger of its own. */
const credentialLogger: ILogger = createLogger({
	component: "GitHubCredentials",
});

/**
 * What a credential decision was for.
 *
 * Both fields are optional here because a few callers genuinely have neither —
 * the process-wide provider knows an installation id and nothing else. Where a
 * repository *is* knowable the caller is made to supply it: `mintInstallationToken`
 * narrows `ref` to required in its own signature, because an installation id
 * alone does not answer "whose credential is this", which is the whole question
 * these lines exist to settle.
 */
export interface TokenJournalContext {
	ref?: GitHubRepoRef;
	operation?: GitHubOperation;
}

/**
 * A GitHub App installation token was successfully minted.
 *
 * Emitted at `event` level so it reaches the journal and the structured stream
 * even when an operator is running at WARN locally — the credential path is not
 * something you want to have to turn on after the fact.
 */
export function journalTokenMinted(
	installationId: string,
	context: TokenJournalContext = {},
	logger: ILogger = credentialLogger,
): void {
	logger.event("github_token_minted", {
		owner: context.ref?.owner,
		repo: context.ref?.repo,
		installationId,
		purpose: context.operation ?? "unspecified",
	});
}

/**
 * A still-valid token was served from cache rather than minted.
 *
 * Debug level on purpose: a cache hit is the absence of a credential decision,
 * and at info level it would bury the mints it is derived from. It carries its
 * own name so that turning `CYRUS_LOG_LEVEL=debug` on still tells the two apart.
 */
export function journalTokenCacheHit(
	installationId: string,
	context: TokenJournalContext = {},
	logger: ILogger = credentialLogger,
): void {
	const attributes = {
		owner: context.ref?.owner,
		repo: context.ref?.repo,
		installationId,
		purpose: context.operation ?? "unspecified",
	};
	logger.debug(`[event:github_token_cache_hit] ${JSON.stringify(attributes)}`);
}

/**
 * An operation ran without an App installation token.
 *
 * `reason` says which branch was taken — an unverified webhook payload, no App
 * configured, no installation covering the repository. Whether an ambient
 * `GITHUB_TOKEN` then answered or the operation simply ran credential-less, the
 * fact worth journaling is the same: this request was **not** served by a
 * tenant-scoped credential.
 */
export function journalAmbientTokenFallback(
	reason: string,
	context: TokenJournalContext = {},
	logger: ILogger = credentialLogger,
): void {
	logger.event("github_token_ambient_fallback", {
		owner: context.ref?.owner,
		repo: context.ref?.repo,
		reason,
		purpose: context.operation ?? "unspecified",
	});
}
