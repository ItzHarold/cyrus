/**
 * Per-workspace Anthropic credential resolution (PON-139).
 *
 * A workspace declares which credential its sessions run on. Resolution never
 * guesses: a workspace that has not declared one is refused, by name, rather
 * than served with whatever the box happens to hold.
 *
 * That refusal is the entire feature. A silent fallback to the process-wide
 * credential is indistinguishable from a correct configuration until the moment
 * it matters — the bill lands against the wrong tenant, or a personal rate limit
 * takes down a paying client's session. Both are discovered late and neither is
 * visible in a log.
 */

/** How a workspace's sessions authenticate to Anthropic. */
export type WorkspaceAnthropicAuth =
	| { mode: "apiKey"; apiKey: string }
	| { mode: "subscription" };

/** The three environment variables the SDK will accept a credential from. */
export const ANTHROPIC_AUTH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * Raised when a workspace has not declared how it authenticates.
 *
 * Deliberately not catchable-and-continue: the caller must refuse the session.
 */
export class WorkspaceAuthNotDeclaredError extends Error {
	readonly workspaceId: string;
	readonly workspaceName: string | undefined;

	constructor(workspaceId: string, workspaceName?: string) {
		const label = workspaceName
			? `${workspaceName} (${workspaceId})`
			: workspaceId;
		super(
			`Workspace ${label} has not declared how it authenticates to Anthropic.\n` +
				`   Set anthropicAuth on this workspace to either\n` +
				`     { "mode": "apiKey", "apiKey": "<workspace-scoped Console key>" }\n` +
				`   or, to run it on this box's subscription deliberately,\n` +
				`     { "mode": "subscription" }\n` +
				`   Refusing rather than using the process-wide credential — an\n` +
				`   undeclared workspace must not silently spend against another\n` +
				`   tenant's budget or a personal rate limit.`,
		);
		this.name = "WorkspaceAuthNotDeclaredError";
		this.workspaceId = workspaceId;
		this.workspaceName = workspaceName;
	}
}

/** Raised when a declaration exists but the box cannot satisfy it. */
export class WorkspaceAuthUnavailableError extends Error {
	readonly workspaceId: string;

	constructor(workspaceId: string, reason: string) {
		super(
			`Workspace ${workspaceId} declares an Anthropic credential this box cannot supply: ${reason}`,
		);
		this.name = "WorkspaceAuthUnavailableError";
		this.workspaceId = workspaceId;
	}
}

/**
 * Resolve a workspace's declaration into the environment its sessions run with.
 *
 * Returns a **complete** auth environment: the declared credential set, and
 * every other auth variable explicitly unset.
 *
 * The unsetting is not tidiness. The parent process carries whatever the box was
 * started with — on a box holding a subscription token, that token is present in
 * every child's environment by default. Adding an API key on top would produce a
 * child holding both, and which one the SDK prefers would decide what a
 * workspace declaring `apiKey` actually runs on. Replacing the whole set means
 * no precedence rule is load-bearing, and a future change to that precedence
 * cannot silently move a tenant onto the wrong credential.
 *
 * `undefined` values are how the caller unsets a variable that would otherwise
 * be inherited — the same mechanism already used for `DEBUG_CLAUDE_AGENT_SDK`.
 */
export function resolveWorkspaceAuthEnv(
	auth: WorkspaceAnthropicAuth | undefined,
	workspaceId: string,
	options: {
		workspaceName?: string;
		/** The box's subscription token, for `mode: "subscription"`. */
		subscriptionToken?: string;
	} = {},
): Record<string, string | undefined> {
	if (!auth) {
		throw new WorkspaceAuthNotDeclaredError(workspaceId, options.workspaceName);
	}

	// Start from "every auth variable unset", then set exactly one.
	const env: Record<string, string | undefined> = {};
	for (const key of ANTHROPIC_AUTH_ENV_KEYS) {
		env[key] = undefined;
	}

	if (auth.mode === "apiKey") {
		env.ANTHROPIC_API_KEY = auth.apiKey;
		return env;
	}

	// mode === "subscription"
	if (!options.subscriptionToken) {
		throw new WorkspaceAuthUnavailableError(
			workspaceId,
			"declares mode 'subscription' but this box has no CLAUDE_CODE_OAUTH_TOKEN",
		);
	}
	env.CLAUDE_CODE_OAUTH_TOKEN = options.subscriptionToken;
	return env;
}

/**
 * Describe a workspace's auth for a log line, without disclosing the credential.
 *
 * Used where a session records what it is running on. A key is identified by its
 * mode and length only — enough to tell two workspaces apart in a journal, never
 * enough to reconstruct.
 */
export function describeWorkspaceAuth(
	auth: WorkspaceAnthropicAuth | undefined,
): string {
	if (!auth) return "undeclared";
	if (auth.mode === "subscription") return "subscription";
	return `apiKey(len=${auth.apiKey.length})`;
}
