import { z } from "zod";

/**
 * Supported runner/harness types for agent execution.
 */
export const RunnerTypeSchema = z.enum(["claude", "gemini", "codex", "cursor"]);
export type RunnerType = z.infer<typeof RunnerTypeSchema>;

/**
 * User identifier for access control matching.
 * Supports multiple formats for flexibility:
 * - String: treated as user ID (e.g., "usr_abc123")
 * - Object with id: explicit user ID match
 * - Object with email: email-based match
 */
export const UserIdentifierSchema = z.union([
	z.string(), // Treated as user ID
	z.object({ id: z.string() }), // Explicit user ID
	z.object({ email: z.string() }), // Email address
]);

/**
 * User access control configuration for whitelisting/blacklisting users.
 */
export const UserAccessControlConfigSchema = z.object({
	/**
	 * Users allowed to delegate issues.
	 * If specified, ONLY these users can trigger Cyrus sessions.
	 * Empty array means no one is allowed (effectively disables Cyrus).
	 * Omitting this field means everyone is allowed (unless blocked).
	 */
	allowedUsers: z.array(UserIdentifierSchema).optional(),

	/**
	 * Users blocked from delegating issues.
	 * These users cannot trigger Cyrus sessions.
	 * Takes precedence over allowedUsers.
	 */
	blockedUsers: z.array(UserIdentifierSchema).optional(),

	/**
	 * What happens when a blocked user tries to delegate.
	 * - 'silent': Ignore the webhook quietly (default)
	 * - 'comment': Post an activity explaining the user is not authorized
	 */
	blockBehavior: z.enum(["silent", "comment"]).optional(),

	/**
	 * Custom message to post when blockBehavior is 'comment'.
	 * Defaults to: "You are not authorized to delegate issues to this agent."
	 */
	blockMessage: z.string().optional(),
});

/**
 * Tool restriction options for label-based prompts
 */
const ToolRestrictionSchema = z.union([
	z.array(z.string()),
	z.literal("readOnly"),
	z.literal("safe"),
	z.literal("all"),
	z.literal("coordinator"),
]);

/**
 * Label prompt configuration with optional tool restrictions.
 * Accepts either:
 * - Simple form: string[] (e.g., ["Bug", "Fix"])
 * - Complex form: { labels: string[], allowedTools?: ..., disallowedTools?: ... }
 */
const LabelPromptConfigSchema = z.union([
	// Simple form: just an array of label strings
	z.array(z.string()),
	// Complex form: object with labels and optional tool restrictions
	z.object({
		labels: z.array(z.string()),
		allowedTools: ToolRestrictionSchema.optional(),
		disallowedTools: z.array(z.string()).optional(),
	}),
]);

/**
 * Graphite label configuration (labels only, no tool restrictions).
 * Accepts either:
 * - Simple form: string[] (e.g., ["Bug", "Fix"])
 * - Complex form: { labels: string[] }
 */
const GraphiteLabelConfigSchema = z.union([
	z.array(z.string()),
	z.object({
		labels: z.array(z.string()),
	}),
]);

/**
 * Label-based system prompt configuration
 */
const LabelPromptsSchema = z.object({
	debugger: LabelPromptConfigSchema.optional(),
	builder: LabelPromptConfigSchema.optional(),
	scoper: LabelPromptConfigSchema.optional(),
	orchestrator: LabelPromptConfigSchema.optional(),
	"graphite-orchestrator": LabelPromptConfigSchema.optional(),
	graphite: GraphiteLabelConfigSchema.optional(),
});

/**
 * Prompt type defaults configuration
 */
const PromptTypeDefaultsSchema = z.object({
	allowedTools: ToolRestrictionSchema.optional(),
	disallowedTools: z.array(z.string()).optional(),
});

/**
 * Header transform rule for egress proxy.
 * Injects or overrides HTTP headers on outgoing requests to a specific domain.
 * Follows the Vercel Sandbox Firewall transform interface.
 *
 * @see https://vercel.com/docs/vercel-sandbox/concepts/firewall
 */
const HeaderTransformSchema = z.object({
	/** Headers to inject/override on outgoing requests */
	headers: z.record(z.string(), z.string()),
});

/**
 * Per-domain allow rule with optional header transforms.
 * When transforms are specified, TLS is terminated for that domain
 * so headers can be inspected and modified (credentials brokering).
 */
const DomainRuleSchema = z.array(
	z.object({
		transform: z.array(HeaderTransformSchema).optional(),
	}),
);

/**
 * Network policy for egress sandboxing.
 * Controls which domains/subnets Bash-spawned subprocesses (git, gh, npm,
 * curl, etc.) can reach and enables per-domain header injection
 * (credentials brokering).
 *
 * Three modes (following Vercel Sandbox Firewall conventions):
 * - **allow-all**: No networkPolicy set — unrestricted access (default)
 * - **deny-all**: networkPolicy set with no `allow` rules — blocks all traffic
 * - **user-defined**: networkPolicy with `allow` rules — deny-all by default,
 *   only explicitly listed domains are reachable
 *
 * Scope: Claude Code's sandbox network proxy only intercepts traffic from
 * Bash tool subprocesses. It does NOT apply to Claude's own inference API
 * calls, MCP server traffic, or built-in file tools (Read/Edit/Write).
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/security#sandbox
 * @see https://vercel.com/docs/vercel-sandbox/concepts/firewall#network-policies
 */
export const NetworkPolicySchema = z.object({
	/**
	 * Network policy preset. When set, pre-populates the allow list with
	 * a curated set of domains. Additional `allow` rules are merged on top.
	 *
	 * - `"trusted"`: ~200 domains matching Claude Code on the web's default
	 *   allowlist — package registries, version control, cloud platforms,
	 *   container registries, dev tools, and monitoring services.
	 *
	 * @see https://docs.anthropic.com/en/docs/claude-code/claude-code-on-the-web#default-allowed-domains
	 */
	preset: z.enum(["trusted"]).optional(),

	/**
	 * Domain allow rules with optional transforms.
	 * When present, all unlisted domains are denied (deny-all default).
	 * Keys are domain patterns:
	 * - Exact match: "api.example.com"
	 * - Wildcard subdomain: "*.example.com" (matches any subdomain, NOT parent)
	 * - Wildcard segment: "www.*.com" (matches one segment)
	 *
	 * When a preset is also set, these rules are merged on top of the
	 * preset's domains (custom rules take precedence).
	 */
	allow: z.record(z.string(), DomainRuleSchema).optional(),

	/** Subnet-based rules */
	subnets: z
		.object({
			/** IP ranges to allow (bypasses domain matching) */
			allow: z.array(z.string()).optional(),
			/** IP ranges to deny (takes precedence over all allow rules) */
			deny: z.array(z.string()).optional(),
		})
		.optional(),
});

/**
 * Sandbox configuration for network egress control.
 * Configures the egress proxy that intercepts outbound traffic from
 * Bash-spawned subprocesses in agent sessions.
 *
 * When enabled, the proxy starts on EdgeWorker boot and sandbox
 * network ports are passed to the Claude Agent SDK per-session.
 * Only Bash tool commands (git, gh, npm, curl, etc.) route through
 * the proxy — Claude's inference API, MCP servers, and built-in
 * file tools are unaffected.
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/security#sandbox
 */
export const SandboxConfigSchema = z.object({
	/**
	 * Enable or disable the egress proxy.
	 * When true, the proxy starts on EdgeWorker boot and sandbox network ports
	 * are passed to Claude Agent SDK sessions to route traffic through it.
	 * @default false
	 */
	enabled: z.boolean().optional(),

	/** HTTP proxy port for SDK sandbox.network.httpProxyPort */
	httpProxyPort: z.number().optional().default(9080),

	/** SOCKS proxy port for SDK sandbox.network.socksProxyPort */
	socksProxyPort: z.number().optional().default(9081),

	/**
	 * Network policy controlling allowed domains, transforms, and subnets.
	 * If omitted, all traffic is allowed (passthrough mode with logging).
	 */
	networkPolicy: NetworkPolicySchema.optional(),

	/**
	 * Whether the CA certificate has been trusted system-wide (e.g., via
	 * `sudo security add-trusted-cert` on macOS). When true, per-session
	 * CA cert env vars (NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, etc.) are
	 * skipped — the OS cert store handles trust for all tools.
	 * @default false
	 */
	systemWideCert: z.boolean().optional(),

	/**
	 * Log all proxied requests (method, URL, domain, status).
	 * @default true
	 */
	logRequests: z.boolean().optional(),
});

/**
 * Global defaults for prompt types
 */
const PromptDefaultsSchema = z.object({
	debugger: PromptTypeDefaultsSchema.optional(),
	builder: PromptTypeDefaultsSchema.optional(),
	scoper: PromptTypeDefaultsSchema.optional(),
	orchestrator: PromptTypeDefaultsSchema.optional(),
	"graphite-orchestrator": PromptTypeDefaultsSchema.optional(),
});

/**
 * Configuration for a Linear workspace's credentials.
 * Keyed by workspace ID in EdgeConfig.linearWorkspaces.
 */
export const LinearWorkspaceConfigSchema = z.object({
	linearToken: z.string(),
	linearRefreshToken: z.string().optional(),
	/** Linear workspace URL slug (e.g., "ceedar" from "https://linear.app/ceedar/...") */
	linearWorkspaceSlug: z.string().optional(),
	/** Human-readable workspace name (e.g., "Ceedar") */
	linearWorkspaceName: z.string().optional(),
	/**
	 * Serialize work in this workspace to one active session at a time (a
	 * "lane"); additional sessions queue FIFO and start automatically as the
	 * lane frees up. Default off: sessions run concurrently as before.
	 */
	laneSerialization: z.boolean().optional(),
	/**
	 * Scope-confirm gate (PON-150): on delegation, the session posts its
	 * reading of the scope and asks for explicit structured confirmation
	 * (Approve scope / Revise scope / Cancel) before implementing anything.
	 * `approvedAt` on the persisted record is the SLA clock start.
	 *
	 * Default **on** — the gate exists for people who are paying us, so a
	 * newly connected workspace is gated before anyone thinks about it.
	 * Explicit `false` opts a workspace out (our own development workspace:
	 * gating our own issues on our own confirmation is ceremony).
	 */
	scopeConfirmGate: z.boolean().optional(),
	/**
	 * Verify-before-client-sees (PON-152): a completed session's client-facing
	 * summary is held until the operator approves; the PR stays draft until
	 * then. Default **on** — the client is never TOLD work exists before a
	 * human looked at it. Explicit `false` opts a workspace out.
	 */
	verifyBeforeDelivery: z.boolean().optional(),
	/**
	 * Client-quiet activity stream (PON-179/182): suppress working narration
	 * (thought/action activities) on this workspace's session threads —
	 * clients see the ack, one generic status per invocation, elicitations,
	 * and the final response. Independent of the gates: explicit value wins;
	 * ABSENT falls back to "quiet if either client-flow gate is on", which
	 * preserves pre-flag behaviour with zero config edits. Path hygiene is
	 * NOT controlled by this flag — internal paths are sanitized on every
	 * client-visible surface unconditionally.
	 */
	clientQuiet: z.boolean().optional(),
	/**
	 * How many sessions this workspace may run at once when serialized
	 * (PON-139). Default 1.
	 *
	 * Concurrency is the **cost regulator**; the Anthropic workspace spend cap
	 * is the backstop. A cap stops a runaway only after the money is gone and
	 * takes the lane down with it, whereas a concurrency limit shapes spend
	 * continuously and degrades into a queue — which is what the offer already
	 * sells: one active issue at a time, unlimited backlog, client orders the
	 * queue. If the cap is ever what stops us, something upstream already went
	 * wrong.
	 */
	laneConcurrency: z.number().int().min(1).optional(),
	/**
	 * Which Anthropic credential this workspace's sessions run on (PON-139).
	 *
	 * Three states, and the third is the point:
	 *
	 *   { mode: "apiKey", apiKey }  — a workspace-scoped Console key, so spend
	 *                                 is attributable and capped per tenant.
	 *   { mode: "subscription" }    — the box's CLAUDE_CODE_OAUTH_TOKEN.
	 *   absent                      — REFUSE, naming the workspace.
	 *
	 * `subscription` is a **declared mode, never a fallback**. A workspace runs
	 * on the subscription only because it was configured to. That is the whole
	 * distinction: a missing credential must never quietly resolve to "use
	 * whatever the box happens to have", because that is indistinguishable from
	 * a correct configuration right up until the bill arrives against the wrong
	 * tenant — or a personal rate limit takes down a paying client's session.
	 */
	anthropicAuth: z
		.discriminatedUnion("mode", [
			z.object({
				mode: z.literal("apiKey"),
				/** Workspace-scoped Console key. Never logged. */
				apiKey: z.string().min(1),
			}),
			z.object({ mode: z.literal("subscription") }),
		])
		.optional(),
	/**
	 * The app's own user id *within this workspace* (`viewer { id }` queried
	 * with this installation's token). Linear issues a distinct app-user id per
	 * install, so this is how the agent recognizes its own activity in a given
	 * tenant. Backfilled on boot for installs that predate this field.
	 */
	appUserId: z.string().optional(),
	/** ISO timestamp of when this workspace installed the app. */
	installedAt: z.string().optional(),
	/**
	 * Whether this tenant is currently served. Set to false when Linear
	 * reports the app's access has been revoked (PON-115); processing stops
	 * for the workspace and the flag persists across restarts. Cleared when
	 * the workspace re-authorizes. Absent means active.
	 */
	active: z.boolean().optional(),
	/** ISO timestamp of when access was observed to be revoked. */
	revokedAt: z.string().optional(),
});

/**
 * Configuration for a single repository/workspace pair
 */
export const RepositoryConfigSchema = z.object({
	// Repository identification
	id: z.string(),
	name: z.string(),

	// Git configuration
	repositoryPath: z.string(),
	baseBranch: z.string(),
	githubUrl: z.string().optional(),
	gitlabUrl: z.string().optional(),

	// Linear configuration (optional — repos may operate without Linear, e.g. via Slack or GitHub)
	linearWorkspaceId: z.string().optional(),
	teamKeys: z.array(z.string()).optional(),
	routingLabels: z.array(z.string()).optional(),
	projectKeys: z.array(z.string()).optional(),

	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearToken */
	linearToken: z.string().optional(),
	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearRefreshToken */
	linearRefreshToken: z.string().optional(),
	/** @deprecated Use EdgeConfig.linearWorkspaces[workspaceId].linearWorkspaceName */
	linearWorkspaceName: z.string().optional(),

	// Workspace configuration
	workspaceBaseDir: z.string(),

	// Optional settings
	isActive: z.boolean().optional(),
	promptTemplatePath: z.string().optional(),
	allowedTools: z.array(z.string()).optional(),
	disallowedTools: z.array(z.string()).optional(),
	mcpConfigPath: z.union([z.string(), z.array(z.string())]).optional(),
	appendInstruction: z.string().optional(),
	model: z.string().optional(),
	fallbackModel: z.string().optional(),

	// Label-based system prompt configuration
	labelPrompts: LabelPromptsSchema.optional(),

	// Repository-specific user access control
	userAccessControl: UserAccessControlConfigSchema.optional(),
});

/**
 * Edge configuration - the serializable configuration stored in ~/.cyrus/config.json
 *
 * This schema defines all settings that can be persisted to disk.
 * It contains global settings that apply across all repositories,
 * plus the array of repository-specific configurations.
 */
export const EdgeConfigSchema = z.object({
	/** Array of repository configurations */
	repositories: z.array(RepositoryConfigSchema),

	/**
	 * Linear workspace credentials keyed by workspace ID.
	 * Centralizes tokens that were previously duplicated per-repository.
	 */
	linearWorkspaces: z
		.record(z.string(), LinearWorkspaceConfigSchema)
		.optional(),

	/** @deprecated Migrated into linearWorkspaces entries. */
	linearWorkspaceSlug: z.string().optional(),

	/** Ngrok auth token for tunnel creation */
	ngrokAuthToken: z.string().optional(),

	/** Stripe customer ID for billing */
	stripeCustomerId: z.string().optional(),

	/** Default Claude model to use across all repositories (e.g., "opus", "sonnet", "haiku") */
	claudeDefaultModel: z.string().optional(),

	/** Default Claude fallback model if primary Claude model is unavailable */
	claudeDefaultFallbackModel: z.string().optional(),

	/** Default Gemini model to use across all repositories (e.g., "gemini-2.5-pro") */
	geminiDefaultModel: z.string().optional(),

	/** Default Codex model to use across all repositories (e.g., "gpt-5.5", "gpt-5.4", "gpt-5.3-codex") */
	codexDefaultModel: z.string().optional(),

	/** Default Cursor model to use across all repositories (e.g., "composer-2", "gpt-5.4") */
	cursorDefaultModel: z.string().optional(),

	/** Default Cursor fallback model if primary Cursor model is unavailable */
	cursorDefaultFallbackModel: z.string().optional(),

	/**
	 * Default runner/harness to use when no runner is specified via labels or description tags.
	 * If omitted, auto-detected from available API keys (if exactly one is configured),
	 * otherwise falls back to "claude".
	 */
	defaultRunner: RunnerTypeSchema.optional(),

	/**
	 * @deprecated Use claudeDefaultModel instead.
	 * Legacy field retained for backwards compatibility and migrated on load.
	 */
	defaultModel: z.string().optional(),

	/**
	 * @deprecated Use claudeDefaultFallbackModel instead.
	 * Legacy field retained for backwards compatibility and migrated on load.
	 */
	defaultFallbackModel: z.string().optional(),

	/** Optional path to global setup script that runs for all repositories */
	global_setup_script: z.string().optional(),

	/**
	 * Allowed tools for Linear-triggered agent sessions. Renamed from the
	 * old `defaultAllowedTools` to make the platform scope explicit alongside
	 * `slackAllowedTools` and `githubAllowedTools`.
	 */
	linearAllowedTools: z.array(z.string()).optional(),

	/**
	 * @deprecated Use linearAllowedTools instead. Legacy field retained for
	 * older self-host CLI consumers that still write the old name; migrated
	 * forward on load via `migrateEdgeConfig`.
	 */
	defaultAllowedTools: z.array(z.string()).optional(),

	/** Tools to explicitly disallow across all repositories */
	defaultDisallowedTools: z.array(z.string()).optional(),

	/**
	 * Allowed tools for Slack @mention chat sessions. When set, overrides the
	 * built-in read-only chat tool set used by ToolPermissionResolver. The
	 * workspace MCP tool prefixes (mcp__linear, mcp__cyrus-tools, etc.) are
	 * still appended automatically.
	 */
	slackAllowedTools: z.array(z.string()).optional(),

	/**
	 * Allowed tools for GitHub-triggered agent sessions. When set, overrides
	 * `linearAllowedTools` specifically for sessions originating from GitHub
	 * (PR comments, automated fix-on-failure flows, etc.).
	 */
	githubAllowedTools: z.array(z.string()).optional(),

	/**
	 * Filesystem paths to custom-integration MCP config JSON files (Claude
	 * Code `.mcp.json` format) the runtime should load for Slack `@mention`
	 * chat sessions. Chat sessions are repo-agnostic, so
	 * `repository.mcpConfigPath` is not consulted here — only this list
	 * determines which custom `.mcp.json` files load for Slack. When
	 * omitted/empty, no custom files load (native MCP servers — Linear,
	 * Cyrus tools, Slack MCP, Cyrus docs — still run as usual).
	 *
	 * The per-platform lists let cyrus-hosted route custom MCP server
	 * availability per surface — e.g. expose `slack-mcp-server` only on
	 * Slack, or scope a Supabase MCP to GitHub PR sessions but not Linear
	 * issue work. Each entry is passed as-is to Claude Code's
	 * `--mcp-config` mechanism.
	 */
	slackMcpConfigs: z.array(z.string()).optional(),

	/**
	 * Filesystem paths to custom-integration MCP config JSON files for
	 * Linear-triggered agent sessions. NOT a blanket override — this list
	 * is only consulted when the routed repo does NOT have its own
	 * `allowedTools` override. If the repo has its own allow-list set, the
	 * agent uses `repository.mcpConfigPath` instead so the repo's
	 * permission rules and its server set always come from the same scope.
	 * When omitted/empty AND the repo has no override, no custom `.mcp.json`
	 * files load.
	 */
	linearMcpConfigs: z.array(z.string()).optional(),

	/**
	 * Filesystem paths to custom-integration MCP config JSON files for
	 * GitHub/GitLab-triggered agent sessions. Same repo-override-coupling
	 * semantics as `linearMcpConfigs`: only consulted when the routed repo
	 * does not have its own `allowedTools` override; otherwise the repo's
	 * `mcpConfigPath` is used.
	 */
	githubMcpConfigs: z.array(z.string()).optional(),

	/**
	 * Whether to trigger agent sessions when issue title, description, or attachments are updated.
	 * When enabled, the agent receives context showing what changed (old vs new values).
	 * Defaults to true if not specified.
	 */
	issueUpdateTrigger: z.boolean().optional(),

	/**
	 * Whether Cyrus follows along with all subsequent replies in a Slack thread
	 * it has been @mentioned in (treating each reply as a follow-up prompt).
	 * When false, Cyrus only responds to explicit @mentions. Defaults to true if
	 * not specified. Can also be force-disabled at runtime via the
	 * `CYRUS_SLACK_THREAD_FOLLOWING_DISABLED` environment variable.
	 */
	slackThreadFollowing: z.boolean().optional(),

	/**
	 * Whether to trigger agent sessions when a pull request review requests changes.
	 * When disabled, a `pull_request_review` event produces no acknowledgement comment
	 * and no agent session. Defaults to true if not specified.
	 */
	prReviewTrigger: z.boolean().optional(),

	/**
	 * Global user access control settings.
	 * Applied to all repositories unless overridden.
	 */
	userAccessControl: UserAccessControlConfigSchema.optional(),

	/** Global defaults for prompt types (tool restrictions per prompt type) */
	promptDefaults: PromptDefaultsSchema.optional(),

	/**
	 * Sandbox configuration for network egress control.
	 * When enabled, starts an egress proxy and configures Claude Code to route
	 * all agent network traffic through it for inspection and filtering.
	 */
	sandbox: SandboxConfigSchema.optional(),

	/**
	 * Operator cockpit (PON-151): mirror every delegated issue from tenant
	 * workspaces into one Linear team/project the operator already looks at.
	 * The mirror is DERIVED, never a source of truth — nothing reads it back.
	 * Absent = mirroring off. Issues in the cockpit's own workspace are never
	 * mirrored.
	 */
	cockpit: z
		.object({
			/** Workspace the mirrors are written into (must be a configured linearWorkspaces entry — its token does the writing) */
			linearWorkspaceId: z.string(),
			/**
			 * The SAME workspace's human-readable name, declared again on
			 * purpose: the id and the name must agree with the configured
			 * linearWorkspaces entry before a single mirror is written. A
			 * copied-wrong workspace id (client ids sit right next to the
			 * operator's) then fails loudly instead of silently writing
			 * cross-tenant data into a client's Linear.
			 */
			workspaceName: z.string(),
			/** Team the mirror issues are created in */
			teamId: z.string(),
			/** Optional project to group the mirrors under */
			projectId: z.string().optional(),
			/**
			 * User the mirror is assigned to when work reaches
			 * in-verification (PON-152) — assignment is the notification.
			 * Legacy single-reviewer form (PON-173): reads as
			 * `reviewers: [assigneeId]` when `reviewers` is absent.
			 */
			assigneeId: z.string().optional(),
			/**
			 * Allowed-reviewer set (PON-173): any member may approve/reject
			 * delivery; the first entry is the default assignee. Takes
			 * precedence over `assigneeId` when both are set.
			 */
			reviewers: z.array(z.string()).optional(),
			/**
			 * Optional per-tenant-workspace reviewer assignment (PON-173):
			 * that tenant's mirrors and in-verification notifications go to
			 * their reviewer instead of the default.
			 */
			assignments: z.record(z.string(), z.string()).optional(),
		})
		.optional(),

	/**
	 * The commercial entities behind the tenants (PON-207).
	 *
	 * A client is what we bill, what buys lanes, and what the operator needs
	 * to see on a mirror. It is deliberately NOT a Linear concept: a client
	 * may hold more than one workspace, several teams inside one, and their
	 * Linear names can change under us without our view breaking. The issue
	 * key is not identity either — two clients can both use "ACM".
	 *
	 * Absent = the pre-PON-207 behaviour: every mirror in one bucket.
	 */
	clients: z
		.array(
			z.object({
				/** Stable key of ours. Never a Linear id — Linear ids change hands. */
				id: z.string(),
				/**
				 * What the operator reads on every mirror. Independent of any
				 * Linear workspace or team name, so a client renaming their
				 * workspace changes nothing here.
				 */
				displayName: z.string(),
				/** Linear workspace ids belonging to this client. Usually one. */
				workspaces: z.array(z.string()).min(1),
				/**
				 * Team keys within those workspaces. Absent or empty means
				 * every team — the common case. Present when one workspace is
				 * shared by more than one client, or when only some teams are
				 * ours to work.
				 */
				teams: z.array(z.string()).optional(),
				/**
				 * Lanes bought. Drives the client's share of the operator's
				 * attention: a two-lane client contributes two items per
				 * round-robin cycle, because that is what they are paying for.
				 * Default 1.
				 */
				lanes: z.number().int().positive().optional(),
				/** Reviewer who owns this client's lanes (PON-173 seam). */
				reviewerId: z.string().optional(),
				/**
				 * Cockpit project grouping this client's mirrors. Resolved or
				 * created on boot when absent, then cached here by the operator.
				 */
				cockpitProjectId: z.string().optional(),
			}),
		)
		.optional(),

	/**
	 * Escalation ladder thresholds for unapproved work (PON-152). The ladder
	 * only ever gets LOUDER — nothing here auto-delivers.
	 */
	verificationEscalation: z
		.object({
			/** Hours before a second, louder operator notification. Default 4. */
			remindAfterHours: z.number().positive().optional(),
			/** Hours before an honest delay note on the client's issue. Default 24. */
			delayNoteAfterHours: z.number().positive().optional(),
		})
		.optional(),
});

/**
 * Payload version of RepositoryConfigSchema for incoming API requests.
 * Makes workspaceBaseDir optional since the handler applies a default.
 */
export const RepositoryConfigPayloadSchema = RepositoryConfigSchema.extend({
	workspaceBaseDir: z.string().optional(),
});

/**
 * Payload version of EdgeConfigSchema for incoming API requests.
 * Uses RepositoryConfigPayloadSchema which has optional workspaceBaseDir.
 */
export const EdgeConfigPayloadSchema = EdgeConfigSchema.extend({
	repositories: z.array(RepositoryConfigPayloadSchema),
});

/**
 * Migrate an EdgeConfig from the legacy per-repo token format to the
 * workspace-keyed format.
 *
 * Old format: each repository has linearToken and linearRefreshToken.
 * New format: linearWorkspaces at EdgeConfig level keyed by workspace ID,
 * repositories no longer carry tokens.
 *
 * This function is idempotent — if linearWorkspaces already exists, it
 * returns the config unchanged.
 */
export function migrateEdgeConfig(
	input: Record<string, unknown>,
): Record<string, unknown> {
	// `defaultAllowedTools` → `linearAllowedTools`. Older self-host CLIs and
	// any config file written before the rename still ship the old key; fold
	// it forward in-place. We do NOT delete the old key — newer consumers
	// ignore it, and an older runtime that still reads the old key keeps
	// working until it's upgraded.
	const raw: Record<string, unknown> =
		Array.isArray(input.defaultAllowedTools) &&
		input.linearAllowedTools === undefined
			? { ...input, linearAllowedTools: input.defaultAllowedTools }
			: input;

	// Already migrated or no repositories — nothing else to do
	if (raw.linearWorkspaces || !Array.isArray(raw.repositories)) {
		return raw;
	}

	const repos = raw.repositories as Record<string, unknown>[];
	const hasLegacyTokens = repos.some((r) => typeof r.linearToken === "string");

	if (!hasLegacyTokens) {
		return raw;
	}

	// Build workspace map from per-repo tokens
	const linearWorkspaces: Record<
		string,
		{
			linearToken: string;
			linearRefreshToken?: string;
			linearWorkspaceSlug?: string;
			linearWorkspaceName?: string;
		}
	> = {};

	// Grab the top-level slug (if present) so it can be folded into each workspace
	const globalSlug = raw.linearWorkspaceSlug as string | undefined;

	for (const repo of repos) {
		const workspaceId = repo.linearWorkspaceId as string | undefined;
		const token = repo.linearToken as string | undefined;
		if (workspaceId && token) {
			// First repo with this workspace wins (they should all have the same token)
			if (!linearWorkspaces[workspaceId]) {
				linearWorkspaces[workspaceId] = {
					linearToken: token,
					...(typeof repo.linearRefreshToken === "string"
						? { linearRefreshToken: repo.linearRefreshToken }
						: {}),
					...(globalSlug ? { linearWorkspaceSlug: globalSlug } : {}),
					...(typeof repo.linearWorkspaceName === "string"
						? { linearWorkspaceName: repo.linearWorkspaceName }
						: {}),
				};
			}
		}
	}

	// Strip legacy token fields and workspace name from repositories
	const migratedRepos = repos.map((repo) => {
		const {
			linearToken: _linearToken,
			linearRefreshToken: _linearRefreshToken,
			linearWorkspaceName: _linearWorkspaceName,
			...rest
		} = repo;
		return rest;
	});

	const { linearWorkspaceSlug: _slug, ...rest } = raw;

	return {
		...rest,
		repositories: migratedRepos,
		linearWorkspaces,
	};
}

// Infer types from schemas
export type UserIdentifier = z.infer<typeof UserIdentifierSchema>;
export type UserAccessControlConfig = z.infer<
	typeof UserAccessControlConfigSchema
>;
export type LinearWorkspaceConfig = z.infer<typeof LinearWorkspaceConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;
export type RepositoryConfigPayload = z.infer<
	typeof RepositoryConfigPayloadSchema
>;
export type EdgeConfigPayload = z.infer<typeof EdgeConfigPayloadSchema>;

/**
 * Assert that a repository has a Linear workspace ID and return it.
 * Use this in code paths that are only reached for Linear-linked repositories
 * (e.g. webhook handlers routed via workspace ID).
 */
export function requireLinearWorkspaceId(repo: RepositoryConfig): string {
	if (!repo.linearWorkspaceId) {
		throw new Error(
			`Repository "${repo.name}" is not linked to a Linear workspace`,
		);
	}
	return repo.linearWorkspaceId;
}
