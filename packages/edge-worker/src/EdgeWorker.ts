import { AsyncLocalStorage } from "node:async_hooks";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { LinearClient } from "@linear/sdk";
import type {
	McpServerConfig,
	SDKMessage,
	SessionStore,
	WarmQuery,
} from "cyrus-claude-runner";
import {
	buildBaseSessionEnv,
	ClaudeRunner,
	HttpSessionStore,
	normalizeMcpHttpTransport,
} from "cyrus-claude-runner";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import { CodexRunner } from "cyrus-codex-runner";
import { ConfigUpdater } from "cyrus-config-updater";
import type {
	AgentActivityCreateInput,
	AgentEvent,
	AgentRunnerConfig,
	AgentSessionCreatedWebhook,
	AgentSessionPromptedWebhook,
	BaseBranchResolution,
	ContentUpdateMessage,
	CyrusAgentSession,
	EdgeWorkerConfig,
	GuidanceRule,
	IAgentRunner,
	IIssueTrackerService,
	ILogger,
	InternalMessage,
	Issue,
	IssueMinimal,
	IssueStateChangeMessage,
	IssueUnassignedWebhook,
	IssueUpdateWebhook,
	PermissionChangeWebhook,
	RepositoryConfig,
	RunnerType,
	SerializableEdgeWorkerState,
	SessionStartMessage,
	StopSignalMessage,
	UnassignMessage,
	UserPromptMessage,
	Webhook,
	WebhookAgentSession,
	WebhookIssue,
} from "cyrus-core";
import {
	AgentActivitySignal,
	AgentSessionStatus,
	CLIIssueTrackerService,
	CLIRPCServer,
	createLogger,
	DEFAULT_PROXY_URL,
	describeWorkspaceAuth,
	getAttachmentsDir,
	getPinnedModel,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
	isContentUpdateMessage,
	isIssueAssignedWebhook,
	isIssueCommentMentionWebhook,
	isIssueDeletedWebhook,
	isIssueNewCommentWebhook,
	isIssueStateChangeMessage,
	isIssueStateChangeWebhook,
	isIssueStateIdUpdateWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
	isIssueUnassignedWebhook,
	isPermissionChangeWebhook,
	isSessionStartMessage,
	isStopSignalMessage,
	isUnassignMessage,
	isUserPromptMessage,
	PersistenceManager,
	requireLinearWorkspaceId,
	resolvePath,
	resolveWorkspaceAuthEnv,
	WebhookIpValidator,
} from "cyrus-core";
import { CursorRunner } from "cyrus-cursor-runner";
import { GeminiRunner } from "cyrus-gemini-runner";
import {
	appBotIdentity,
	extractCommentAuthor,
	extractCommentBody,
	extractCommentId,
	extractCommentUrl,
	extractPRBaseBranchRef,
	extractPRBranchRef,
	extractPRNumber,
	extractPRTitle,
	extractRepoFullName,
	extractRepoName,
	extractRepoOwner,
	extractSessionKey,
	GIT_NO_AMBIENT_CREDENTIALS,
	GitHubCommentService,
	type GitHubCommentWebhookEvent,
	GitHubEventTransport,
	GitHubInstallationResolver,
	type GitHubPushPayload,
	type GitHubWebhookEvent,
	gitAuthEnv,
	isCommentOnPullRequest,
	isIssueCommentPayload,
	isPullRequestReviewCommentPayload,
	isPullRequestReviewPayload,
	journalAmbientTokenFallback,
	parseGitHubRepoUrl,
	remoteUrlHasEmbeddedCredential,
	stripEmbeddedCredential,
	stripMention,
} from "cyrus-github-event-transport";
import type { GitLabWebhookEvent } from "cyrus-gitlab-event-transport";
import {
	extractDiscussionId,
	extractSessionKey as extractGitLabSessionKey,
	extractMRBaseBranchRef,
	extractMRBranchRef,
	extractMRIid,
	extractMRTitle,
	extractNoteAuthor,
	extractNoteBody,
	extractNoteId,
	extractNoteUrl,
	extractProjectId,
	extractProjectPath,
	GitLabCommentService,
	GitLabEventTransport,
	isNoteOnMergeRequest,
	stripMention as stripGitLabMention,
} from "cyrus-gitlab-event-transport";
import {
	LinearEventTransport,
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "cyrus-linear-event-transport";
import {
	type CyrusToolsOptions,
	createCyrusToolsServer,
	createFetchFailureModesClient,
	type FailureModesHttpClient,
	type ResolvedSession,
} from "cyrus-mcp-tools";
import {
	SlackEventTransport,
	type SlackWebhookEvent,
} from "cyrus-slack-event-transport";
import { Sessions, streamableHttp } from "fastify-mcp";
import type { ClientSurfaceKind } from "./ActivityPoster.js";
import { ActivityPoster } from "./ActivityPoster.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import { AskUserQuestionHandler } from "./AskUserQuestionHandler.js";
import { AttachmentService } from "./AttachmentService.js";
import { LiveChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import { ChatSessionHandler } from "./ChatSessionHandler.js";
import { CockpitMirror } from "./CockpitMirror.js";
import { ConfigManager, type RepositoryChanges } from "./ConfigManager.js";
import {
	buildClientSurfaceRuleBlock,
	findClientContentViolations,
	sanitizeClientPaths,
} from "./client-content-policy.js";
import {
	buildClientLifecyclePlan,
	CLIENT_MESSAGES,
	type ClientLifecyclePhase,
} from "./client-messages.js";
import { ClientRegistry, teamKeyOf } from "./client-registry.js";
import { DefaultSkillsDeployer } from "./DefaultSkillsDeployer.js";
import { EgressProxy } from "./EgressProxy.js";
import { GitService, WorktreeCreationRefusedError } from "./GitService.js";
import { GlobalSessionRegistry } from "./GlobalSessionRegistry.js";
import {
	convertPullRequestToDraft,
	isPullRequestDraft,
	markPullRequestReady,
	parsePullRequestUrl,
} from "./github-pr-ready.js";
import { isQueueReorderIntent, LaneManager } from "./LaneManager.js";
import { NeedsInfoStore } from "./NeedsInfoStore.js";
import {
	buildNeedsInfoRuleBlock,
	isNeedsInfoQuestion,
	NEEDS_INFO_HEADER,
} from "./needs-info.js";
import {
	buildMirrorImplementationBlock,
	buildOperatorSessionBlock,
	classifyMirrorIntent,
	OPERATOR_GIT_DENY,
	type OperatorSessionLink,
	OperatorSessionRegistry,
	resolveMirrorActor,
} from "./operator-session.js";
import {
	containsBypassToken,
	fetchPreviewDeployment,
	renderPreview,
	withPreviewBypass,
} from "./preview-deployment.js";
import {
	buildDeliveredRequestBlock,
	buildReviewerRequestBlock,
	interpretReworkAnswer,
	isReworkConfirmQuestion,
	REWORK_NO_LABEL,
	REWORK_YES_LABEL,
} from "./request-intent.js";
import { ScopeApprovalStore } from "./ScopeApprovalStore.js";
import {
	buildImplementationParkedBlock,
	buildScopeAskBody,
	buildScopeConfirmGateBlock,
	interpretCanonicalScopeAnswer,
	interpretScopeConfirmAnswer,
	isScopeConfirmQuestion,
} from "./scope-confirm-gate.js";
import { ScopeWaitingRoom, WAITING_ROOM_TITLE } from "./scope-waiting-room.js";
import {
	VerificationGate,
	type VerificationRecord,
} from "./VerificationGate.js";

/** Options threaded through the created-session flow by the lane machinery. */
interface LaneStartOptions {
	/** The lane is already assigned to this session (dequeue replay). */
	laneAssigned?: boolean;
	/** Prompts collected while the session was queued. */
	queuedContextPrompts?: string[];
}

import { randomUUID } from "node:crypto";
import { McpConfigService } from "./McpConfigService.js";
import { PromptBuilder } from "./PromptBuilder.js";
import {
	opaquePreviewUrl,
	PreviewLinkStore,
	publicBaseUrlFrom,
} from "./preview-links.js";
import type {
	IssueContextResult,
	PromptAssembly,
	PromptAssemblyInput,
	PromptComponent,
	PromptType,
} from "./prompt-assembly/types.js";
import {
	RepositoryRouter,
	type RepositoryRouterDeps,
} from "./RepositoryRouter.js";
import {
	RunnerConfigBuilder,
	resolveIssueMcpConfigPath,
} from "./RunnerConfigBuilder.js";
import { RunnerSelectionService } from "./RunnerSelectionService.js";
import { SharedApplicationServer } from "./SharedApplicationServer.js";
import {
	type SkillSessionContext,
	SkillsPluginResolver,
} from "./SkillsPluginResolver.js";
import { SlackChatAdapter } from "./SlackChatAdapter.js";
import type { IActivitySink } from "./sinks/IActivitySink.js";
import { LinearActivitySink } from "./sinks/LinearActivitySink.js";
import { ToolPermissionResolver } from "./ToolPermissionResolver.js";
import type { AgentSessionData, EdgeWorkerEvents } from "./types.js";
import { UserAccessControl } from "./UserAccessControl.js";

export declare interface EdgeWorker {
	on<K extends keyof EdgeWorkerEvents>(
		event: K,
		listener: EdgeWorkerEvents[K],
	): this;
	emit<K extends keyof EdgeWorkerEvents>(
		event: K,
		...args: Parameters<EdgeWorkerEvents[K]>
	): boolean;
}

type CyrusToolsMcpContext = {
	contextId?: string;
};

/**
 * Unified edge worker that **orchestrates**
 *   capturing Linear webhooks,
 *   managing Claude Code processes, and
 *   processes results through to Linear Agent Activity Sessions
 */
/**
 * The sentence Linear seeds an agent-session thread with. It is the only way
 * to tell a delegation from a mention (the comment body is always populated),
 * and — since PON-225 — the only way to tell Linear's boilerplate from
 * something a person actually typed on a mirror.
 */
const AGENT_SESSION_THREAD_MARKER = "This thread is for an agent session";

/**
 * Human duration for the lifecycle clock (2026-09-02). Minutes up to an hour,
 * then hours, then days — the reviewer reads a shape, not a stopwatch.
 */
function formatLifecycleDuration(ms: number): string {
	const min = Math.round(ms / 60000);
	if (min < 1) return "under a minute";
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh ? `${d}d ${rh}h` : `${d}d`;
}

export class EdgeWorker extends EventEmitter {
	private config: EdgeWorkerConfig;
	private repositories: Map<string, RepositoryConfig> = new Map(); // repository 'id' (internal, stored in config.json) mapped to the full repo config
	private agentSessionManager: AgentSessionManager; // Single instance managing all agent sessions across repositories
	private activitySinks: Map<string, IActivitySink> = new Map(); // Maps Linear workspace ID to activity sink (one per workspace, mirrors issueTrackers)
	private sessionRepositories: Map<string, string> = new Map(); // Maps session ID to repository ID
	private lastStopTimeBySession: Map<string, number> = new Map(); // Maps session ID to timestamp of last stop signal (for double-stop detection)
	/**
	 * Pre-warmed Claude sessions keyed by agentSessionId (PON-139: each entry
	 * records the auth env its subprocess was spawned with, so attach can prove
	 * the credential still matches instead of assuming it).
	 */
	private warmInstances: Map<
		string,
		{
			query: WarmQuery;
			authEnv: Record<string, string | undefined> | undefined;
		}
	> = new Map();
	private issueTrackers: Map<string, IIssueTrackerService> = new Map(); // one issue tracker per Linear workspace (keyed by linearWorkspaceId)
	private linearEventTransport: LinearEventTransport | null = null; // Single event transport for webhook delivery
	private gitHubEventTransport: GitHubEventTransport | null = null; // GitHub event transport for forwarded GitHub webhooks
	/**
	 * Per-repository GitHub App installation resolution (PON-143). Replaces a
	 * single process-wide installation id, which could only be correct for one
	 * tenant and silently served every other one with the wrong credential.
	 */
	private gitHubInstallationResolver: GitHubInstallationResolver | null = null;
	private gitLabEventTransport: GitLabEventTransport | null = null; // GitLab event transport for forwarded GitLab webhooks
	private slackEventTransport: SlackEventTransport | null = null;
	private chatSessionHandler: ChatSessionHandler<SlackWebhookEvent> | null =
		null;
	private gitHubCommentService: GitHubCommentService; // Service for posting comments back to GitHub PRs
	private gitLabCommentService: GitLabCommentService; // Service for posting comments back to GitLab MRs
	private cliRPCServer: CLIRPCServer | null = null; // CLI RPC server for CLI platform mode
	private configUpdater: ConfigUpdater | null = null; // Single config updater for configuration updates
	private persistenceManager: PersistenceManager;
	private sharedApplicationServer: SharedApplicationServer;
	private cyrusHome: string;
	private globalSessionRegistry: GlobalSessionRegistry; // Centralized session storage across all repositories
	/**
	 * In-flight OAuth relays (PON-126). Short-lived: a state, and the code once
	 * it arrives. Never a token — the CLI does the exchange.
	 */
	private readonly oauthRelayFlows = new Map<
		string,
		{ state: string; code?: string; createdAt: number }
	>();
	private laneManager: LaneManager; // Per-workspace serialized lanes (PON-112)
	private laneGraceTimers: Map<string, NodeJS.Timeout> = new Map(); // workspaceId → boot-grace timer
	/** Grace window for a restored lane holder with no live runner (PON-112). */
	private static readonly LANE_BOOT_GRACE_MS = 10 * 60 * 1000;
	private configPath?: string; // Path to config.json file
	/** @internal - Exposed for testing only */
	public repositoryRouter: RepositoryRouter; // Repository routing and selection
	private gitService: GitService;
	private activeWebhookCount = 0; // Track number of webhooks currently being processed
	/** Handler for AskUserQuestion tool invocations via Linear select signal */
	private askUserQuestionHandler: AskUserQuestionHandler;
	/** Per-issue scope-approval records for the scope-confirm gate (PON-150) */
	private scopeApprovals: ScopeApprovalStore = new ScopeApprovalStore();
	private needsInfo: NeedsInfoStore = new NeedsInfoStore();
	/** Opaque preview links: the bypass value never leaves the box (v3.1). */
	private previewLinks: PreviewLinkStore = new PreviewLinkStore();
	private previewLinkDirectWarned = false;
	/** Operator-cockpit mirror (PON-151) — derived view, write-only from here */
	private cockpitMirror!: CockpitMirror;
	/**
	 * Where a stalled scope conversation becomes noticeable (PON-219).
	 *
	 * Pre-approval work is off the board entirely, so this is the only place
	 * an operator can see that a client has gone quiet mid-scope. It holds no
	 * state of its own — it renders `scopeApprovals.listPending()`.
	 */
	private scopeWaitingRoom!: ScopeWaitingRoom;
	/**
	 * Sessions that started from an @mention (PON-151). A mention is a
	 * conversation on the issue, not the delegated work — its end must not
	 * close the issue's cockpit mirror. In-memory: after a restart the
	 * other-live-work check in shouldCloseCockpitMirror covers the gap.
	 */
	private mentionSessionIds = new Set<string>();
	/** Verify-before-client-sees (PON-152): held summaries awaiting approval */
	private verificationGate: VerificationGate = new VerificationGate();
	/**
	 * PON-208: live operator sessions on cockpit mirrors. The registry is the
	 * one thing that says "this session is a working surface, not a client
	 * one" — every exemption below keys on it.
	 */
	private operatorSessions: OperatorSessionRegistry =
		new OperatorSessionRegistry();
	/** PON-152 escalation ladder timer */
	private verificationLadderTimer: NodeJS.Timeout | undefined;
	/** Workspace token liveness (PON-136) */
	private workspaceLivenessTimer: NodeJS.Timeout | undefined;
	private workspaceLivenessTickRunning = false;
	/** User access control for whitelisting/blacklisting Linear users */
	private userAccessControl: UserAccessControl;
	private logger: ILogger;
	// Extracted service modules
	private attachmentService: AttachmentService;
	private runnerSelectionService: RunnerSelectionService;
	private toolPermissionResolver: ToolPermissionResolver;
	private mcpConfigService: McpConfigService;
	private runnerConfigBuilder: RunnerConfigBuilder;
	private activityPoster: ActivityPoster;
	/**
	 * PON-200: in-flight assignment-recovery checks, keyed by issue. A client
	 * flipping the assignee a few times must not queue several creations.
	 */
	private pendingAssignmentRecoveries = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	/** Grace window for Linear to create the session itself. */
	private assignmentRecoveryDelayMs = Number(
		process.env.CYRUS_ASSIGNMENT_RECOVERY_MS ?? 15_000,
	);
	/**
	 * When Linear last opened an agent-session thread on an issue (PON-226).
	 *
	 * In memory and unbounded only by live issues: it is read once, inside the
	 * re-delegation recovery's grace window, and a stale entry is harmless
	 * because the check is a recency comparison rather than a presence one.
	 */
	private agentSessionSeenAt = new Map<string, number>();
	private configManager: ConfigManager;
	private promptBuilder: PromptBuilder;
	private defaultSkillsDeployer: DefaultSkillsDeployer;
	private skillsPluginResolver: SkillsPluginResolver;
	private readonly cyrusToolsMcpEndpoint = "/mcp/cyrus-tools";
	private cyrusToolsMcpRegistered = false;
	private cyrusToolsMcpRequestContext =
		new AsyncLocalStorage<CyrusToolsMcpContext>();
	private cyrusToolsMcpSessions = new Sessions<any>();
	/** Validates webhook source IPs against known provider allowlists */
	private webhookIpValidator: WebhookIpValidator;
	/** Egress proxy for sandbox network traffic filtering and header injection */
	private egressProxy: EgressProxy | null = null;
	/** Base SDK sandbox settings to pass to ClaudeRunner sessions (set when proxy starts) */
	private sdkSandboxSettings:
		| import("cyrus-claude-runner").SandboxSettings
		| null = null;
	/** CA cert path for MITM TLS termination (passed per-session env, not process.env) */
	private egressCaCertPath: string | null = null;
	/**
	 * Remote SessionStore that mirrors Claude SDK transcripts to the Cyrus
	 * hosted control plane. Enabled when all three of `CYRUS_APP_URL`,
	 * `CYRUS_API_KEY`, and `CYRUS_TEAM_ID` are set — used by any Claude
	 * runner spawned from this worker so transcripts survive ephemeral
	 * worktrees and are resumable from any host.
	 */
	private claudeSessionStore: SessionStore | null = null;
	/**
	 * Tracks recently processed issue-update webhook keys to prevent
	 * duplicate deliveries from Linear's at-least-once delivery.
	 * Key format: `${createdAt}:${issueId}`
	 */
	private processedIssueUpdateKeys = new Set<string>();

	/**
	 * Sessions parked due to blocked-by dependencies.
	 * Key: Linear issue ID (the blocked issue)
	 * Value: All data needed to replay initializeAgentRunner when unblocked
	 */
	private parkedSessions = new Map<
		string,
		{
			agentSession: AgentSessionCreatedWebhook["agentSession"];
			repositories: RepositoryConfig[];
			linearWorkspaceId: string;
			guidance?: AgentSessionCreatedWebhook["guidance"];
			commentBody?: string | null;
			baseBranchOverrides?: Map<string, string>;
			routingMethod?: string;
			blockingIssueIds: string[];
		}
	>();

	/**
	 * Resolve `~/` prefixes in path-bearing config fields that are otherwise
	 * passed verbatim to `fs.readFileSync` (which does not expand tildes).
	 * Repository-scoped paths are normalized separately in addNew /
	 * updateModified; this covers the platform-level MCP config lists that
	 * cyrus-hosted writes with literal `~/.cyrus/...` prefixes when
	 * generating self-host config.
	 */
	private static normalizeConfigPaths(
		config: EdgeWorkerConfig,
	): EdgeWorkerConfig {
		const resolveList = (paths: string[] | undefined): string[] | undefined =>
			paths ? paths.map(resolvePath) : undefined;
		return {
			...config,
			slackMcpConfigs: resolveList(config.slackMcpConfigs),
			linearMcpConfigs: resolveList(config.linearMcpConfigs),
			githubMcpConfigs: resolveList(config.githubMcpConfigs),
		};
	}

	constructor(config: EdgeWorkerConfig) {
		super();
		this.config = EdgeWorker.normalizeConfigPaths(config);
		this.cyrusHome = config.cyrusHome;
		this.logger = createLogger({ component: "EdgeWorker" });
		this.persistenceManager = new PersistenceManager(
			join(this.cyrusHome, "state"),
		);

		// Mirror Claude SDK session transcripts to the hosted control plane
		// when CYRUS_API_KEY (proof of team ownership) and CYRUS_TEAM_ID
		// (which team the transcripts belong to) are configured. The
		// destination URL defaults to DEFAULT_CYRUS_APP_URL but can be
		// overridden via CYRUS_APP_URL for preview environments. If either
		// of the required vars is missing the store stays null and the SDK
		// falls back to local JSONL only. Operators can also opt out
		// explicitly by setting CYRUS_DISABLE_REMOTE_SESSION_STORE=1, which
		// keeps transcripts local even when the vars above are present.
		const sessionStoreBaseUrl = getCyrusAppUrl();
		const sessionStoreApiKey = process.env.CYRUS_API_KEY;
		const sessionStoreTeamId = process.env.CYRUS_TEAM_ID;
		const sessionStoreDisabled = this.isRemoteSessionStoreDisabled();
		if (!sessionStoreDisabled && sessionStoreApiKey && sessionStoreTeamId) {
			this.claudeSessionStore = new HttpSessionStore({
				baseUrl: sessionStoreBaseUrl,
				apiKey: sessionStoreApiKey,
				teamId: sessionStoreTeamId,
				logger: this.logger,
			});
			this.logger.info(
				`[SessionStore] Mirroring Claude sessions to ${sessionStoreBaseUrl} for team ${sessionStoreTeamId}`,
			);
		} else if (
			sessionStoreDisabled &&
			sessionStoreApiKey &&
			sessionStoreTeamId
		) {
			this.logger.info(
				"[SessionStore] Remote session store disabled via CYRUS_DISABLE_REMOTE_SESSION_STORE; transcripts will stay local.",
			);
		}

		// Initialize GitHub comment service for posting replies to GitHub PRs
		this.gitHubCommentService = new GitHubCommentService();

		// Initialize GitLab comment service for posting replies to GitLab MRs.
		// For Self-Managed GitLab the API base URL must be derived from the
		// configured repos' gitlabUrl host; otherwise the service falls back to
		// gitlab.com and 404s on every reply. Picks the first configured
		// GitLab repo's host (single GitLab host per Cyrus instance).
		const firstGitlabRepo = config.repositories.find((r) => r.gitlabUrl);
		let gitlabApiBaseUrl: string | undefined;
		if (firstGitlabRepo?.gitlabUrl) {
			try {
				gitlabApiBaseUrl = new URL(firstGitlabRepo.gitlabUrl).origin;
			} catch {
				// malformed gitlabUrl — leave undefined and fall through to default
			}
		}
		this.gitLabCommentService = new GitLabCommentService(
			gitlabApiBaseUrl ? { apiBaseUrl: gitlabApiBaseUrl } : undefined,
		);

		// Initialize global session registry (centralized session storage)
		this.globalSessionRegistry = new GlobalSessionRegistry();
		this.laneManager = new LaneManager(
			// Serialized by default (PON-139). A newly authorised workspace is
			// serialized before anyone thinks about it, rather than after — an
			// unserialized lane has no cost regulator, so opt-out is the safe
			// default and opt-in was not. Explicit `false` still disables it.
			(workspaceId) =>
				this.config.linearWorkspaces?.[workspaceId]?.laneSerialization !==
				false,
			this.logger,
			(workspaceId) =>
				this.config.linearWorkspaces?.[workspaceId]?.laneConcurrency ?? 1,
		);

		// Initialize repository router with dependencies
		const repositoryRouterDeps: RepositoryRouterDeps = {
			fetchIssueLabels: async (issueId: string, linearWorkspaceId: string) => {
				// Use workspace ID directly from webhook context (Linear-native source)
				const issueTracker = this.issueTrackers.get(linearWorkspaceId);
				if (!issueTracker) return [];

				// Use platform-agnostic getIssueLabels method
				return await issueTracker.getIssueLabels(issueId);
			},
			fetchIssueDescription: async (
				issueId: string,
				linearWorkspaceId: string,
			): Promise<string | undefined> => {
				// Use workspace ID directly from webhook context (Linear-native source)
				const issueTracker = this.issueTrackers.get(linearWorkspaceId);
				if (!issueTracker) return undefined;

				// Fetch issue and get description
				try {
					const issue = await issueTracker.fetchIssue(issueId);
					return issue?.description ?? undefined;
				} catch (error) {
					this.logger.error(
						`Failed to fetch issue description for routing:`,
						error,
					);
					return undefined;
				}
			},
			hasActiveSession: (issueId: string, _repositoryId: string) => {
				// Priority 0 is a best-effort optimization (TODO-remove) — it must
				// never crash routing. Null-safe so a missing/partial session
				// manager falls through to normal routing rather than throwing.
				const activeSessions =
					this.agentSessionManager?.getActiveSessionsByIssueId?.(issueId);
				return (activeSessions?.length ?? 0) > 0;
			},
			getIssueTracker: (linearWorkspaceId: string) => {
				return this.getIssueTrackerForWorkspace(linearWorkspaceId);
			},
		};
		this.repositoryRouter = new RepositoryRouter(repositoryRouterDeps);
		this.gitService = new GitService({
			cyrusHome: this.cyrusHome,
			// PON-143: authenticate git against the repository's OWN installation,
			// resolved from its origin remote. Routing decides where work happens;
			// GitHub decides which credential covers a repository, and those two
			// facts must not be able to disagree.
			resolveGitAuth: (repositoryPath, operation) =>
				this.resolveGitAuthForRepoPath(repositoryPath, operation),
		});

		// Initialize AskUserQuestion handler for elicitation via Linear select signal
		this.askUserQuestionHandler = new AskUserQuestionHandler({
			getIssueTracker: (linearWorkspaceId: string) => {
				return this.getIssueTrackerForWorkspace(linearWorkspaceId) ?? null;
			},
			// PON-179: elicitations on gated workspaces are policy-sanitized
			// (repo-relative paths); non-gated surfaces post verbatim.
			sanitizeClientText: (sessionId: string, text: string) =>
				this.agentSessionManager.sanitizeClientSurfaceText(
					sessionId,
					"elicitation",
					text,
				),
		});

		// Operator cockpit (PON-151): a derived mirror of delegated issues in
		// one Linear team. Config read live so hot-reload applies; the persist
		// hook is best-effort — a broken mirror never breaks a client session.
		this.cockpitMirror = new CockpitMirror(
			{
				getConfig: () => this.config.cockpit,
				getToken: (workspaceId) =>
					this.config.linearWorkspaces?.[workspaceId]?.linearToken,
				getWorkspaceName: (workspaceId) =>
					this.config.linearWorkspaces?.[workspaceId]?.linearWorkspaceName,
				// PON-207: who the work is for. Built per call so a config
				// hot-reload changes what the operator sees without a restart.
				resolveClient: (workspaceId, teamKey) =>
					new ClientRegistry(this.config.clients).resolveFor(
						workspaceId,
						teamKey,
					),
				// PON-212: open the mirror's thread as it is created, and point
				// any live session for that issue at it — so the narration the
				// client's surface suppresses lands somewhere the operator can
				// read instead of being dropped.
				// PON-219: the invariant that keeps unapproved work off the
				// operator's board. Read live, per write — an issue crosses this
				// line exactly once, mid-session, and a value captured earlier
				// would be the wrong answer on the write that matters.
				scopeGatePending: (workspaceId, issueId) =>
					this.scopeGatePendingForIssue(workspaceId, issueId),
				// Trailing-debounced: a lane dequeue re-renders every queued
				// mirror, and N back-to-back transitions must not become N
				// full state-file writes.
				persist: async () => {
					this.scheduleCockpitPersist();
				},
			},
			this.logger,
		);

		this.scopeWaitingRoom = new ScopeWaitingRoom(
			{
				getConfig: () =>
					this.config.cockpit
						? {
								linearWorkspaceId: this.config.cockpit.linearWorkspaceId,
								teamId: this.config.cockpit.teamId,
							}
						: undefined,
				getToken: (workspaceId) =>
					this.config.linearWorkspaces?.[workspaceId]?.linearToken,
				getClientName: (workspaceId) =>
					workspaceId
						? new ClientRegistry(this.config.clients).resolveFor(workspaceId)
								.displayName
						: undefined,
				// Same threshold as the verification ladder's first rung: the
				// operator already has one calibrated sense of "this has been
				// quiet too long", and a second number would just be another
				// thing to tune.
				stallAfterHours: () =>
					this.config.verificationEscalation?.remindAfterHours ?? 4,
				now: () => Date.now(),
			},
			this.logger,
		);

		// Initialize webhook IP validator
		// Enabled by default in self-hosted mode (CYRUS_HOST_EXTERNAL=true),
		// can be overridden with WEBHOOK_IP_VALIDATION=false to disable
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const ipValidationEnv =
			process.env.WEBHOOK_IP_VALIDATION?.toLowerCase().trim();
		const ipValidationEnabled =
			ipValidationEnv === "true" ||
			(ipValidationEnv !== "false" && isExternalHost);
		this.webhookIpValidator = new WebhookIpValidator({
			enabled: ipValidationEnabled,
		});
		if (ipValidationEnabled) {
			this.logger.info("Webhook IP validation enabled");
		}

		// Initialize shared application server
		const serverPort = config.serverPort || config.webhookPort || 3456;
		const serverHost = config.serverHost || "localhost";
		const skipTunnel = config.platform === "cli"; // Skip Cloudflare tunnel in CLI mode
		this.sharedApplicationServer = new SharedApplicationServer(
			serverPort,
			serverHost,
			skipTunnel,
		);

		// Create single AgentSessionManager instance shared across all repositories
		this.agentSessionManager = new AgentSessionManager(
			(childSessionId: string) => {
				this.logger.debug(
					`Looking up parent session for child ${childSessionId}`,
				);
				const parentId =
					this.globalSessionRegistry.getParentSessionId(childSessionId);
				this.logger.debug(
					`Child ${childSessionId} -> Parent ${parentId || "not found"}`,
				);
				return parentId;
			},
			async (parentSessionId, prompt, childSessionId) => {
				const repoId = this.sessionRepositories.get(childSessionId);
				const repo = repoId ? this.repositories.get(repoId) : undefined;
				if (!repo) {
					this.logger.error(
						`No repository found for child session ${childSessionId}`,
					);
					return;
				}
				await this.handleResumeParentSession(
					parentSessionId,
					prompt,
					childSessionId,
				);
			},
			undefined,
			// PON-112: every session outcome (success, error, user stop) must
			// release a lane held by that session.
			(sessionId: string) => this.handleLaneSessionEnded(sessionId, "result"),
			// PON-115: tag every session log line with its owning tenant.
			(sessionId: string) => this.resolveWorkspaceIdForSession(sessionId),
			// PON-116: publish the session plan and PR/preview links. Resolved
			// here because EdgeWorker owns the session -> issue-tracker mapping.
			// Platforms without session plans simply omit updateAgentSession, and
			// a false return is treated as "not published" rather than an error:
			// these are cosmetic surfaces and must never disturb the session.
			async (sessionId, fields) => {
				// PON-208: this is the one surface that resolves its tracker by
				// WORKSPACE rather than by the session's sink — and an operator
				// session's workspace is the client's. Left alone it would
				// publish the reviewer's session plan and links into the
				// client's workspace, addressed to a session id that does not
				// exist there. The surface follows the sink, so it follows the
				// cockpit.
				const workspaceId =
					this.operatorSessions.get(sessionId)?.cockpitWorkspaceId ??
					this.resolveWorkspaceIdForSession(sessionId);
				if (!workspaceId) return false;
				const tracker = this.issueTrackers.get(workspaceId);
				if (!tracker?.updateAgentSession) return false;
				return await tracker.updateAgentSession(sessionId, fields);
			},
			// PON-179: in a gated (client-flow) workspace the activity stream
			// is a client surface — narration must not post there.
			(sessionId: string) => this.clientQuietSession(sessionId),
		);
		// Verify-before-client-sees (PON-152): the final completion response
		// of a delegated session in a gated workspace is stored, not posted.
		// Mentions and child sessions post as before — they are conversation,
		// not the deliverable.
		// Optional-call: partial AgentSessionManager test doubles may lack the
		// setter. The real class always has it — and the warn below keeps a
		// genuinely absent hook from being silent (the PR #15 lesson).
		if (
			typeof this.agentSessionManager.setFinalResponseInterceptor !== "function"
		) {
			this.logger.warn(
				"AgentSessionManager has no setFinalResponseInterceptor — the verification gate (PON-152) is NOT armed",
			);
		}
		this.agentSessionManager.setFinalResponseInterceptor?.(
			(sessionId, content, isError) => {
				try {
					return this.holdCompletionForVerification(
						sessionId,
						content,
						isError,
					);
				} catch (error) {
					// The gate must fail OPEN for posting: a broken gate must
					// never silently swallow a client's summary.
					this.logger.error(
						"Verification interceptor failed — posting normally:",
						error,
					);
					return false;
				}
			},
		);
		// PON-221: the same hold, applied to the session SURFACE. Links are
		// attached to the client's agent session rather than posted as an
		// activity, so neither the quiet funnel nor the interceptor above
		// ever sees them — a client could watch the draft PR button arrive
		// mid-review. Held here, released by `deliverHeldSummary`.
		if (typeof this.agentSessionManager.setLinkPublicationHold !== "function") {
			this.logger.warn(
				"AgentSessionManager has no setLinkPublicationHold — work-in-progress links are NOT held (PON-221)",
			);
		}
		this.agentSessionManager.setLinkPublicationHold?.((sessionId: string) => {
			try {
				return this.linksHeldForSession(sessionId);
			} catch (error) {
				// Fail CLOSED, unlike the poster above. The asymmetry is the
				// point: a suppressed link costs the client one extra look at
				// their own repository, while a leaked one hands them work in
				// progress that Harold has not released. Only the second is
				// unrecoverable.
				this.logger.error("Link hold check failed — holding the links:", error);
				return true;
			}
		});

		// Initialize repositories with path resolution
		for (const repo of config.repositories) {
			if (repo.isActive !== false) {
				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				this.repositories.set(repo.id, resolvedRepo);
			}
		}

		// Initialize issue trackers per workspace (one per workspace, not per repo)
		if (config.linearWorkspaces) {
			for (const [linearWorkspaceId, wsConfig] of Object.entries(
				config.linearWorkspaces,
			)) {
				const issueTracker =
					this.config.platform === "cli"
						? (() => {
								const service = new CLIIssueTrackerService();
								service.seedDefaultData();
								return service;
							})()
						: new LinearIssueTrackerService(
								new LinearClient({
									accessToken: wsConfig.linearToken,
								}),
								this.buildOAuthConfig(linearWorkspaceId),
							);
				this.issueTrackers.set(linearWorkspaceId, issueTracker);
			}
		}

		// Create activity sinks per workspace (one per workspace, mirrors issueTrackers)
		for (const [workspaceId, issueTracker] of this.issueTrackers) {
			this.activitySinks.set(
				workspaceId,
				new LinearActivitySink(issueTracker, workspaceId),
			);
		}

		// Initialize user access control with global and per-repository configs
		const repoAccessConfigs = new Map<
			string,
			import("cyrus-core").UserAccessControlConfig | undefined
		>();
		for (const repo of config.repositories) {
			if (repo.isActive !== false) {
				repoAccessConfigs.set(repo.id, repo.userAccessControl);
			}
		}
		this.userAccessControl = new UserAccessControl(
			config.userAccessControl,
			repoAccessConfigs,
		);

		// Initialize extracted service modules
		this.attachmentService = new AttachmentService(
			this.logger,
			this.cyrusHome,
			this.config.linearWorkspaces || {},
		);
		this.runnerSelectionService = new RunnerSelectionService(this.config);
		this.toolPermissionResolver = new ToolPermissionResolver(
			this.config,
			this.logger,
		);
		this.mcpConfigService = new McpConfigService({
			getLinearTokenForWorkspace: (workspaceId) =>
				this.getLinearTokenForWorkspace(workspaceId),
			getIssueTracker: (workspaceId) =>
				this.issueTrackers.get(workspaceId) as
					| (IIssueTrackerService & {
							getClient?: () => import("@linear/sdk").LinearClient;
					  })
					| undefined,
			getCyrusToolsMcpUrl: () => this.getCyrusToolsMcpUrl(),
			createCyrusToolsOptions: (parentSessionId) =>
				this.createCyrusToolsOptions(parentSessionId),
		});
		this.runnerConfigBuilder = new RunnerConfigBuilder(
			this.toolPermissionResolver,
			this.mcpConfigService,
			this.runnerSelectionService,
		);
		this.activityPoster = new ActivityPoster(
			this.issueTrackers,
			this.repositories,
			this.logger,
			// PON-189: direct posts obey the same client-surface floor as the
			// two AgentSessionManager paths. Closures, not values — the
			// session manager is wired after this constructor runs.
			{
				isQuiet: (sessionId: string, workspaceId?: string) =>
					this.clientQuietSession(sessionId, workspaceId),
				sanitize: (sessionId: string, surface: string, text: string) => {
					// The floor runs on the request path of live client
					// sessions, so it must never throw: without a session
					// manager it degrades to the same path rule minus the
					// workspace-prefix stripping, never to no rule at all.
					const manager = this.agentSessionManager as
						| Partial<AgentSessionManager>
						| undefined;
					if (typeof manager?.sanitizeClientSurfaceText === "function") {
						return manager.sanitizeClientSurfaceText(sessionId, surface, text);
					}
					return sanitizeClientPaths(text).text;
				},
			},
		);
		this.configManager = new ConfigManager(
			this.config,
			this.logger,
			this.configPath,
			this.repositories,
		);
		this.promptBuilder = new PromptBuilder({
			logger: this.logger,
			repositories: this.repositories,
			issueTrackers: this.issueTrackers,
			gitService: this.gitService,
		});
		this.defaultSkillsDeployer = new DefaultSkillsDeployer(
			this.cyrusHome,
			this.logger,
		);
		this.skillsPluginResolver = new SkillsPluginResolver(
			this.cyrusHome,
			this.logger,
		);

		// Components will be initialized and registered in start() method before server starts
	}

	/**
	 * Start the edge worker
	 */
	async start(): Promise<void> {
		// Deploy default skills to cyrusHome if not already present (one-time setup)
		await this.defaultSkillsDeployer.ensureDeployed();

		// Scaffold user skills plugin manifest if needed (one-time setup)
		await this.skillsPluginResolver.ensureUserPluginScaffolded();

		// Load persisted state for each repository
		await this.loadPersistedState();

		// PON-115: fill in per-install identity (app-user id, install
		// timestamp) for workspaces authorized before those fields existed.
		// Fire-and-forget — it costs one API call per incomplete workspace and
		// must never delay serving webhooks.
		void this.backfillWorkspaceInstallRecords().catch((error) => {
			this.logger.warn("Workspace install-record backfill failed:", error);
		});

		// Pre-warm the 30 most recent Claude sessions in the background
		// so their first query after restart has near-zero cold-start latency.
		// Disabled by default; opt in with CYRUS_ENABLE_WARM_SESSIONS=1.
		if (this.isWarmSessionsEnabled()) {
			this.warmupRecentSessions(30).catch((err) => {
				this.logger.warn("Session warmup failed (non-fatal):", err);
			});
		}

		// Start config file watcher via ConfigManager
		this.configManager.on(
			"configChanged",
			async (changes: RepositoryChanges) => {
				this.updateLinearWorkspaceTokens(changes.newConfig);
				await this.removeDeletedRepositories(changes.removed);
				await this.updateModifiedRepositories(changes.modified);
				await this.addNewRepositories(changes.added);
				// Live-update sandbox / egress proxy settings
				await this.applySandboxConfigChanges(changes.newConfig);
				this.config = EdgeWorker.normalizeConfigPaths(changes.newConfig);
				this.configManager.setConfig(changes.newConfig);
				this.runnerSelectionService.setConfig(changes.newConfig);
				this.toolPermissionResolver.setConfig(changes.newConfig);
			},
		);
		this.configManager.startConfigWatcher();

		// Start egress proxy if sandbox is enabled.
		// The proxy intercepts Bash-spawned subprocess traffic only (git, gh, npm, etc.).
		// Claude's inference API, MCP servers, and built-in file tools bypass the proxy.
		if (this.config.sandbox?.enabled) {
			this.logger.info("🛡️  Sandbox egress proxy: starting...");
			this.egressProxy = new EgressProxy(
				this.config.sandbox,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			// Store base SDK sandbox settings — merged per-session with worktree path
			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};

			const systemWideCert = this.config.sandbox?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			// When systemWideCert is true, the OS cert store handles trust
			// for all tools — skip per-session cert env vars.
			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else {
			this.logger.info(
				"🛡️  Sandbox egress proxy: disabled (set sandbox.enabled=true in config.json to enable)",
			);
		}

		// Initialize and register components BEFORE starting server (routes must be registered before listen())
		await this.initializeComponents();

		// Refresh GitHub webhook allowlist from /meta API (non-blocking)
		if (this.webhookIpValidator.isEnabled()) {
			this.webhookIpValidator.refreshGitHubAllowlist().catch((error) => {
				this.logger.warn(
					"Failed to refresh GitHub webhook allowlist",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		}

		// Start shared application server (this also starts Cloudflare tunnel if CLOUDFLARE_TOKEN is set)
		await this.sharedApplicationServer.start();
	}

	/**
	 * Initialize and register components (routes) before server starts
	 */
	private async initializeComponents(): Promise<void> {
		// 1. Platform-specific initialization
		if (this.config.platform === "cli") {
			// CLI mode: ensure a CLIIssueTrackerService exists for each repo workspace.
			// Repos from config.repositories don't go through linearWorkspaces init,
			// so we create trackers here if missing.
			for (const [repoId, repo] of this.repositories) {
				const wsId = repo.linearWorkspaceId;
				if (wsId && !this.issueTrackers.has(wsId)) {
					const service = new CLIIssueTrackerService();
					service.seedDefaultData();
					this.issueTrackers.set(wsId, service);
					const activitySink = new LinearActivitySink(service, wsId);
					this.activitySinks.set(repoId, activitySink);
				}
			}

			const firstCliTracker = Array.from(this.issueTrackers.values()).find(
				(tracker): tracker is CLIIssueTrackerService =>
					tracker instanceof CLIIssueTrackerService,
			);

			if (firstCliTracker) {
				this.cliRPCServer = new CLIRPCServer({
					fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
					issueTracker: firstCliTracker,
					version: "1.0.0",
				});

				// Register the /cli/rpc endpoint
				this.cliRPCServer.register();

				this.logger.info("✅ CLI RPC server registered");
				this.logger.info("   RPC endpoint: /cli/rpc");

				// Create CLI event transport and register listener
				const cliEventTransport = firstCliTracker.createEventTransport({
					platform: "cli",
					fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				});

				// Listen for webhook events
				cliEventTransport.on("event", (event: AgentEvent) => {
					const repos = Array.from(this.repositories.values());
					this.handleWebhook(event as unknown as Webhook, repos);
				});

				// Listen for unified internal messages (used by F1 to emit
				// IssueStateChangeMessage when an issue is terminated).
				cliEventTransport.on("message", (message: InternalMessage) => {
					this.handleMessage(message);
				});

				// Listen for errors
				cliEventTransport.on("error", (error: Error) => {
					this.handleError(error);
				});

				// Register the CLI event transport endpoints
				cliEventTransport.register();

				this.logger.info("✅ CLI event transport registered");
				this.logger.info(
					"   Event listener: listening for AgentSessionCreated events",
				);
			}
		} else {
			// Linear mode: Create and register LinearEventTransport
			const useDirectWebhooks =
				process.env.LINEAR_DIRECT_WEBHOOKS?.toLowerCase() === "true";
			const verificationMode = useDirectWebhooks ? "direct" : "proxy";

			// Get appropriate secret based on mode
			const secret = useDirectWebhooks
				? process.env.LINEAR_WEBHOOK_SECRET || ""
				: process.env.CYRUS_API_KEY || "";

			this.linearEventTransport = new LinearEventTransport({
				fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
				verificationMode,
				secret,
				ipAllowlist:
					verificationMode === "direct" && this.webhookIpValidator.isEnabled()
						? this.webhookIpValidator.getAllowlist("linear")
						: undefined,
			});

			// Listen for legacy webhook events (deprecated, kept for backward compatibility)
			this.linearEventTransport.on("event", (event: AgentEvent) => {
				const repos = Array.from(this.repositories.values());
				this.handleWebhook(event as unknown as Webhook, repos);
			});

			// Listen for unified internal messages (new message bus)
			this.linearEventTransport.on("message", (message: InternalMessage) => {
				this.handleMessage(message);
			});

			// Listen for errors
			this.linearEventTransport.on("error", (error: Error) => {
				this.handleError(error);
			});

			// Register the /linear-webhook endpoint (with /webhook retained as a deprecated alias)
			this.linearEventTransport.register();

			this.logger.info(
				`✅ Linear event transport registered (${verificationMode} mode)`,
			);
			this.logger.info(
				`   Webhook endpoint: ${this.sharedApplicationServer.getWebhookUrl()}`,
			);
		}

		// 2. Register GitHub and Slack event transports unconditionally
		// These don't require repositories and must be available during onboarding
		// for webhook URL verification to succeed.
		this.registerGitHubEventTransport();
		this.registerGitLabEventTransport();
		this.registerSlackEventTransport();

		// 3. Create and register ConfigUpdater (both platforms)
		this.configUpdater = new ConfigUpdater(
			this.sharedApplicationServer.getFastifyInstance(),
			this.cyrusHome,
			() => process.env.CYRUS_API_KEY || "",
		);

		// Register config update routes
		this.configUpdater.register();

		this.logger.info("✅ Config updater registered");
		this.logger.info(
			"   Routes: /api/update/cyrus-config, /api/update/cyrus-env,",
		);
		this.logger.info(
			"           /api/update/repository, /api/update/test-mcp, /api/update/configure-mcp",
		);

		// 3. Register MCP endpoint for cyrus-tools on the same Fastify server/port
		await this.registerCyrusToolsMcpEndpoint();
		// 4. Register /status endpoint for process activity monitoring
		this.registerStatusEndpoint();
		this.registerPreviewRedirectEndpoint();

		// 5. Register /version endpoint for CLI version info
		this.registerVersionEndpoint();

		// 6. Register localhost-only /admin/lanes endpoint (PON-112)
		this.registerLanesEndpoint();

		// 6b. OAuth relay so onboarding never needs an outage (PON-126)
		this.registerOAuthRelayEndpoints();

		// 7. Lane boot recovery (PON-112): grace window for a restored active
		// session with no live runner; drain lanes left free with queued work.
		// Runs last so transports, trackers, and endpoints are all live before
		// any queued session starts.
		this.armLaneBootRecovery();

		// 8. Cockpit reconciliation (PON-151): make the mirror match reality.
		// Fire-and-forget — startup never waits on a derived view.
		void this.reconcileCockpitMirror();

		// 9. PON-152 escalation ladder — reminders only, never delivery.
		this.armVerificationLadder();
		// PON-136: the liveness clock — idle workspaces get the refresh that
		// busy ones get from traffic.
		this.armWorkspaceLiveness();
		// PON-212: the review block reports state nobody notifies us about.
		this.armMirrorRefresh();
	}

	/**
	 * Register the /admin/lanes debug endpoint (PON-112). Loopback source AND
	 * absence of proxy-forwarding headers are both required: Caddy proxies
	 * public traffic to this server FROM loopback, so an IP check alone would
	 * expose the endpoint. Non-local requests get a 404, not a 403, so the
	 * route's existence is not advertised.
	 */
	private registerLanesEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/admin/lanes", async (request, reply) => {
			const forwarded = [
				"x-forwarded-for",
				"x-forwarded-proto",
				"x-forwarded-host",
				"x-real-ip",
				"forwarded",
			].some((header) => request.headers[header] !== undefined);
			const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
				request.ip,
			);
			if (!loopback || forwarded) {
				return reply.status(404).send({ error: "Not found" });
			}
			return reply.status(200).send({ lanes: this.laneManager.snapshot() });
		});

		// Scope-confirm gate list (PON-150). Same guard. This is the
		// independent answer to "an unconfirmed issue sits forever and nobody
		// notices" — it exists whether or not the operator cockpit does.
		fastify.get("/admin/scope-approvals", async (request, reply) => {
			const forwarded = [
				"x-forwarded-for",
				"x-forwarded-proto",
				"x-forwarded-host",
				"x-real-ip",
				"forwarded",
			].some((header) => request.headers[header] !== undefined);
			const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
				request.ip,
			);
			if (!loopback || forwarded) {
				return reply.status(404).send({ error: "Not found" });
			}
			const now = Date.now();
			return reply.status(200).send({
				pending: this.scopeApprovals.listPending().map((entry) => ({
					...entry,
					awaitingForMs: now - Date.parse(entry.proposedAt),
				})),
				all: this.scopeApprovals.serialize(),
				// PON-172: open needs-info waits — the same invisible-wait
				// guard, one door.
				needsInfo: {
					awaiting: this.needsInfo.listAwaiting().map((entry) => ({
						...entry,
						awaitingForMs: now - Date.parse(entry.askedAt),
					})),
					all: this.needsInfo.serialize(),
				},
			});
		});

		// Verification queue (PON-152). Same guard. "Visible and counted,
		// not merely stored" — independent of the cockpit.
		fastify.get("/admin/verification", async (request, reply) => {
			const forwarded = [
				"x-forwarded-for",
				"x-forwarded-proto",
				"x-forwarded-host",
				"x-real-ip",
				"forwarded",
			].some((header) => request.headers[header] !== undefined);
			const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
				request.ip,
			);
			if (!loopback || forwarded) {
				return reply.status(404).send({ error: "Not found" });
			}
			const now = Date.now();
			const pending = this.verificationGate.listPending().map((entry) => ({
				issueId: entry.issueId,
				issueIdentifier: entry.issueIdentifier,
				workspaceId: entry.workspaceId,
				completedAt: entry.completedAt,
				pendingForMs: now - Date.parse(entry.completedAt),
				isError: entry.isError,
				prUrls: entry.prUrls,
				escalatedAt: entry.escalatedAt,
				delayNotedAt: entry.delayNotedAt,
			}));
			return reply.status(200).send({
				pendingCount: pending.length,
				pending,
			});
		});

		this.logger.info("✅ Lanes endpoint registered (localhost only)");
		this.logger.info("   Route: GET /admin/lanes");
		this.logger.info("   Route: GET /admin/scope-approvals");
		this.logger.info("   Route: GET /admin/verification");
	}

	/**
	 * OAuth relay so a workspace can be authorised WITHOUT stopping the service
	 * (PON-126).
	 *
	 * `self-auth-linear` used to bind CYRUS_SERVER_PORT itself to catch the
	 * redirect — the same port this server listens on — so onboarding a client
	 * required an outage by construction. With three lanes on one box that is
	 * not acceptable: authorising a new client would pause every other client's
	 * work.
	 *
	 * Instead the running service catches the redirect and holds the code for
	 * the CLI to collect:
	 *
	 *   POST /admin/oauth/begin   -> { flowId, state }   (localhost only)
	 *   GET  /callback            <- Linear redirects the browser here (public)
	 *   GET  /admin/oauth/result  -> { code } once       (localhost only)
	 *
	 * The token exchange and config write stay in the CLI. This server never
	 * sees the client secret and never persists a credential — it relays one
	 * short-lived authorization code and forgets it.
	 */
	private registerOAuthRelayEndpoints(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();
		// A consent screen is a human step: log in, pick the workspace, read the
		// scopes, approve. Measured at 7m03s the first time it was run for real.
		// Must stay >= the CLI's polling deadline, or the service discards a code
		// the CLI is still waiting for.
		const TTL_MS = 15 * 60 * 1000;

		// Same guard as /admin/lanes: loopback AND no proxy-forwarding headers.
		// Caddy proxies public traffic from loopback, so an IP check alone would
		// expose these. 404 rather than 403 so the routes are not advertised.
		const localOnly = (request: {
			ip: string;
			headers: Record<string, unknown>;
		}): boolean => {
			const forwarded = [
				"x-forwarded-for",
				"x-forwarded-proto",
				"x-forwarded-host",
				"x-real-ip",
				"forwarded",
			].some((header) => request.headers[header] !== undefined);
			const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
				request.ip,
			);
			return loopback && !forwarded;
		};

		const sweep = (): void => {
			const now = Date.now();
			for (const [id, flow] of this.oauthRelayFlows) {
				if (now - flow.createdAt > TTL_MS) this.oauthRelayFlows.delete(id);
			}
		};

		fastify.post("/admin/oauth/begin", async (request, reply) => {
			if (!localOnly(request)) {
				return reply.status(404).send({ error: "Not found" });
			}
			sweep();
			const flowId = randomUUID();
			const state = randomUUID();
			this.oauthRelayFlows.set(flowId, { state, createdAt: Date.now() });
			this.logger.info(`[event:oauth_relay_begin] {"flowId":"${flowId}"}`);
			return reply.status(200).send({ flowId, state });
		});

		fastify.get("/admin/oauth/result", async (request, reply) => {
			if (!localOnly(request)) {
				return reply.status(404).send({ error: "Not found" });
			}
			const flowId = (request.query as { flowId?: string })?.flowId;
			const flow = flowId ? this.oauthRelayFlows.get(flowId) : undefined;
			if (!flow) return reply.status(404).send({ error: "Unknown flow" });
			if (!flow.code) return reply.status(200).send({ pending: true });
			// Single use: the code is surrendered once and forgotten.
			this.oauthRelayFlows.delete(flowId as string);
			return reply.status(200).send({ code: flow.code });
		});

		// Public — Linear redirects the operator's browser here. Accepts a code
		// only for a state issued by /admin/oauth/begin, so an arbitrary code
		// posted by anyone is refused.
		fastify.get("/callback", async (request, reply) => {
			sweep();
			const { code, state } = request.query as {
				code?: string;
				state?: string;
			};
			const entry = state
				? [...this.oauthRelayFlows.entries()].find(([, f]) => f.state === state)
				: undefined;

			if (!code || !entry) {
				this.logger.warn(
					"OAuth callback received without a matching pending flow",
				);
				return reply
					.type("text/html; charset=utf-8")
					.status(400)
					.send(
						"<h2>No authorization in progress</h2><p>Start one with <code>cyrus self-auth-linear</code>.</p>",
					);
			}

			entry[1].code = code;
			this.logger.info(`[event:oauth_relay_received] {"flowId":"${entry[0]}"}`);
			return reply
				.type("text/html; charset=utf-8")
				.status(200)
				.send(
					"<h2>Authorized</h2><p>You can close this tab — the terminal is finishing up.</p>",
				);
		});

		this.logger.info("✅ OAuth relay registered (service stays up)");
		this.logger.info("   Routes: POST /admin/oauth/begin, GET /callback");
	}

	/**
	 * Register the /status endpoint for checking if the process is busy or idle
	 * This endpoint is used to determine if the process can be safely restarted
	 */
	private registerStatusEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/status", async (_request, reply) => {
			const status = this.computeStatus();
			return reply.status(200).send({ status });
		});

		this.logger.info("✅ Status endpoint registered");
		this.logger.info("   Route: GET /status");
	}

	/**
	 * `GET /preview/:id` — the one public route that resolves an opaque
	 * preview link (v3.1). Unauthenticated by design: the id is the secret
	 * (128 random bits), the response is a redirect with no body, nothing is
	 * cached, and an unknown id says so in one plain sentence.
	 */
	private registerPreviewRedirectEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();
		fastify.get<{ Params: { id: string } }>(
			"/preview/:id",
			async (request, reply) => {
				const outcome = this.previewRedirectFor(request.params.id);
				reply.header("Cache-Control", "no-store");
				if (outcome.status !== 302) {
					return reply
						.status(404)
						.type("text/plain")
						.send("This preview link is no longer valid.");
				}
				return reply.redirect(outcome.location, 302);
			},
		);
		this.logger.info("✅ Preview redirect endpoint registered");
		this.logger.info("   Route: GET /preview/:id");
	}

	/** Resolve an opaque preview id; the bypass value is applied now, from config. */
	private previewRedirectFor(
		id: string,
	): { status: 302; location: string } | { status: 404 } {
		const record = this.previewLinks.resolve(id);
		if (!record) {
			this.logger.event("preview_link_unknown", { id: id.slice(0, 8) });
			return { status: 404 };
		}
		this.logger.event("preview_link_resolved", {
			id: id.slice(0, 8),
			issueId: record.issueId,
		});
		return {
			status: 302,
			location: withPreviewBypass(
				record.target,
				this.previewBypassTokenFor(record.workspaceId),
			),
		};
	}

	/**
	 * The link to publish for a preview: opaque when the box has a public
	 * base URL, the direct (tokenized) link otherwise — said once in the
	 * journal, because a link that carries the client's credential is the
	 * exposure this exists to end.
	 */
	private opaquePreviewLink(
		target: string,
		issueId: string,
		workspaceId: string | undefined,
	): string {
		const base = publicBaseUrlFrom(process.env.CYRUS_BASE_URL);
		if (!base || !workspaceId) {
			if (!this.previewLinkDirectWarned) {
				this.previewLinkDirectWarned = true;
				this.logger.warn(
					"CYRUS_BASE_URL is not set: preview links are published with the client's bypass value inside them",
				);
			}
			return target;
		}
		const id = this.previewLinks.mint(target, { issueId, workspaceId });
		this.logger.event("preview_link_minted", {
			issueId,
			workspaceId,
			id: id.slice(0, 8),
		});
		void this.savePersistedState();
		return opaquePreviewUrl(base, id);
	}

	/**
	 * Register the /version endpoint for CLI version information
	 * This endpoint is used by dashboards to display the installed CLI version
	 */
	private registerVersionEndpoint(): void {
		const fastify = this.sharedApplicationServer.getFastifyInstance();

		fastify.get("/version", async (_request, reply) => {
			return reply.status(200).send({
				cyrus_cli_version: this.config.version ?? null,
			});
		});

		this.logger.info("✅ Version endpoint registered");
		this.logger.info("   Route: GET /version");
	}

	/**
	 * Register the GitHub event transport for receiving forwarded GitHub webhooks from CYHOST.
	 * This creates a /github-webhook endpoint that handles @cyrusagent mentions on GitHub PRs.
	 */
	private registerGitHubEventTransport(): void {
		// Use direct GitHub signature verification only when BOTH:
		// 1. GITHUB_WEBHOOK_SECRET is set (we have the secret to verify)
		// 2. CYRUS_HOST_EXTERNAL is true (self-hosted: GitHub sends directly to us)
		// On cloud droplets, CYHOST forwards webhooks with Bearer token auth
		// (it verifies the GitHub signature itself and doesn't forward the headers).
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasGithubWebhookSecret =
			process.env.GITHUB_WEBHOOK_SECRET != null &&
			process.env.GITHUB_WEBHOOK_SECRET !== "";
		const useSignatureVerification = isExternalHost && hasGithubWebhookSecret;
		const verificationMode = useSignatureVerification ? "signature" : "proxy";
		const secret = useSignatureVerification
			? process.env.GITHUB_WEBHOOK_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.gitHubEventTransport = new GitHubEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode,
			secret,
			ipAllowlist:
				useSignatureVerification && this.webhookIpValidator.isEnabled()
					? this.webhookIpValidator.getAllowlist("github")
					: undefined,
		});

		// Listen for legacy GitHub webhook events (deprecated, kept for backward compatibility)
		this.gitHubEventTransport.on("event", (event: GitHubWebhookEvent) => {
			// Route push events to the base branch notification handler
			if (event.eventType === "push") {
				this.handleGitHubPushWebhook(event.payload as GitHubPushPayload).catch(
					(error) => {
						this.logger.error(
							"Failed to handle GitHub push webhook",
							error instanceof Error ? error : new Error(String(error)),
						);
					},
				);
				return;
			}
			this.handleGitHubWebhook(event as GitHubCommentWebhookEvent).catch(
				(error) => {
					this.logger.error(
						"Failed to handle GitHub webhook",
						error instanceof Error ? error : new Error(String(error)),
					);
				},
			);
		});

		// Listen for unified internal messages (new message bus)
		this.gitHubEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});

		// Listen for errors
		this.gitHubEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		// Register the /github-webhook endpoint
		this.gitHubEventTransport.register();

		// PON-143: per-repository installation resolution for self-hosted users.
		//
		// GITHUB_APP_INSTALLATION_ID is deliberately no longer read. One process
		// -wide installation id can only be correct for one tenant; for any other
		// repository it did not fail, it minted a valid token scoped to the wrong
		// org. The installation is now asked of GitHub per repository, so routing
		// and credential coverage cannot disagree.
		const appId = process.env.GITHUB_APP_ID;
		const pemPath = join(this.cyrusHome, "github-app.pem");
		if (appId && existsSync(pemPath)) {
			this.gitHubInstallationResolver = new GitHubInstallationResolver({
				appId,
				privateKeyPath: pemPath,
			});
			this.logger.info(
				"GitHub App installation resolver initialized (per-repository, self-hosted mode)",
			);
			if (process.env.GITHUB_APP_INSTALLATION_ID) {
				this.logger.warn(
					"GITHUB_APP_INSTALLATION_ID is set but no longer used — installations are resolved per repository (PON-143). It can be removed from the env file.",
				);
			}
		} else if (appId && !existsSync(pemPath)) {
			this.logger.warn(
				`GITHUB_APP_ID is set but ${pemPath} is missing — GitHub App auth is off. Private clones, pushes and PRs will fail.`,
			);
		}

		this.logger.info(
			`GitHub event transport registered (${verificationMode} mode)`,
		);
		this.logger.info("Webhook endpoint: POST /github-webhook");
	}

	/**
	 * Register the GitLab event transport for receiving forwarded GitLab webhooks.
	 * This creates a /gitlab-webhook endpoint that handles note events on merge requests.
	 */
	private registerGitLabEventTransport(): void {
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasGitlabWebhookSecret =
			process.env.GITLAB_WEBHOOK_SECRET != null &&
			process.env.GITLAB_WEBHOOK_SECRET !== "";
		const useSignatureVerification = isExternalHost && hasGitlabWebhookSecret;
		const verificationMode = useSignatureVerification ? "signature" : "proxy";
		const secret = useSignatureVerification
			? process.env.GITLAB_WEBHOOK_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.gitLabEventTransport = new GitLabEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode,
			secret,
		});

		// Listen for legacy GitLab webhook events
		this.gitLabEventTransport.on("event", (event: GitLabWebhookEvent) => {
			this.handleGitLabWebhook(event).catch((error) => {
				this.logger.error(
					"Failed to handle GitLab webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});

		// Listen for unified internal messages (new message bus)
		this.gitLabEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});

		// Listen for errors
		this.gitLabEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		// Register the /gitlab-webhook endpoint
		this.gitLabEventTransport.register();

		this.logger.info(
			`GitLab event transport registered (${verificationMode} mode)`,
		);
		this.logger.info("Webhook endpoint: POST /gitlab-webhook");
	}

	/**
	 * Whether Cyrus should follow plain replies in a Slack thread it was
	 * @mentioned in. Enabled by default; controlled by the per-team
	 * `slackThreadFollowing` config toggle (Behaviours page) and force-disabled
	 * by the `CYRUS_SLACK_THREAD_FOLLOWING_DISABLED` env kill-switch, which takes
	 * precedence over the toggle. When disabled, only @mentions are processed.
	 */
	private isSlackThreadFollowingEnabled(): boolean {
		const envValue = (process.env.CYRUS_SLACK_THREAD_FOLLOWING_DISABLED ?? "")
			.toLowerCase()
			.trim();
		if (envValue === "true" || envValue === "1" || envValue === "yes") {
			return false;
		}
		// Config toggle defaults to enabled when unset.
		return this.config.slackThreadFollowing !== false;
	}

	/**
	 * Register the Slack event transport for receiving forwarded Slack webhooks from CYHOST.
	 * This creates a /slack-webhook endpoint that handles @mention events from Slack.
	 */
	private registerSlackEventTransport(): void {
		// Live provider reads from the repository map on demand — no snapshot needed
		const chatRepositoryProvider = new LiveChatRepositoryProvider(
			this.repositories,
			() => this.config.linearWorkspaces || {},
		);

		const routingContext =
			this.promptBuilder.generateRoutingContextForAllWorkspaces();
		// Only managed teams (cloud or self-hosted, paired with cyrus-hosted)
		// have a Behaviours page where automatic Slack thread listening can be
		// turned off — CYRUS_API_KEY is proof of that pairing, so the
		// stop-listening prompt guidance is gated on it. Community members
		// don't have the key (or the page).
		const cyrusAppBaseUrl = process.env.CYRUS_API_KEY
			? getCyrusAppUrl()
			: undefined;
		const slackAdapter = new SlackChatAdapter(
			chatRepositoryProvider,
			this.logger,
			{ repositoryRoutingContext: routingContext, cyrusAppBaseUrl },
		);

		if (
			!chatRepositoryProvider.getDefaultLinearWorkspaceId() ||
			!chatRepositoryProvider.getDefaultRepository()
		) {
			this.logger.warn(
				"No repositories or workspaces configured — Slack sessions will not have access to MCP tools",
			);
		}

		this.chatSessionHandler = new ChatSessionHandler(
			slackAdapter,
			{
				cyrusHome: this.cyrusHome,
				chatRepositoryProvider,
				runnerConfigBuilder: this.runnerConfigBuilder,
				createRunner: (config) => {
					const runnerType = this.runnerSelectionService.getDefaultRunner();
					// PON-139: chat sessions run in the default Linear workspace and
					// must carry its declared credential like any other session. The
					// first wiring missed this path entirely — buildChatConfig never
					// touches auth, and this callback constructed the runner on the
					// box's ambient env. Confirmed by the adversarial review: a
					// keyed default workspace's chat session would have billed the
					// wrong tenant, and an undeclared one would never have been
					// refused. Throws on undeclared, which fails the chat session
					// loudly instead of borrowing.
					let chatAuthEnv: Record<string, string | undefined> | undefined;
					if (runnerType === "claude") {
						chatAuthEnv = this.resolveAuthEnvForWorkspace(
							chatRepositoryProvider.getDefaultLinearWorkspaceId(),
							this.logger,
						);
					}
					return this.createRunnerForType(runnerType, {
						...config,
						...(chatAuthEnv
							? {
									additionalEnv: {
										...(
											config as {
												additionalEnv?: Record<string, string | undefined>;
											}
										).additionalEnv,
										...chatAuthEnv,
									},
								}
							: {}),
						model: this.getDefaultModelForRunner(runnerType),
						fallbackModel:
							runnerType === "claude"
								? undefined
								: this.getDefaultFallbackModelForRunner(runnerType), // PON-110
					});
				},
				// Live read so hot-reloaded config (`setConfig`) picks up new
				// per-platform MCP paths without rebuilding the handler.
				getPlatformMcpConfigOverrides: () => this.config.slackMcpConfigs,
				resolveSkillsConfig: async ({ repository, repositoryPaths }) => {
					const plugins = await this.skillsPluginResolver.resolve();
					const skills = await this.skillsPluginResolver.discoverSkillNames(
						plugins,
						{
							repositoryId: repository?.id,
							repoPaths: repositoryPaths,
						},
					);
					return { plugins, skills };
				},
				onWebhookStart: () => {
					this.activeWebhookCount++;
				},
				onWebhookEnd: () => {
					this.activeWebhookCount--;
				},
				onStateChange: () => this.savePersistedState(),
				onClaudeError: (error) => this.handleClaudeError(error),
			},
			this.logger,
		);

		// Use direct Slack signature verification only when BOTH:
		// 1. SLACK_SIGNING_SECRET is set (we have the secret to verify)
		// 2. CYRUS_HOST_EXTERNAL is true (self-hosted: Slack sends directly to us)
		// On cloud droplets, CYHOST forwards webhooks with Bearer token auth
		// (it verifies the Slack signature itself and doesn't forward the headers).
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasSlackSigningSecret =
			process.env.SLACK_SIGNING_SECRET != null &&
			process.env.SLACK_SIGNING_SECRET !== "";
		const useDirectSlackWebhooks = isExternalHost && hasSlackSigningSecret;

		const slackVerificationMode = useDirectSlackWebhooks ? "direct" : "proxy";
		const slackSecret = useDirectSlackWebhooks
			? process.env.SLACK_SIGNING_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.slackEventTransport = new SlackEventTransport({
			fastifyServer: this.sharedApplicationServer.getFastifyInstance(),
			verificationMode: slackVerificationMode,
			secret: slackSecret,
			// Live read so the per-team toggle (hot-reloaded via config) and the
			// env kill-switch both take effect without rebuilding the transport.
			isThreadFollowingEnabled: () => this.isSlackThreadFollowingEnabled(),
		});

		this.slackEventTransport.on("event", (event: SlackWebhookEvent) => {
			this.chatSessionHandler!.handleEvent(event).catch((error) => {
				this.logger.error(
					"Failed to handle Slack webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});
		this.slackEventTransport.on("message", (message: InternalMessage) => {
			this.handleMessage(message);
		});
		this.slackEventTransport.on("error", (error: Error) => {
			this.handleError(error);
		});

		this.slackEventTransport.register();

		this.logger.info(
			`Slack event transport registered (${slackVerificationMode} mode)`,
		);
	}

	/**
	 * Handle a GitHub webhook event (forwarded from CYHOST).
	 *
	 * This creates a new session for the GitHub PR comment, checks out the PR branch
	 * via git worktree, and processes the comment as a task prompt.
	 */
	/**
	 * Resolve a GitHub API token from (in priority order):
	 * 1. Forwarded installation token from CYHOST (cloud/proxy mode)
	 * 2. Self-minted installation token from GitHub App credentials (self-hosted)
	 * 3. Personal access token from GITHUB_TOKEN env var (fallback)
	 */
	private async resolveGitHubToken(
		event: GitHubWebhookEvent,
	): Promise<string | undefined> {
		if (event.installationToken) return event.installationToken;

		// PON-143: resolve the installation from the repository this event is
		// about, not from a process-wide id. A single configured installation
		// could only ever be right for one tenant — for any other repository it
		// did not fail, it minted a perfectly valid token scoped to the wrong
		// org, and nothing errored because nothing was wrong with the token.
		if (this.gitHubInstallationResolver) {
			const ref = {
				owner: extractRepoOwner(event),
				repo: extractRepoName(event),
			};

			// The resolution key comes from the payload, so it is only safe when
			// the payload's origin is verified. Signature mode checks the source
			// IP against GitHub's ranges and then HMAC-SHA256 over the body; proxy
			// mode checks only a bearer token. A forged event naming another
			// tenant's repository must never be able to direct a token mint, so
			// event-derived resolution is gated on the stronger mode.
			if (!this.gitHubWebhooksAreSignatureVerified()) {
				this.logger.warn(
					`Refusing to resolve a GitHub App installation from an unverified payload for ${ref.owner}/${ref.repo}. ` +
						"Set GITHUB_WEBHOOK_SECRET to enable signature verification (PON-143).",
				);
				return this.legacyGitHubToken("unverified-payload", ref);
			}

			try {
				return await this.gitHubInstallationResolver.mintTokenForRef(
					ref,
					"github-api",
				);
			} catch (error) {
				// Deliberately not falling back to another installation. A repo we
				// cannot resolve is a repo we have no business acting on: serving
				// it with a different tenant's credential is worse than refusing.
				this.logger.error(
					`No usable GitHub App installation for ${ref.owner}/${ref.repo}`,
					error instanceof Error ? error : new Error(String(error)),
				);
				return undefined;
			}
		}

		return this.legacyGitHubToken("no-app-configured");
	}

	/**
	 * The legacy `GITHUB_TOKEN` tier, which survives only for installs that
	 * predate the GitHub App.
	 *
	 * It is a **single ambient credential with no tenant scope** — exactly the
	 * shape this workstream exists to remove. It is tolerable today only because
	 * it is unset on both boxes and the App is created with webhooks off, so
	 * nothing reaches it. That is a property of the current deployment, not of
	 * the code, and properties of deployments change quietly.
	 *
	 * So it announces itself whenever it is actually used. A PAT must never
	 * silently serve a tenant request: if this line appears in a journal, some
	 * request was served with a credential that has no idea which client it
	 * belongs to, and that is worth finding out about from a log rather than
	 * from a bill.
	 */
	private legacyGitHubToken(
		reason: string,
		ref?: { owner: string; repo: string },
	): string | undefined {
		const token = process.env.GITHUB_TOKEN;
		if (token) {
			// Two lines, deliberately. The event is the grep target that pairs
			// with `github_token_minted` — asking "which credential served this
			// request" must be one search, not a reading exercise (PON-176). The
			// warn is the prose that says what to do about it, and it forwards at
			// WARN severity, which the event does not.
			journalAmbientTokenFallback(
				reason,
				{ ref, operation: "github-api" },
				this.logger,
			);
			this.logger.warn(
				`Falling back to the ambient GITHUB_TOKEN (reason: ${reason}` +
					`${ref ? `, repo: ${ref.owner}/${ref.repo}` : ""}). ` +
					"This credential has no tenant scope — configure a GitHub App installation covering this repository (PON-143).",
			);
		}
		return token;
	}

	/**
	 * Whether inbound GitHub webhooks are origin-verified (PON-143).
	 *
	 * Signature mode = source-IP allowlist plus HMAC over the body. Proxy mode
	 * only checks a bearer token, which is not a statement about who *sent* the
	 * payload, so its contents must not steer credential selection.
	 */
	private gitHubWebhooksAreSignatureVerified(): boolean {
		return Boolean(process.env.GITHUB_WEBHOOK_SECRET);
	}

	private async handleGitHubWebhook(
		event: GitHubCommentWebhookEvent,
	): Promise<void> {
		this.activeWebhookCount++;

		try {
			// Only handle comments on pull requests
			if (!isCommentOnPullRequest(event)) {
				this.logger.debug("Ignoring GitHub comment on non-PR issue");
				return;
			}

			const repoFullName = extractRepoFullName(event);
			const prNumber = extractPRNumber(event);
			const commentBody = extractCommentBody(event);
			const commentAuthor = extractCommentAuthor(event);
			const prTitle = extractPRTitle(event);
			const sessionKey = extractSessionKey(event);

			const isPullRequestReview = isPullRequestReviewPayload(event.payload);

			// Skip comments from the bot itself to prevent infinite loops
			const botUsername = process.env.GITHUB_BOT_USERNAME;
			if (botUsername && commentAuthor === botUsername) {
				this.logger.debug(
					`Ignoring comment from bot user @${botUsername} on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review events, defensively check review state
			// (must happen before the mention check — reviews don't contain @mentions)
			if (isPullRequestReviewPayload(event.payload)) {
				if (event.payload.review.state !== "changes_requested") {
					this.logger.debug(
						`Ignoring pull_request_review with state: ${event.payload.review.state}`,
					);
					return;
				}
			}

			// Honor the PR-review trigger toggle: when disabled, ignore
			// pull_request_review events entirely — no acknowledgement comment and
			// no agent session. Defaults to enabled when the flag is unset.
			if (isPullRequestReview && this.config.prReviewTrigger === false) {
				this.logger.debug(
					`PR review trigger is disabled, ignoring pull_request_review on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// Only trigger on comments that mention the bot (when configured)
			// Skip this check for pull_request_review events — reviews don't @mention the bot
			if (
				!isPullRequestReview &&
				botUsername &&
				!commentBody.includes(`@${botUsername}`)
			) {
				this.logger.debug(
					`Ignoring comment without @${botUsername} mention on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(
				`Processing GitHub webhook: ${repoFullName}#${prNumber} by @${commentAuthor}${isPullRequestReview ? " (pull_request_review)" : ""}`,
			);

			// Add "eyes" reaction to acknowledge receipt (not for pull_request_review — we post a comment instead)
			const reactionToken = await this.resolveGitHubToken(event);
			if (reactionToken && !isPullRequestReview) {
				const commentId = extractCommentId(event);
				if (commentId) {
					this.gitHubCommentService
						.addReaction({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							commentId,
							isPullRequestReviewComment: isPullRequestReviewCommentPayload(
								event.payload,
							),
							content: "eyes",
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to add reaction: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
			}

			// Find the repository configuration that matches this GitHub repo
			const repository = this.findRepositoryByGitHubUrl(repoFullName);
			if (!repository) {
				this.logger.warn(
					`No repository configured for GitHub repo: ${repoFullName}`,
				);

				// Only reply on signals where the user clearly directed something at us:
				// an explicit @-mention, or a pull_request_review requesting changes.
				const wasMentioned =
					!!botUsername && commentBody.includes(`@${botUsername}`);
				const shouldReply = wasMentioned || isPullRequestReview;

				if (shouldReply && reactionToken && prNumber) {
					// Presence of CYRUS_API_KEY indicates this worker is paired with the
					// managed control plane (paid customer). Absence means the worker is
					// running on the Community plan (self-managed config.json).
					const isManagedCustomer = !!process.env.CYRUS_API_KEY;

					const commonPreamble = [
						`Cyrus received this webhook but has no repository configured for \`${repoFullName}\`, so no agent session was started.`,
						``,
						`**Likely causes:**`,
						`- The owner/org was **renamed or transferred** on GitHub. Webhooks are delivered under the current owner name, but Cyrus's stored repository URL still points at the old one. GitHub's web redirects don't apply to webhook payloads — the stored URL has to be updated explicitly.`,
						`- The stored repository URL has a typo (e.g. wrong org/owner) and doesn't match the repo this event came from.`,
						`- The GitHub App / webhook is installed on a repo Cyrus isn't configured for at all.`,
						``,
					];

					const fix = isManagedCustomer
						? `**What to do:** there's currently no self-serve way to update the stored repository URL on your plan — please reach out to Cyrus support and reference \`${repoFullName}\` and we'll reconcile it on the backend.`
						: `**What to do:** open \`~/.cyrus/config.json\` on the worker and update the \`githubUrl\` of the relevant repository to \`https://github.com/${repoFullName}\`. The worker watches the config file and will pick up the change automatically. If this repo shouldn't be sending events to Cyrus at all, remove the GitHub App from it instead.`;

					this.gitHubCommentService
						.postIssueComment({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							issueNumber: prNumber,
							body: [...commonPreamble, fix].join("\n"),
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to post unconfigured-repo notice: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
				return;
			}

			const agentSessionManager = this.agentSessionManager;

			// For pull_request_review events, post an instant acknowledgement comment
			if (isPullRequestReview && reactionToken && prNumber) {
				this.gitHubCommentService
					.postIssueComment({
						token: reactionToken,
						owner: extractRepoOwner(event),
						repo: extractRepoName(event),
						issueNumber: prNumber,
						body: "Received your change request. Getting started on those changes now.",
					})
					.catch((err: unknown) => {
						this.logger.warn(
							`Failed to post acknowledgement comment: ${err instanceof Error ? err.message : err}`,
						);
					});
			}

			// Determine the PR head branch and base branch
			let branchRef = extractPRBranchRef(event);
			let baseBranchRef = extractPRBaseBranchRef(event);

			// For issue_comment events, the branch refs are not in the payload
			// We need to fetch them from the GitHub API
			if (!branchRef && isIssueCommentPayload(event.payload)) {
				const refs = await this.fetchPRBranchRefs(event, repository);
				branchRef = refs?.headRef ?? null;
				baseBranchRef = refs?.baseRef ?? null;
			}

			if (!branchRef || !prNumber) {
				this.logger.error(
					`Could not determine branch or PR number for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review, the review body IS the task context (no mention to strip)
			// For other events, strip the bot mention to get the task instructions
			const mentionHandle = botUsername ? `@${botUsername}` : "@cyrusagent";
			const taskInstructions = isPullRequestReview
				? commentBody ||
					"A reviewer has requested changes on this PR. Read the review comments to understand what needs to be changed."
				: stripMention(commentBody, mentionHandle);

			// Check for an existing multi-repo session that includes this repository.
			// If found, use its sub-worktree instead of creating a new workspace.
			let workspace: { path: string; isGitWorktree: boolean } | null = null;
			const multiRepoSession =
				agentSessionManager.getActiveMultiRepoSessionForRepository(
					repository.id,
				);

			if (multiRepoSession) {
				const subWorktreePath =
					multiRepoSession.workspace.repoPaths?.[repository.id];
				if (subWorktreePath) {
					workspace = { path: subWorktreePath, isGitWorktree: true };
					this.logger.info(
						`Resolved multi-repo sub-worktree for ${repository.name}: ${subWorktreePath}`,
					);
				} else {
					this.logger.warn(
						`No sub-worktree found for repo ${repository.name} in multi-repo session ${multiRepoSession.id}, falling back to root workspace`,
					);
					workspace = {
						path: multiRepoSession.workspace.path,
						isGitWorktree: true,
					};
				}
			} else {
				// Single-repo or no existing session: create workspace as before
				workspace = await this.createGitHubWorkspace(
					repository,
					branchRef,
					prNumber,
				);
			}

			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(`GitHub workspace created at: ${workspace.path}`);

			// Check if another active session is already using this branch/workspace
			const existingSessions =
				agentSessionManager.getActiveSessionsByBranchName(branchRef);
			const firstExisting = existingSessions[0];
			if (firstExisting) {
				this.logger.warn(
					`Reusing workspace from active session ${firstExisting.id} — concurrent writes possible`,
				);
			}

			// Create a synthetic session for this GitHub PR comment
			const issueMinimal: IssueMinimal = {
				id: sessionKey,
				identifier: `${extractRepoName(event)}#${prNumber}`,
				title: prTitle || `PR #${prNumber}`,
				branchName: branchRef,
			};

			// Create an internal agent session (no Linear session for GitHub)
			const githubSessionId = `github-${event.deliveryId}`;
			agentSessionManager.createCyrusAgentSession(
				githubSessionId,
				sessionKey,
				issueMinimal,
				workspace,
				"github", // Don't stream activities to Linear for GitHub sources
				[
					{
						repositoryId: repository.id,
						branchName: branchRef,
						baseBranchName: baseBranchRef ?? repository.baseBranch,
					},
				],
			);

			// Register session-to-repo mapping and activity sink
			this.sessionRepositories.set(githubSessionId, repository.id);
			const activitySink = this.getActivitySinkForRepo(repository.id);
			if (activitySink) {
				agentSessionManager.setActivitySink(githubSessionId, activitySink);
			}

			const session = agentSessionManager.getSession(githubSessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for GitHub webhook ${event.deliveryId}`,
				);
				return;
			}

			// Initialize session metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Store GitHub-specific metadata for reply posting
			session.metadata.commentId = String(extractCommentId(event));

			// Build the system prompt for this GitHub PR session
			const systemPrompt = isPullRequestReview
				? this.buildGitHubChangeRequestSystemPrompt(
						event,
						branchRef,
						taskInstructions,
					)
				: this.buildGitHubSystemPrompt(event, branchRef, taskInstructions);

			// Build allowed tools using the GitHub platform resolver, which honors
			// `githubAllowedTools` on the workspace config and falls back to
			// `GITHUB_DEFAULT_ALLOWED_TOOLS` (which intentionally omits
			// `mcp__slack` — no subtractive filtering needed).
			const allowedTools =
				this.toolPermissionResolver.buildGithubAllowedTools(repository);
			const disallowedTools = this.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					repository,
					githubSessionId,
					systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					undefined, // labels
					undefined, // issueDescription
					200, // maxTurns
					undefined, // linearWorkspaceId
					this.buildSkillSessionContext(repository, undefined, session),
					"github", // sessionPlatform → uses githubMcpConfigs override
				);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store the runner in the session manager
			agentSessionManager.addAgentRunner(githubSessionId, runner);

			// Save persisted state
			await this.savePersistedState();

			this.emit(
				"session:started",
				sessionKey,
				issueMinimal as unknown as Issue,
				repository.id,
			);

			this.logger.info(
				`Starting ${runnerType} runner for GitHub PR ${repoFullName}#${prNumber}`,
			);

			// Start the session and handle completion
			try {
				const sessionInfo = await runner.start(taskInstructions);
				this.logger.info(`GitHub session started: ${sessionInfo.sessionId}`);

				// When session completes, post the reply back to GitHub
				await this.postGitHubReply(event, runner, repository);
			} catch (error) {
				this.logger.error(
					`GitHub session error for ${repoFullName}#${prNumber}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				await this.savePersistedState();
			}
		} catch (error) {
			this.logger.error(
				"Failed to process GitHub webhook",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.activeWebhookCount--;
		}
	}

	/**
	 * Handle GitHub push webhook events.
	 * When a base branch receives new commits, find active sessions tracking that
	 * branch and stream a rebase notification to the running agent.
	 */
	private async handleGitHubPushWebhook(
		payload: GitHubPushPayload,
	): Promise<void> {
		// Only handle branch pushes (refs/heads/*), not tags
		if (!payload.ref.startsWith("refs/heads/")) {
			return;
		}

		// Ignore branch deletions
		if (payload.deleted) {
			return;
		}

		const branchName = payload.ref.replace("refs/heads/", "");
		const repoFullName = payload.repository.full_name;

		// Find the matching repository config
		const repository = this.findRepositoryByGitHubUrl(repoFullName);
		if (!repository) {
			this.logger.debug(
				`No repository configured for GitHub push from ${repoFullName}`,
			);
			return;
		}

		// Find active sessions tracking this branch as their base branch
		const sessions = this.agentSessionManager.getSessionsByBaseBranch(
			branchName,
			repository.id,
		);

		if (sessions.length === 0) {
			this.logger.debug(
				`No active sessions tracking base branch ${branchName} for ${repository.name}`,
			);
			return;
		}

		// Build a notification prompt with commit summary
		const commitCount = payload.commits.length;
		const commitSummary = payload.commits
			.slice(0, 5)
			.map((c) => `- ${c.message.split("\n")[0]}`)
			.join("\n");
		const moreCommits =
			commitCount > 5 ? `\n- ... and ${commitCount - 5} more` : "";

		const notification = `<base_branch_update>
<branch>${branchName}</branch>
<repository>${repoFullName}</repository>
<commit_count>${commitCount}</commit_count>
<compare_url>${payload.compare}</compare_url>
<commits>
${commitSummary}${moreCommits}
</commits>
<guidance>
Your base branch \`${branchName}\` has received ${commitCount} new commit(s). Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/${branchName}\`
</guidance>
</base_branch_update>`;

		this.logger.info(
			`Base branch ${branchName} updated (${commitCount} commits) — notifying ${sessions.length} active session(s)`,
		);

		// Stream notification to the first running session that supports streaming
		const sortedSessions = [...sessions].sort(
			(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);

		for (const session of sortedSessions) {
			const existingRunner = session.agentRunner;
			const isRunning = existingRunner?.isRunning() || false;

			if (
				isRunning &&
				existingRunner?.supportsStreamingInput &&
				existingRunner.addStreamMessage
			) {
				// Best-effort notification; a steer-only backend may reject it if no
				// turn is active. Don't let that throw out of the update handler.
				try {
					existingRunner.addStreamMessage(notification);
					this.logger.debug(
						`[base-branch-update] Streamed notification to session ${session.id} for branch ${branchName}`,
					);
					break;
				} catch (error) {
					this.logger.debug(
						`[base-branch-update] Stream rejected for session ${session.id}; skipping`,
						{ error: error instanceof Error ? error.message : String(error) },
					);
				}
			}
		}
	}

	/**
	 * Find a repository configuration that matches a GitHub repository URL.
	 * Matches against the githubUrl field in repository config.
	 */
	private findRepositoryByGitHubUrl(
		repoFullName: string,
	): RepositoryConfig | null {
		for (const repo of this.repositories.values()) {
			if (!repo.githubUrl) continue;
			// Match against full name (owner/repo) or URL containing it
			if (
				repo.githubUrl.includes(repoFullName) ||
				repo.githubUrl.endsWith(`/${repoFullName}`)
			) {
				return repo;
			}
		}
		return null;
	}

	/**
	 * Fetch the PR head and base branch refs for an issue_comment webhook.
	 * For issue_comment events, the branch refs are not in the payload
	 * and must be fetched from the GitHub API.
	 */
	private async fetchPRBranchRefs(
		event: GitHubCommentWebhookEvent,
		_repository: RepositoryConfig,
	): Promise<{ headRef: string; baseRef: string } | null> {
		if (!isIssueCommentPayload(event.payload)) return null;

		const prUrl = event.payload.issue.pull_request?.url;
		if (!prUrl) return null;

		try {
			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = event.payload.issue.number;

			const headers: Record<string, string> = {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			};

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveGitHubToken(event);
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}

			const response = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
				{ headers },
			);

			if (!response.ok) {
				this.logger.warn(
					`Failed to fetch PR details from GitHub API: ${response.status}`,
				);
				return null;
			}

			const prData = (await response.json()) as {
				head?: { ref?: string };
				base?: { ref?: string };
			};
			const headRef = prData.head?.ref;
			const baseRef = prData.base?.ref;
			if (!headRef) return null;
			return { headRef, baseRef: baseRef ?? "" };
		} catch (error) {
			this.logger.error(
				"Failed to fetch PR branch refs",
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Create a git worktree for a GitHub PR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	private async createGitHubWorkspace(
		repository: RepositoryConfig,
		branchRef: string,
		prNumber: number,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			// Use the GitService to create the worktree
			// Create a synthetic issue-like object for the git service
			const syntheticIssue = {
				id: `github-pr-${prNumber}`,
				identifier: `PR-${prNumber}`,
				title: `PR #${prNumber}`,
				description: null,
				url: "",
				branchName: branchRef,
				assigneeId: null,
				stateId: null,
				teamId: null,
				labelIds: [],
				priority: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: null,
				state: Promise.resolve(undefined),
				assignee: Promise.resolve(undefined),
				team: Promise.resolve(undefined),
				parent: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: () => Promise.resolve({ nodes: [] }),
				comments: () => Promise.resolve({ nodes: [] }),
				attachments: () => Promise.resolve({ nodes: [] }),
				children: () => Promise.resolve({ nodes: [] }),
				inverseRelations: () => Promise.resolve({ nodes: [] }),
				update: () =>
					Promise.resolve({
						success: true,
						issue: undefined,
						lastSyncId: 0,
					}),
			} as unknown as Issue;

			return await this.gitService.createGitWorktree(syntheticIssue, [
				repository,
			]);
		} catch (error) {
			this.logger.error(
				`Failed to create GitHub workspace for PR #${prNumber}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a system prompt for a GitHub PR comment session.
	 */
	private buildGitHubSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		taskInstructions: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		return `You are working on a GitHub Pull Request.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${commentAuthor}
- **Comment URL**: ${commentUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the PR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Be concise in your responses as they will be posted back to the GitHub PR`;
	}

	/**
	 * Build a system prompt for a GitHub PR change request review session.
	 */
	private buildGitHubChangeRequestSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		reviewBody: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the PR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`gh api repos/${repoFullName}/pulls/${prNumber}/reviews\` to read the review comments and understand what changes are needed
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${commentAuthor}
- **Review URL**: ${commentUrl}

${taskSection}`;
	}

	/**
	 * Post a reply back to the GitHub PR comment after the session completes.
	 */
	private async postGitHubReply(
		event: GitHubCommentWebhookEvent,
		runner: IAgentRunner,
		_repository: RepositoryConfig,
	): Promise<void> {
		try {
			// Get the last assistant message from the runner as the summary
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed. Please review the changes on this branch.";
			if (
				lastAssistantMessage &&
				lastAssistantMessage.type === "assistant" &&
				"message" in lastAssistantMessage
			) {
				const msg = lastAssistantMessage as {
					message: { content: Array<{ type: string; text?: string }> };
				};
				const textBlock = msg.message.content?.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.text) {
					summary = textBlock.text;
				}
			}

			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = extractPRNumber(event);
			const commentId = extractCommentId(event);

			if (!prNumber) {
				this.logger.warn("Cannot post GitHub reply: no PR number");
				return;
			}

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveGitHubToken(event);
			if (!token) {
				this.logger.warn(
					"Cannot post GitHub reply: no installation token or GITHUB_TOKEN configured",
				);
				this.logger.debug(
					`Would have posted reply to ${owner}/${repo}#${prNumber} (comment ${commentId}): ${summary}`,
				);
				return;
			}

			if (event.eventType === "pull_request_review_comment") {
				// Reply to the specific review comment thread
				await this.gitHubCommentService.postReviewCommentReply({
					token,
					owner,
					repo,
					pullNumber: prNumber,
					commentId,
					body: summary,
				});
			} else {
				// Post as a regular issue comment on the PR
				await this.gitHubCommentService.postIssueComment({
					token,
					owner,
					repo,
					issueNumber: prNumber,
					body: summary,
				});
			}

			this.logger.info(`Posted GitHub reply to ${owner}/${repo}#${prNumber}`);
		} catch (error) {
			this.logger.error(
				"Failed to post GitHub reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Handle an incoming GitLab webhook event (note on a merge request).
	 * Mirrors the GitHub webhook handler but uses GitLab-specific utilities.
	 */
	private async handleGitLabWebhook(event: GitLabWebhookEvent): Promise<void> {
		this.activeWebhookCount++;

		try {
			// Only handle notes on merge requests
			if (!isNoteOnMergeRequest(event)) {
				this.logger.debug(
					"Ignoring GitLab event: not a note on a merge request",
				);
				return;
			}

			const projectPath = extractProjectPath(event);
			const mrIid = extractMRIid(event);
			const noteBody = extractNoteBody(event);
			const noteAuthor = extractNoteAuthor(event);
			const mrTitle = extractMRTitle(event);
			const sessionKey = extractGitLabSessionKey(event);

			// Skip comments from the bot itself to prevent infinite loops
			const botUsername = process.env.GITLAB_BOT_USERNAME;
			if (botUsername && noteAuthor === botUsername) {
				this.logger.debug(
					`Ignoring note from bot user @${botUsername} on ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Only trigger on notes that mention the bot (when configured)
			if (botUsername && !noteBody.includes(`@${botUsername}`)) {
				this.logger.debug(
					`Ignoring note without @${botUsername} mention on ${projectPath}!${mrIid}`,
				);
				return;
			}

			this.logger.info(
				`Processing GitLab webhook: ${projectPath}!${mrIid} by @${noteAuthor}`,
			);

			// Add "eyes" emoji reaction to acknowledge receipt
			const reactionToken =
				event.accessToken || process.env.GITLAB_ACCESS_TOKEN;
			const noteId = extractNoteId(event);
			const projectId = extractProjectId(event);
			if (reactionToken && noteId && projectId && mrIid) {
				this.gitLabCommentService
					.addAwardEmoji({
						token: reactionToken,
						projectId,
						mrIid,
						noteId,
						name: "eyes",
					})
					.catch((err: unknown) => {
						this.logger.warn(
							`Failed to add GitLab emoji reaction: ${err instanceof Error ? err.message : err}`,
						);
					});
			}

			// Find the repository configuration that matches this GitLab project
			const repository = this.findRepositoryByGitLabUrl(projectPath);
			if (!repository) {
				this.logger.warn(
					`No repository configured for GitLab project: ${projectPath}`,
				);
				return;
			}

			const agentSessionManager = this.agentSessionManager;

			// Branch refs are available directly from the MR payload
			const branchRef = extractMRBranchRef(event);
			const baseBranchRef = extractMRBaseBranchRef(event);

			if (!branchRef || !mrIid) {
				this.logger.error(
					`Could not determine branch or MR iid for ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Strip the bot mention to get the task instructions
			const mentionHandle = botUsername ? `@${botUsername}` : "@cyrusagent";
			const taskInstructions = stripGitLabMention(noteBody, mentionHandle);

			// Check for an existing multi-repo session that includes this repository
			let workspace: { path: string; isGitWorktree: boolean } | null = null;
			const multiRepoSession =
				agentSessionManager.getActiveMultiRepoSessionForRepository(
					repository.id,
				);

			if (multiRepoSession) {
				const subWorktreePath =
					multiRepoSession.workspace.repoPaths?.[repository.id];
				if (subWorktreePath) {
					workspace = {
						path: subWorktreePath,
						isGitWorktree: true,
					};
					this.logger.info(
						`Resolved multi-repo sub-worktree for ${repository.name}: ${subWorktreePath}`,
					);
				} else {
					this.logger.warn(
						`No sub-worktree found for repo ${repository.name} in multi-repo session ${multiRepoSession.id}, falling back to root workspace`,
					);
					workspace = {
						path: multiRepoSession.workspace.path,
						isGitWorktree: true,
					};
				}
			} else {
				// Single-repo or no existing session: create workspace
				workspace = await this.createGitLabWorkspace(
					repository,
					branchRef,
					mrIid,
				);
			}

			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${projectPath}!${mrIid}`,
				);
				return;
			}

			this.logger.info(`GitLab workspace created at: ${workspace.path}`);

			// Check if another active session is already using this branch/workspace
			const existingSessions =
				agentSessionManager.getActiveSessionsByBranchName(branchRef);
			const firstExisting = existingSessions[0];
			if (firstExisting) {
				this.logger.warn(
					`Reusing workspace from active session ${firstExisting.id} — concurrent writes possible`,
				);
			}

			// Create a synthetic session for this GitLab MR note
			const issueMinimal: IssueMinimal = {
				id: sessionKey,
				identifier: `${projectPath}!${mrIid}`,
				title: mrTitle || `MR !${mrIid}`,
				branchName: branchRef,
			};

			// Create an internal agent session (no Linear session for GitLab)
			const gitlabSessionId = `gitlab-${Date.now()}`;
			agentSessionManager.createCyrusAgentSession(
				gitlabSessionId,
				sessionKey,
				issueMinimal,
				workspace,
				"gitlab", // Don't stream activities to Linear for GitLab sources
				[
					{
						repositoryId: repository.id,
						branchName: branchRef,
						baseBranchName: baseBranchRef ?? repository.baseBranch,
					},
				],
			);

			// Register session-to-repo mapping and activity sink
			this.sessionRepositories.set(gitlabSessionId, repository.id);
			const activitySink = this.getActivitySinkForRepo(repository.id);
			if (activitySink) {
				agentSessionManager.setActivitySink(gitlabSessionId, activitySink);
			}

			const session = agentSessionManager.getSession(gitlabSessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for GitLab webhook on ${projectPath}!${mrIid}`,
				);
				return;
			}

			// Initialize procedure metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Store GitLab-specific metadata for reply posting
			// Reuse commentId for note ID (serves the same purpose across platforms)
			session.metadata.commentId = String(noteId);

			// Build the system prompt for this GitLab MR session
			// TODO: Use buildGitLabChangeRequestSystemPrompt for merge_request approval events
			const isMergeRequestEvent = event.eventType === "merge_request";
			const systemPrompt = isMergeRequestEvent
				? this.buildGitLabChangeRequestSystemPrompt(
						event,
						branchRef,
						taskInstructions,
					)
				: this.buildGitLabSystemPrompt(event, branchRef, taskInstructions);

			// Build allowed tools using the GitHub platform resolver — GitLab and
			// GitHub share the same PR-targeted, single-repo intent, so they use
			// the same `githubAllowedTools` knob and the same `GITHUB_*` default.
			const allowedTools =
				this.toolPermissionResolver.buildGithubAllowedTools(repository);
			const disallowedTools = this.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					repository,
					gitlabSessionId,
					systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					undefined, // labels
					undefined, // issueDescription
					200, // maxTurns
					undefined, // linearWorkspaceId
					this.buildSkillSessionContext(repository, undefined, session),
					"gitlab", // sessionPlatform → uses githubMcpConfigs override
				);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store the runner in the session manager
			agentSessionManager.addAgentRunner(gitlabSessionId, runner);

			// Save persisted state
			await this.savePersistedState();

			this.emit(
				"session:started",
				sessionKey,
				issueMinimal as unknown as Issue,
				repository.id,
			);

			this.logger.info(
				`Starting ${runnerType} runner for GitLab MR ${projectPath}!${mrIid}`,
			);

			// Start the session and handle completion
			try {
				const sessionInfo = await runner.start(taskInstructions);
				this.logger.info(`GitLab session started: ${sessionInfo.sessionId}`);

				// When session completes, post the reply back to GitLab
				await this.postGitLabReply(event, runner, repository);
			} catch (error) {
				this.logger.error(
					`GitLab session error for ${projectPath}!${mrIid}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				await this.savePersistedState();
			}
		} catch (error) {
			this.logger.error(
				"Failed to process GitLab webhook",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.activeWebhookCount--;
		}
	}

	/**
	 * Find a repository configuration that matches a GitLab project URL.
	 * Matches against the gitlabUrl field in repository config.
	 */
	private findRepositoryByGitLabUrl(
		projectPath: string,
	): RepositoryConfig | null {
		for (const repo of this.repositories.values()) {
			if (!repo.gitlabUrl) continue;
			if (
				repo.gitlabUrl.includes(projectPath) ||
				repo.gitlabUrl.endsWith(`/${projectPath}`)
			) {
				return repo;
			}
		}
		return null;
	}

	/**
	 * Create a git worktree for a GitLab MR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	private async createGitLabWorkspace(
		repository: RepositoryConfig,
		branchRef: string,
		mrIid: number,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			// Create a synthetic issue-like object for the git service
			const syntheticIssue = {
				id: `gitlab-mr-${mrIid}`,
				identifier: `MR-${mrIid}`,
				title: `MR !${mrIid}`,
				description: null,
				url: "",
				branchName: branchRef,
				assigneeId: null,
				stateId: null,
				teamId: null,
				labelIds: [],
				priority: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: null,
				state: Promise.resolve(undefined),
				assignee: Promise.resolve(undefined),
				team: Promise.resolve(undefined),
				parent: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: () => Promise.resolve({ nodes: [] }),
				comments: () => Promise.resolve({ nodes: [] }),
				attachments: () => Promise.resolve({ nodes: [] }),
				children: () => Promise.resolve({ nodes: [] }),
				inverseRelations: () => Promise.resolve({ nodes: [] }),
				update: () =>
					Promise.resolve({
						success: true,
						issue: undefined,
						lastSyncId: 0,
					}),
			} as unknown as Issue;

			return await this.gitService.createGitWorktree(syntheticIssue, [
				repository,
			]);
		} catch (error) {
			this.logger.error(
				`Failed to create GitLab workspace for MR !${mrIid}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a system prompt for a GitLab MR note session.
	 */
	private buildGitLabSystemPrompt(
		event: GitLabWebhookEvent,
		branchRef: string,
		taskInstructions: string,
	): string {
		const projectPath = extractProjectPath(event);
		const mrIid = extractMRIid(event);
		const mrTitle = extractMRTitle(event);
		const noteAuthor = extractNoteAuthor(event);
		const noteUrl = extractNoteUrl(event);

		return `You are working on a GitLab Merge Request.

## Context
- **Project**: ${projectPath}
- **MR**: !${mrIid} - ${mrTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${noteAuthor}
- **Note URL**: ${noteUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the MR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Use \`glab\` CLI commands for GitLab-specific operations
- Be concise in your responses as they will be posted back to the GitLab MR`;
	}

	/**
	 * Build a system prompt for a GitLab MR change request session.
	 */
	private buildGitLabChangeRequestSystemPrompt(
		event: GitLabWebhookEvent,
		branchRef: string,
		reviewBody: string,
	): string {
		const projectPath = extractProjectPath(event);
		const mrIid = extractMRIid(event);
		const mrTitle = extractMRTitle(event);
		const noteAuthor = extractNoteAuthor(event);
		const noteUrl = extractNoteUrl(event);

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the MR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the MR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`glab mr view ${mrIid}\` and \`glab mr diff ${mrIid}\` to review the MR context
- You are already checked out on the MR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitLab Merge Request that has received a change request review.

## Context
- **Project**: ${projectPath}
- **MR**: !${mrIid} - ${mrTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${noteAuthor}
- **Note URL**: ${noteUrl}

${taskSection}`;
	}

	/**
	 * Post a reply back to the GitLab MR after the session completes.
	 */
	private async postGitLabReply(
		event: GitLabWebhookEvent,
		runner: IAgentRunner,
		_repository: RepositoryConfig,
	): Promise<void> {
		try {
			// Get the last assistant message from the runner as the summary
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed. Please review the changes on this branch.";
			if (
				lastAssistantMessage &&
				lastAssistantMessage.type === "assistant" &&
				"message" in lastAssistantMessage
			) {
				const msg = lastAssistantMessage as {
					message: {
						content: Array<{ type: string; text?: string }>;
					};
				};
				const textBlock = msg.message.content?.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.text) {
					summary = textBlock.text;
				}
			}

			const projectId = extractProjectId(event);
			const mrIid = extractMRIid(event);
			const discussionId = extractDiscussionId(event);

			if (!mrIid) {
				this.logger.warn("Cannot post GitLab reply: no MR iid");
				return;
			}

			const token = event.accessToken || process.env.GITLAB_ACCESS_TOKEN;
			if (!token) {
				this.logger.warn(
					"Cannot post GitLab reply: no access token or GITLAB_ACCESS_TOKEN configured",
				);
				this.logger.debug(
					`Would have posted reply to ${extractProjectPath(event)}!${mrIid}: ${summary}`,
				);
				return;
			}

			if (discussionId) {
				// Reply to the specific discussion thread
				await this.gitLabCommentService.postDiscussionReply({
					token,
					projectId,
					mrIid,
					discussionId,
					body: summary,
				});
			} else {
				// Post as a top-level MR note
				await this.gitLabCommentService.postMRNote({
					token,
					projectId,
					mrIid,
					body: summary,
				});
			}

			this.logger.info(
				`Posted GitLab reply to ${extractProjectPath(event)}!${mrIid}`,
			);
		} catch (error) {
			this.logger.error(
				"Failed to post GitLab reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Compute the current status of the Cyrus process
	 * @returns "idle" if the process can be safely restarted, "busy" if work is in progress
	 */
	private computeStatus(): "idle" | "busy" {
		// Busy if any webhooks are currently being processed
		if (this.activeWebhookCount > 0) {
			return "busy";
		}

		// Busy if any runner is actively running
		const runners = this.agentSessionManager.getAllAgentRunners();
		for (const runner of runners) {
			if (runner.isRunning()) {
				return "busy";
			}
		}

		// Busy if any chat platform runner is actively running
		if (this.chatSessionHandler?.isAnyRunnerBusy()) {
			return "busy";
		}

		return "idle";
	}

	/**
	 * Test-only: dispatch a synthetic Slack webhook event through the chat
	 * session handler. Used by the F1 test harness to exercise the Slack →
	 * ClaudeRunner code path end-to-end without a real Slack signature.
	 */
	async dispatchChatTestEvent(event: SlackWebhookEvent): Promise<void> {
		if (!this.chatSessionHandler) {
			throw new Error("chatSessionHandler not initialized");
		}
		await this.chatSessionHandler.handleEvent(event);
	}

	/**
	 * Public accessor for the shared Fastify-based application server.
	 * Used by F1 to register test-only routes alongside production webhook routes.
	 */
	getSharedApplicationServer(): SharedApplicationServer {
		return this.sharedApplicationServer;
	}

	/**
	 * Test-only: list active chat threads (threadKey → sessionId).
	 */
	listChatThreads(): Array<{ threadKey: string; sessionId: string }> {
		if (!this.chatSessionHandler) return [];
		return this.chatSessionHandler.listThreads();
	}

	/**
	 * Test-only: fetch the last assistant text reply for a chat thread.
	 * Returns null when the thread or runner is unknown, or no assistant
	 * message has been produced yet.
	 */
	getChatThreadLastReply(threadKey: string): {
		text: string;
		isRunning: boolean;
		messageCount: number;
	} | null {
		if (!this.chatSessionHandler) return null;
		const runner = this.chatSessionHandler.getRunnerForThread(threadKey);
		if (!runner) return null;
		const messages = runner.getMessages();
		const lastAssistant = [...messages]
			.reverse()
			.find((m) => m.type === "assistant");
		let text = "";
		if (
			lastAssistant &&
			lastAssistant.type === "assistant" &&
			"message" in lastAssistant
		) {
			const msg = lastAssistant as {
				message: { content: Array<{ type: string; text?: string }> };
			};
			const block = msg.message.content?.find(
				(b) => b.type === "text" && b.text,
			);
			if (block?.text) text = block.text;
		}
		return {
			text,
			isRunning: runner.isRunning(),
			messageCount: messages.length,
		};
	}

	/**
	 * Stop the edge worker
	 */
	async stop(): Promise<void> {
		// Stop config file watcher
		await this.configManager.stop();

		if (this.workspaceLivenessTimer) {
			clearInterval(this.workspaceLivenessTimer);
			this.workspaceLivenessTimer = undefined;
		}

		if (this.mirrorRefreshTimer) {
			clearInterval(this.mirrorRefreshTimer);
			this.mirrorRefreshTimer = undefined;
		}

		// Cancel pending lane grace timers (PON-112); state is persisted below
		// and recovery re-arms on next boot.
		for (const timer of this.laneGraceTimers.values()) {
			clearTimeout(timer);
		}
		this.laneGraceTimers.clear();

		try {
			await this.savePersistedState();
			this.logger.info("✅ EdgeWorker state saved successfully");
		} catch (error) {
			this.logger.error(
				"❌ Failed to save EdgeWorker state during shutdown:",
				error,
			);
		}

		// get all agent runners (including chat platform sessions)
		const agentRunners: IAgentRunner[] = [
			...this.agentSessionManager.getAllAgentRunners(),
		];
		if (this.chatSessionHandler) {
			agentRunners.push(...this.chatSessionHandler.getAllRunners());
		}

		// Kill all agent processes with null checking
		for (const runner of agentRunners) {
			if (runner) {
				try {
					runner.stop();
				} catch (error) {
					this.logger.error("Error stopping Claude runner:", error);
				}
			}
		}

		// Clear event transport (no explicit cleanup needed, routes are removed when server stops)
		this.linearEventTransport = null;
		this.configUpdater = null;
		this.mcpConfigService.clearAllContexts();
		this.cyrusToolsMcpSessions.removeAllListeners();
		this.cyrusToolsMcpRegistered = false;

		// Stop egress proxy
		if (this.egressProxy) {
			await this.egressProxy.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}

		// Stop shared application server (this also stops Cloudflare tunnel if running)
		await this.sharedApplicationServer.stop();
	}

	/**
	 * Apply sandbox config changes from a config reload.
	 * Handles three transitions:
	 * - enabled → enabled: update network policy on the running proxy
	 * - disabled → enabled: start a new proxy
	 * - enabled → disabled: stop the running proxy
	 */
	private async applySandboxConfigChanges(
		newConfig: EdgeWorkerConfig,
	): Promise<void> {
		const wasEnabled = this.egressProxy !== null;
		const isEnabled = newConfig.sandbox?.enabled === true;

		if (wasEnabled && isEnabled) {
			// Policy update — proxy stays running, rules change
			// Pass current policy (or empty object to reset to allow-all)
			this.egressProxy!.updateNetworkPolicy(
				newConfig.sandbox?.networkPolicy ?? {},
			);
			// Handle systemWideCert toggling while proxy is running
			if (newConfig.sandbox?.systemWideCert) {
				this.egressCaCertPath = null;
			} else if (!this.egressCaCertPath) {
				this.egressCaCertPath = this.egressProxy!.buildCACertBundle();
			}
		} else if (!wasEnabled && isEnabled) {
			// Start proxy for the first time
			this.logger.info("🛡️  Sandbox egress proxy: starting (config change)...");
			this.egressProxy = new EgressProxy(
				newConfig.sandbox!,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};
			const systemWideCert = newConfig.sandbox?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else if (wasEnabled && !isEnabled) {
			// Stop proxy
			this.logger.info(
				"🛡️  Sandbox egress proxy: stopping (disabled in config)",
			);
			await this.egressProxy!.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}
	}

	/**
	 * Log instructions for trusting the egress proxy CA certificate.
	 * When systemWideCert is true, logs that env vars are skipped and trust
	 * is expected from the OS cert store. Otherwise logs env var list and
	 * checks macOS keychain trust status.
	 */
	private logCertTrustInstructions(
		certPath: string,
		systemWideCert = false,
	): void {
		this.logger.info(`🛡️  Sandbox TLS interception CA certificate: ${certPath}`);

		if (systemWideCert) {
			this.logger.info(
				"🛡️  systemWideCert: true — per-session CA cert env vars are skipped (OS cert store handles trust)",
			);
		} else {
			this.logger.info(
				"🛡️  Per-session env vars are set automatically: NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, SSL_CERT_FILE, REQUESTS_CA_BUNDLE, PIP_CERT, CURL_CA_BUNDLE, CARGO_HTTP_CAINFO, AWS_CA_BUNDLE, DENO_CERT",
			);
		}

		const trusted = this.isCertTrustedSystemWide();
		if (trusted) {
			this.logger.info("🛡️  CA certificate is trusted system-wide ✓");
			if (!systemWideCert) {
				this.logger.info(
					"🛡️  Tip: set sandbox.systemWideCert: true in config.json to skip per-session cert env vars",
				);
			}
		} else {
			if (process.platform === "darwin") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted in the macOS System keychain. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certPath}`,
				);
			} else if (process.platform === "linux") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted system-wide. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo cp ${certPath} /usr/local/share/ca-certificates/cyrus-egress-ca.crt && sudo update-ca-certificates`,
				);
			}
			if (systemWideCert) {
				this.logger.warn(
					"🛡️  systemWideCert is true but cert is not trusted — tools using the OS cert store will fail TLS verification",
				);
			}
		}
	}

	/**
	 * Check whether the Cyrus egress proxy CA is trusted at the OS level.
	 * macOS: searches the System keychain. Linux: checks update-ca-certificates output.
	 */
	private isCertTrustedSystemWide(): boolean {
		try {
			if (process.platform === "darwin") {
				execSync(
					'security find-certificate -c "Cyrus Egress Proxy CA" /Library/Keychains/System.keychain',
					{ stdio: "ignore" },
				);
				return true;
			}
			if (process.platform === "linux") {
				// Check if our cert exists in the system CA certificates directory
				execSync(
					"test -f /usr/local/share/ca-certificates/cyrus-egress-ca.crt",
					{ stdio: "ignore" },
				);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Set the config file path for dynamic reloading
	 */
	setConfigPath(configPath: string): void {
		this.configPath = configPath;
		this.configManager.setConfigPath(configPath);
	}

	/**
	 * Handle resuming a parent session when a child session completes
	 * This is the core logic used by the resume parent session callback
	 * Extracted to reduce duplication between constructor and addNewRepositories
	 */
	private async handleResumeParentSession(
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	): Promise<void> {
		const log = this.logger.withContext({ sessionId: parentSessionId });
		log.info(
			`Child session completed, resuming parent session ${parentSessionId}`,
		);

		// Find parent session from the single session manager
		log.debug(`Looking up parent session ${parentSessionId}`);
		const parentSession = this.agentSessionManager.getSession(parentSessionId);
		const parentRepoId = this.sessionRepositories.get(parentSessionId);
		const parentRepo = parentRepoId
			? this.repositories.get(parentRepoId)
			: undefined;
		const parentAgentSessionManager = this.agentSessionManager;

		if (!parentSession || !parentRepo) {
			log.error(
				`Parent session ${parentSessionId} not found in any repository's agent session manager`,
			);
			return;
		}

		// Extract workspace ID once for all operations in this method
		const parentWorkspaceId = requireLinearWorkspaceId(parentRepo);

		log.debug(
			`Found parent session - Issue: ${parentSession.issueId}, Workspace: ${parentSession.workspace.path}`,
		);

		// Get the child session to access its workspace path
		const childSession = this.agentSessionManager.getSession(childSessionId);
		const childWorkspaceDirs: string[] = [];
		if (childSession) {
			childWorkspaceDirs.push(childSession.workspace.path);
			log.debug(
				`Adding child workspace to parent allowed directories: ${childSession.workspace.path}`,
			);
		} else {
			log.warn(
				`Could not find child session ${childSessionId} to add workspace to parent allowed directories`,
			);
		}

		await this.postParentResumeAcknowledgment(
			parentSessionId,
			parentWorkspaceId,
		);

		// Post thought showing child result receipt
		// Use parent's issue tracker since we're posting to the parent's session
		const issueTracker = this.issueTrackers.get(parentWorkspaceId);
		if (issueTracker && childSession) {
			const childIssueIdentifier =
				childSession.issue?.identifier || childSession.issueId;
			const resultThought = `Received result from sub-issue ${childIssueIdentifier}:\n\n---\n\n${prompt}\n\n---`;

			await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId: parentSessionId,
					content: { type: "thought", body: resultThought },
				},
				"child result receipt",
				"narration",
			);
		}

		// Use centralized streaming check and routing logic
		log.info(`Handling child result for parent session ${parentSessionId}`);
		try {
			await this.handlePromptWithStreamingCheck(
				parentSession,
				parentRepo,
				parentSessionId,
				parentAgentSessionManager,
				prompt,
				"", // No attachment manifest for child results
				false, // Not a new session
				childWorkspaceDirs, // Add child workspace directories to parent's allowed directories
				"parent resume from child",
				parentWorkspaceId,
			);
			log.info(
				`Successfully handled child result for parent session ${parentSessionId}`,
			);
		} catch (error) {
			log.error(`Failed to resume parent session ${parentSessionId}:`, error);
			log.error(
				`Error context - Parent issue: ${parentSession.issueId}, Repository: ${parentRepo.name}`,
			);
		}
	}

	/**
	 * Detect workspace token changes and update all dependent services.
	 *
	 * When an OAuth token is refreshed (at least once per day), the new token is
	 * persisted to config.json which triggers the file watcher.  This method
	 * compares the previous in-memory tokens against the new config and calls
	 * `setAccessToken()` on any affected `LinearIssueTrackerService` instances,
	 * and pushes the updated workspace configs to `AttachmentService`.
	 */
	private updateLinearWorkspaceTokens(newConfig: EdgeWorkerConfig): void {
		const oldWorkspaces = this.config.linearWorkspaces ?? {};
		const newWorkspaces = newConfig.linearWorkspaces ?? {};

		let anyTokenChanged = false;

		for (const [workspaceId, newWsConfig] of Object.entries(newWorkspaces)) {
			const oldToken = oldWorkspaces[workspaceId]?.linearToken;
			const newToken = newWsConfig.linearToken;

			if (oldToken === newToken) continue;

			anyTokenChanged = true;

			// Update existing issue tracker in-place
			const issueTracker = this.issueTrackers.get(workspaceId);
			if (issueTracker) {
				(issueTracker as LinearIssueTrackerService).setAccessToken(newToken);
				this.logger.info(
					`🔑 Updated Linear token for workspace ${workspaceId}`,
				);
			} else if (this.config.platform !== "cli") {
				// Workspace is new — create a tracker and activity sink for it
				const newIssueTracker = new LinearIssueTrackerService(
					new LinearClient({ accessToken: newToken }),
					this.buildOAuthConfig(workspaceId),
				);
				this.issueTrackers.set(workspaceId, newIssueTracker);
				this.activitySinks.set(
					workspaceId,
					new LinearActivitySink(newIssueTracker, workspaceId),
				);
				this.logger.info(
					`🔑 Created issue tracker for new workspace ${workspaceId}`,
				);
			}
		}

		if (anyTokenChanged) {
			// Push refreshed workspace configs to AttachmentService
			this.attachmentService.setLinearWorkspaces(newWorkspaces);
		}
	}

	/**
	 * Add new repositories to the running EdgeWorker
	 */
	private async addNewRepositories(repos: RepositoryConfig[]): Promise<void> {
		for (const repo of repos) {
			if (repo.isActive === false) {
				this.logger.info(`⏭️  Skipping inactive repository: ${repo.name}`);
				continue;
			}

			try {
				this.logger.info(`➕ Adding repository: ${repo.name} (${repo.id})`);

				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				// Add to internal map
				this.repositories.set(repo.id, resolvedRepo);

				this.logger.info(`✅ Repository added successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(`❌ Failed to add repository ${repo.name}:`, error);
			}
		}
	}

	/**
	 * Update existing repositories
	 */
	private async updateModifiedRepositories(
		repos: RepositoryConfig[],
	): Promise<void> {
		for (const repo of repos) {
			try {
				const oldRepo = this.repositories.get(repo.id);
				if (!oldRepo) {
					this.logger.warn(
						`⚠️  Repository ${repo.id} not found for update, skipping`,
					);
					continue;
				}

				this.logger.info(`🔄 Updating repository: ${repo.name} (${repo.id})`);

				// Resolve paths that may contain tilde (~) prefix
				const resolvedRepo: RepositoryConfig = {
					...repo,
					repositoryPath: resolvePath(repo.repositoryPath),
					workspaceBaseDir: resolvePath(repo.workspaceBaseDir),
					mcpConfigPath: Array.isArray(repo.mcpConfigPath)
						? repo.mcpConfigPath.map(resolvePath)
						: repo.mcpConfigPath
							? resolvePath(repo.mcpConfigPath)
							: undefined,
					promptTemplatePath: repo.promptTemplatePath
						? resolvePath(repo.promptTemplatePath)
						: undefined,
				};

				// Update stored config
				this.repositories.set(repo.id, resolvedRepo);

				// If active status changed
				if (oldRepo.isActive !== repo.isActive) {
					if (repo.isActive === false) {
						this.logger.info(
							`  ⏸️  Repository set to inactive - existing sessions will continue`,
						);
					} else {
						this.logger.info(`  ▶️  Repository reactivated`);
					}
				}

				this.logger.info(`✅ Repository updated successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(
					`❌ Failed to update repository ${repo.name}:`,
					error,
				);
			}
		}
	}

	/**
	 * Remove deleted repositories
	 */
	private async removeDeletedRepositories(
		repos: RepositoryConfig[],
	): Promise<void> {
		for (const repo of repos) {
			try {
				this.logger.info(`🗑️  Removing repository: ${repo.name} (${repo.id})`);

				// Check for active sessions for this repository
				const allActiveSessions = this.agentSessionManager.getActiveSessions();
				const activeSessions = allActiveSessions.filter(
					(s) => this.sessionRepositories.get(s.id) === repo.id,
				);

				if (activeSessions.length > 0) {
					this.logger.warn(
						`  ⚠️  Repository has ${activeSessions.length} active sessions - stopping them`,
					);

					// Stop all active sessions and notify Linear
					for (const session of activeSessions) {
						try {
							this.logger.debug(
								`  🛑 Stopping session for issue ${session.issueId}`,
							);

							// Get the agent runner for this session
							const runner = this.agentSessionManager.getAgentRunner(
								session.id,
							);
							if (runner) {
								// Stop the agent process
								runner.stop();
								this.logger.debug(
									`  ✅ Stopped Claude runner for session ${session.id}`,
								);
							}

							// Post cancellation message to tracker
							const issueTracker = this.issueTrackers.get(
								requireLinearWorkspaceId(repo),
							);
							if (issueTracker && session.externalSessionId) {
								await this.postActivityDirect(
									issueTracker,
									{
										agentSessionId: session.externalSessionId,
										content: {
											type: "response",
											body: `**Repository Removed from Configuration**\n\nThis repository (\`${repo.name}\`) has been removed from the Cyrus configuration. All active sessions for this repository have been stopped.\n\nIf you need to continue working on this issue, please contact your administrator to restore the repository configuration.`,
										},
									},
									"repository removal",
									"sanctioned",
								);
							}
						} catch (error) {
							this.logger.error(
								`  ❌ Failed to stop session ${session.id}:`,
								error,
							);
						}
					}
				}

				// Remove repository from the repositories map.
				// Note: we intentionally do NOT remove workspace-level issue trackers
				// or activity sinks here. They are keyed by workspace ID and may be
				// needed by other repositories in the same workspace, or by new
				// repositories about to be added in the same configChanged cycle.
				// They will be naturally replaced when workspace tokens are updated.
				this.repositories.delete(repo.id);

				this.logger.info(`✅ Repository removed successfully: ${repo.name}`);
			} catch (error) {
				this.logger.error(
					`❌ Failed to remove repository ${repo.name}:`,
					error,
				);
			}
		}
	}

	/**
	 * Handle errors
	 */
	private handleError(error: Error): void {
		this.emit("error", error);
		this.config.handlers?.onError?.(error);
	}

	/**
	 * Get cached repositories for an issue (used by agentSessionPrompted Branch 3)
	 * Returns null if nothing cached, or array of resolved RepositoryConfigs.
	 */
	private getCachedRepositories(issueId: string): RepositoryConfig[] | null {
		return this.repositoryRouter.getCachedRepositories(
			issueId,
			this.repositories,
		);
	}

	/**
	 * Get first cached repository for an issue (convenience for single-repo callers)
	 */
	private getCachedRepository(issueId: string): RepositoryConfig | null {
		const repos = this.getCachedRepositories(issueId);
		return repos && repos.length > 0 ? repos[0]! : null;
	}

	/**
	 * Handle webhook events from proxy - main router for all webhooks
	 */
	private async handleWebhook(
		webhook: Webhook,
		repos: RepositoryConfig[],
	): Promise<void> {
		// Track active webhook processing for status endpoint
		this.activeWebhookCount++;

		const webhookAction = (webhook as { action?: string }).action;
		const webhookType = (webhook as { type?: string }).type;
		this.logger.event("webhook_received", {
			source: "linear",
			action: webhookAction,
			type: webhookType,
			repoCount: repos.length,
		});

		// Log verbose webhook info if enabled
		if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
			this.logger.debug(
				`Full webhook payload:`,
				JSON.stringify(webhook, null, 2),
			);
		}

		try {
			// PON-112 hardening: with a public OAuth app, any workspace that
			// installs it delivers webhooks here. Agent-session events for
			// workspaces we do not serve are dropped as an ASSERTED property —
			// not left to routing's workspace filter, which a refactor could
			// quietly undo. Nothing is posted, started, or billed for them.
			if (webhookType === "AgentSessionEvent") {
				const organizationId = (webhook as { organizationId?: string })
					.organizationId;
				if (!this.isKnownWorkspace(organizationId)) {
					this.logger.event("webhook_unknown_workspace", {
						action: webhookAction,
						organizationId: organizationId ?? "missing",
					});
					return;
				}
			}

			// Route to specific webhook handlers based on webhook type
			// NOTE: Traditional webhooks (assigned, comment) are disabled in favor of agent session events
			if (isPermissionChangeWebhook(webhook)) {
				await this.handlePermissionChange(webhook);
			} else if (isIssueAssignedWebhook(webhook)) {
				// PON-200: NOT a no-op. Linear creates an AgentSession on the
				// FIRST delegation only; re-delegating after an unassign sends
				// this notification and nothing else, so the issue went silent
				// forever. Observed live on ACM-10.
				await this.handleIssueAssignedWebhook(webhook);
			} else if (isIssueCommentMentionWebhook(webhook)) {
				return;
			} else if (isIssueNewCommentWebhook(webhook)) {
				return;
			} else if (isIssueUnassignedWebhook(webhook)) {
				// Keep unassigned webhook active
				await this.handleIssueUnassignedWebhook(webhook);
			} else if (isAgentSessionCreatedWebhook(webhook)) {
				await this.handleAgentSessionCreatedWebhook(webhook, repos);
			} else if (isAgentSessionPromptedWebhook(webhook)) {
				await this.handleUserPromptedAgentActivity(webhook);
			} else if (isIssueStateChangeWebhook(webhook)) {
				// Intentional early return: state changes are handled exclusively via the message bus
				// (handleIssueStateChangeMessage), not the legacy webhook path. This differs from
				// unassign which still uses the legacy handler — state change was built message-bus-first.
				return;
			} else if (isIssueDeletedWebhook(webhook)) {
				// Issue deletion also handled via message bus — same cleanup as terminal state.
				return;
			} else if (isIssueTitleOrDescriptionUpdateWebhook(webhook)) {
				// Handle issue title/description/attachments updates - feed changes into active session
				await this.handleIssueContentUpdate(webhook);
			} else if (isIssueStateIdUpdateWebhook(webhook)) {
				// Handle issue state changes — wake up parked sessions when blocking issues complete
				await this.handleIssueStateChange(webhook);
			} else {
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					this.logger.debug(
						`Unhandled webhook type: ${(webhook as any).action}`,
					);
				}
			}
		} catch (error) {
			this.logger.error(
				`Failed to process webhook: ${(webhook as any).action}`,
				error,
			);
			// Don't re-throw webhook processing errors to prevent application crashes
			// The error has been logged and individual webhook failures shouldn't crash the entire system
		} finally {
			// Always decrement counter when webhook processing completes
			this.activeWebhookCount--;
		}
	}

	// ============================================================================
	// INTERNAL MESSAGE BUS HANDLERS
	// ============================================================================
	// These handlers process unified InternalMessage types from the message bus.
	// They provide a platform-agnostic interface for handling events from
	// Linear, GitHub, Slack, and other platforms.
	// ============================================================================

	/**
	 * Handle unified internal messages from the message bus.
	 * This is the new entry point for processing events from all platforms.
	 *
	 * Note: For now, this runs in parallel with legacy webhook handlers.
	 * Once migration is complete, legacy handlers will be removed.
	 */
	private async handleMessage(message: InternalMessage): Promise<void> {
		// NOTE: activeWebhookCount is NOT tracked here because legacy webhook handlers
		// already increment/decrement it for every event. Counting here would double-count.
		// TODO: When legacy handlers are removed, restore activeWebhookCount tracking here.

		// Log verbose message info if enabled
		if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
			this.logger.debug(
				`Internal message received: ${message.source}/${message.action}`,
				JSON.stringify(message, null, 2),
			);
		}

		try {
			// Route to specific message handlers based on action type
			if (isSessionStartMessage(message)) {
				await this.handleSessionStartMessage(message);
			} else if (isUserPromptMessage(message)) {
				await this.handleUserPromptMessage(message);
			} else if (isStopSignalMessage(message)) {
				await this.handleStopSignalMessage(message);
			} else if (isContentUpdateMessage(message)) {
				await this.handleContentUpdateMessage(message);
			} else if (isUnassignMessage(message)) {
				await this.handleUnassignMessage(message);
			} else if (isIssueStateChangeMessage(message)) {
				await this.handleIssueStateChangeMessage(message);
			} else {
				// This branch should never be reached due to exhaustive type checking
				// If it is reached, log the unexpected message for debugging
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					const unexpectedMessage = message as InternalMessage;
					this.logger.debug(
						`Unhandled message action: ${unexpectedMessage.action}`,
					);
				}
			}
		} catch (error) {
			this.logger.error(
				`Failed to process message: ${message.source}/${message.action}`,
				error,
			);
			// Don't re-throw message processing errors to prevent application crashes
		}
	}

	/**
	 * Handle session start message (unified handler for session creation).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleAgentSessionCreatedWebhook and handleGitHubWebhook.
	 */
	private async handleSessionStartMessage(
		message: SessionStartMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Session start: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified session start handling
		// For now, the legacy handlers (handleAgentSessionCreatedWebhook, handleGitHubWebhook)
		// continue to process the actual session creation via the 'event' emitter.
	}

	/**
	 * Handle user prompt message (unified handler for mid-session prompts).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleUserPromptedAgentActivity (branch 3).
	 */
	private async handleUserPromptMessage(
		message: UserPromptMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] User prompt: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified user prompt handling
		// For now, the legacy handler (handleUserPromptedAgentActivity)
		// continues to process the actual prompt via the 'event' emitter.
	}

	/**
	 * Handle stop signal message (unified handler for session termination).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleUserPromptedAgentActivity (branch 1).
	 */
	private async handleStopSignalMessage(
		message: StopSignalMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Stop signal: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified stop signal handling
		// For now, the legacy handler (handleUserPromptedAgentActivity)
		// continues to process the actual stop via the 'event' emitter.
	}

	/**
	 * Handle content update message (unified handler for issue/PR content changes).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleIssueContentUpdate.
	 */
	private async handleContentUpdateMessage(
		message: ContentUpdateMessage,
	): Promise<void> {
		this.logger.debug(
			`[MessageBus] Content update: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified content update handling
		// For now, the legacy handler (handleIssueContentUpdate)
		// continues to process the actual update via the 'event' emitter.
	}

	/**
	 * Handle unassign message (unified handler for task unassignment).
	 *
	 * This is a placeholder that logs the message for now.
	 * TODO: Migrate logic from handleIssueUnassignedWebhook.
	 */
	private async handleUnassignMessage(message: UnassignMessage): Promise<void> {
		this.logger.debug(
			`[MessageBus] Unassign: ${message.workItemIdentifier} from ${message.source}`,
		);
		// TODO: Implement unified unassign handling
		// For now, the legacy handler (handleIssueUnassignedWebhook)
		// continues to process the actual unassignment via the 'event' emitter.
	}

	/**
	 * Handle issue state change message (terminal state reached).
	 * Stops active sessions and deletes worktrees for the issue.
	 */
	private async handleIssueStateChangeMessage(
		message: IssueStateChangeMessage,
	): Promise<void> {
		this.logger.info(
			`[MessageBus] Issue reached terminal state: ${message.workItemIdentifier}`,
		);

		const issueId = message.workItemId;

		// Stop all active sessions for this issue
		const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
		for (const session of sessions) {
			this.logger.info(
				`Stopping agent runner for ${message.workItemIdentifier} (issue terminal)`,
			);
			this.agentSessionManager.requestSessionStop(session.id);
			session.agentRunner?.stop();
		}

		// Post a response activity to each stopped session's Linear thread,
		// then remove the session so subsequent prompts don't find stale state.
		for (const session of sessions) {
			// PON-235: not when we closed it ourselves. A client who has just
			// been told "Merged — this is now part of your project" does not
			// then need "Session stopped — FRO-64 was marked as Done or
			// Canceled": it is our vocabulary, on their thread, immediately
			// after a polished close-out. Observed live on the first
			// merge-closes-the-loop run.
			if (!this.selfCompletedIssues.has(issueId)) {
				await this.agentSessionManager.createResponseActivity(
					session.id,
					`Session stopped — ${message.workItemIdentifier} was marked as Done or Canceled.`,
				);
			}
			this.agentSessionManager.removeSession(session.id);
		}

		// Scope-gate cleanup (PON-150): a terminal issue's gate record is done
		// — remove it so the pending list stays honest. Unassignment does NOT
		// clear it: the approval belongs to the issue, and a re-delegated
		// issue whose scope was approved must not re-ask.
		// Needs-info (PON-172): same lifecycle — a terminal issue's wait is
		// over regardless of whether an answer ever came.
		const needsInfoRemoved = this.needsInfo.remove(issueId);
		if (this.scopeApprovals.remove(issueId) || needsInfoRemoved) {
			await this.persistScopeApprovals("issue_terminal");
		}
		// Operator sessions (PON-208): same lifecycle. Left behind, the link
		// would keep granting its exemptions — loud, ungated, unheld — to a
		// session id on an issue that is over.
		this.operatorSessions.releaseForClientIssue(issueId);

		// Cockpit (PON-151): a terminal client issue closes its mirror.
		void this.cockpitMirror.close(issueId, "issue_terminal");
		// The issue is over: its preview links stop opening (v3.1).
		const revokedLinks = this.previewLinks.revokeForIssue(issueId);
		if (revokedLinks > 0) {
			this.logger.event("preview_links_revoked", {
				issueId,
				count: revokedLinks,
			});
		}

		// Verification gate (PON-152): a terminal issue's record is done.
		if (this.verificationGate.remove(issueId)) {
			await this.persistScopeApprovals("verification_issue_terminal");
		}
		for (const session of sessions) {
			this.mentionSessionIds.delete(session.id);
		}

		// Lane cleanup (PON-112): release the lane if a stopped session held
		// it, and drop queued sessions of this issue from their lane queue.
		for (const session of sessions) {
			await this.cleanupLaneForSession(session.id);
		}
		for (const queuedSessionId of this.laneManager.queuedSessionIdsForIssue(
			issueId,
		)) {
			await this.cleanupLaneForSession(queuedSessionId);
		}

		// Build the set of repositories involved with this issue so per-repo
		// cyrus-teardown.sh scripts (if present) can run before worktrees are
		// removed. Source-of-truth is the session manager: each session's
		// repositoryId maps to a configured RepositoryConfig.
		const repoIds = new Set<string>();
		for (const session of sessions) {
			const repoId = this.sessionRepositories.get(session.id);
			if (repoId) repoIds.add(repoId);
		}
		const teardownRepositories: RepositoryConfig[] = [];
		for (const repoId of repoIds) {
			const repo = this.repositories.get(repoId);
			if (repo) teardownRepositories.push(repo);
		}

		// Delete worktrees for this issue, keyed by the Linear issue identifier.
		await this.gitService.deleteWorktree(message.workItemIdentifier, {
			repositories: teardownRepositories,
		});

		this.logger.info(
			`Completed cleanup for ${message.workItemIdentifier}: stopped ${sessions.length} session(s)`,
		);
	}

	// ============================================================================
	// LEGACY WEBHOOK HANDLERS
	// ============================================================================

	/**
	 * Handle issue unassignment webhook
	 */
	/**
	 * The agent was assigned (or re-delegated) to an issue (PON-200).
	 *
	 * Linear creates an AgentSession by itself on the FIRST delegation, and the
	 * dispatch treated this notification as redundant for exactly that reason.
	 * It is not redundant on a RE-delegation: an issue that already carries a
	 * session gets the notification and no session, so a client who unassigns
	 * and re-assigns — to pause, to retry, or by accident — gets silence with
	 * no visible cause and no way to recover on that issue. Observed live on
	 * ACM-10, where the client abandoned the issue and opened another.
	 *
	 * So this waits out the window in which Linear would have created the
	 * session itself, and creates one only if none appeared. The wait is what
	 * keeps the first delegation from racing into two sessions.
	 */
	private async handleIssueAssignedWebhook(
		webhook: IssueUnassignedWebhook,
	): Promise<void> {
		const issue = webhook.notification?.issue;
		if (!issue?.id) return;
		const issueId = issue.id;
		const workspaceId = webhook.organizationId;
		if (!workspaceId) return;
		if (this.pendingAssignmentRecoveries.has(issueId)) return;

		const timer = setTimeout(() => {
			this.pendingAssignmentRecoveries.delete(issueId);
			void this.recoverMissingSessionForAssignment(
				issueId,
				issue.identifier,
				workspaceId,
			);
		}, this.assignmentRecoveryDelayMs);
		// Never hold the process open for a recovery check.
		timer.unref?.();
		this.pendingAssignmentRecoveries.set(issueId, timer);
	}

	/**
	 * Create the session Linear did not (PON-200). Runs only when the grace
	 * window closed with no live session for the issue.
	 */
	private async recoverMissingSessionForAssignment(
		issueId: string,
		issueIdentifier: string | undefined,
		workspaceId: string,
	): Promise<void> {
		// v3.1 (requirement A): a cockpit mirror gets exactly ONE implementation
		// thread. A re-delegation of a mirror that already has one is "start
		// again" on that thread, not a reason to open another.
		const mirrorClientIssueId = this.cockpitMirror.clientIssueIdFor(issueId);
		if (mirrorClientIssueId) {
			// A parked mirror whose start was refused by the WIP gate has a
			// birth/narration thread (opened by the delegation, PON-212) but no
			// operator link — that link is only registered once work actually
			// starts (startWorkFromMirror, downstream of the WIP gate). Keying
			// reuse on the link alone let recovery mint a SECOND thread on the
			// mirror: observed on CKP-25, where a WIP-gated delegation was
			// followed 60s later by assignment_session_recovered opening a
			// redundant thread. Reuse whichever thread exists — a mirror gets
			// exactly one, and the WIP-refusal explanation lands on it.
			const link = this.operatorSessions.forClientIssue(mirrorClientIssueId);
			const reuseSessionId =
				link?.mirrorSessionId ??
				this.cockpitMirror.narrationSessionIdFor(mirrorClientIssueId);
			if (reuseSessionId) {
				this.logger.event("mirror_redelegation_reused_thread", {
					issueId,
					issueIdentifier,
					mirrorSessionId: reuseSessionId,
				});
				await this.handleMirrorAction(
					{
						organizationId: workspaceId,
						mirrorSessionId: reuseSessionId,
						rawBody: "",
					},
					mirrorClientIssueId,
				);
				return;
			}
		}
		const live = this.agentSessionManager
			.getSessionsByIssueId(issueId)
			.filter((session) => session.status !== AgentSessionStatus.Complete);
		if (live.length > 0) return;

		// PON-226: "no live session" is not the same as "Linear never made
		// one". A session that DIED also leaves none live — and this recovery,
		// reading only liveness, then opened a second thread on the client's
		// issue. Seen on ACM-20: a session died four seconds in on a billing
		// error, and fifteen seconds later the client had two agent threads
		// for one request, the second as doomed as the first.
		//
		// A thread opened moments ago belongs to THIS delegation whatever
		// became of it, so there is nothing to recover. The window is generous
		// against webhook reordering; the case this exists for — a
		// re-delegation whose notification arrives with no session at all —
		// has no recent thread by definition.
		const seenAt = this.agentSessionSeenAt.get(issueId);
		if (seenAt && Date.now() - seenAt < this.assignmentRecoveryDelayMs * 3) {
			this.logger.event("assignment_recovery_skipped", {
				issueId,
				issueIdentifier,
				workspaceId,
				reason: "session_already_opened_for_this_delegation",
				ageMs: Date.now() - seenAt,
			});
			return;
		}

		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker?.createAgentSessionOnIssue) return;

		try {
			await issueTracker.createAgentSessionOnIssue({ issueId });
			this.logger.event("assignment_session_recovered", {
				issueId,
				issueIdentifier,
				workspaceId,
			});
		} catch (error) {
			// Best-effort: a failure here leaves exactly the behaviour that
			// existed before, so it must never take anything else down.
			this.logger.error(
				`Failed to create a session for re-delegated issue ${issueIdentifier ?? issueId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async handleIssueUnassignedWebhook(
		webhook: IssueUnassignedWebhook,
	): Promise<void> {
		if (!webhook.notification.issue) {
			this.logger.warn("Received issue unassignment webhook without issue");
			return;
		}

		const issueId = webhook.notification.issue.id;

		// Get cached repository, with fallback to searching sessions
		let repository = this.getCachedRepository(issueId);
		if (!repository) {
			// Fallback: search sessions for this issue to find the repository
			this.logger.info(
				`No cached repository for issue unassignment ${webhook.notification.issue.identifier}, searching sessions`,
			);

			const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
			if (sessions.length > 0) {
				const firstSession = sessions[0]!;
				const repoId = this.sessionRepositories.get(firstSession.id);
				if (repoId) {
					repository = this.repositories.get(repoId) ?? null;
					if (repository) {
						this.logger.info(
							`Recovered repository ${repoId} for unassignment of ${webhook.notification.issue.identifier} from session manager`,
						);
					}
				}

				if (!repository) {
					// Sessions exist but no repository mapping — still stop the sessions
					this.logger.warn(
						`Found ${sessions.length} session(s) for unassigned issue ${webhook.notification.issue.identifier} but no repository mapping, stopping sessions without farewell comment`,
					);
					for (const session of sessions) {
						this.agentSessionManager.requestSessionStop(session.id);
						session.agentRunner?.stop();
					}
					return;
				}
			}

			if (!repository) {
				this.logger.debug(
					`No active sessions found for unassigned issue ${webhook.notification.issue.identifier}`,
				);
				return;
			}
		}

		this.logger.info(
			`Handling issue unassignment: ${webhook.notification.issue.identifier}`,
		);

		await this.handleIssueUnassigned(
			webhook.notification.issue,
			webhook.organizationId,
		);
	}

	/**
	 * Handle issue content update webhook (title, description, or attachments).
	 *
	 * When the title, description, or attachments of an issue are updated, this handler feeds
	 * the changes into any active session for that issue, allowing the AI to
	 * compare old vs new values and decide whether to take action.
	 *
	 * The prompt uses XML-style formatting to clearly show what changed:
	 * - <issue_update> wrapper with timestamp and issue identifier
	 * - <title_change> with <old_title> and <new_title> if title changed
	 * - <description_change> with <old_description> and <new_description> if description changed
	 * - <attachments_change> with <old_attachments> and <new_attachments> if attachments changed
	 * - <guidance> section instructing the agent to evaluate whether changes affect its work
	 *
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/EntityWebhookPayload
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/IssueWebhookPayload
	 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/unions/DataWebhookPayload
	 */
	private async handleIssueContentUpdate(
		webhook: IssueUpdateWebhook,
	): Promise<void> {
		// Check if issue update trigger is enabled (defaults to true if not set)
		if (this.config.issueUpdateTrigger === false) {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					"Issue update trigger is disabled, skipping issue content update",
				);
			}
			return;
		}

		const issueData = webhook.data;
		const issueId = issueData.id;
		const issueIdentifier = issueData.identifier;
		const updatedFrom = webhook.updatedFrom;
		const webhookKey = `${webhook.organizationId}:${webhook.createdAt}:${issueId}`;

		if (!updatedFrom) {
			this.logger.warn(
				`Issue update webhook for ${issueIdentifier} has no updatedFrom data`,
			);
			return;
		}

		// Deduplicate: skip if we've already processed a webhook with the same key
		if (this.processedIssueUpdateKeys.has(webhookKey)) {
			this.logger.debug(
				`Duplicate issue update webhook for ${issueIdentifier} (key=${webhookKey}), skipping`,
			);
			return;
		}
		this.processedIssueUpdateKeys.add(webhookKey);
		this.pruneProcessedIssueUpdateKeys();

		// Get cached repository, with fallback to searching sessions
		let repository = this.getCachedRepository(issueId);
		if (!repository) {
			// Fallback: search sessions for this issue to find the repository
			const issueSessions =
				this.agentSessionManager.getSessionsByIssueId(issueId);
			if (issueSessions.length > 0) {
				const firstSession = issueSessions[0]!;
				const repoId = this.sessionRepositories.get(firstSession.id);
				if (repoId) {
					repository = this.repositories.get(repoId) ?? null;
					if (repository) {
						this.logger.info(
							`Recovered repository ${repoId} for issue update ${issueIdentifier} from session manager`,
						);
					}
				}
			}

			if (!repository) {
				this.logger.debug(
					`No active sessions found for issue update ${issueIdentifier}`,
				);
				return;
			}
		}

		// Determine what changed for logging
		const changedFields: string[] = [];
		if ("title" in updatedFrom) changedFields.push("title");
		if ("description" in updatedFrom) changedFields.push("description");
		if ("attachments" in updatedFrom) changedFields.push("attachments");

		this.logger.info(
			`Handling issue content update: ${issueIdentifier} (changed: ${changedFields.join(", ")})`,
		);

		// Find session(s) for this issue
		const sessions = this.agentSessionManager.getSessionsByIssueId(issueId);
		if (sessions.length === 0) {
			if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
				this.logger.debug(
					`No sessions found for issue ${issueIdentifier} to receive update`,
				);
			}
			return;
		}

		// Process attachments from the updated description if description changed
		let attachmentManifest = "";
		if ("description" in updatedFrom && issueData.description) {
			const firstSession = sessions[0];
			if (!firstSession) {
				this.logger.debug(`No sessions found for issue ${issueIdentifier}`);
				return;
			}
			const workspaceFolderName = basename(firstSession.workspace.path);
			const attachmentsDir = getAttachmentsDir(
				this.cyrusHome,
				workspaceFolderName,
				webhook.organizationId,
			);

			try {
				// Ensure directory exists
				await mkdir(attachmentsDir, { recursive: true });

				// Count existing attachments
				const existingFiles = await readdir(attachmentsDir).catch(() => []);
				const existingAttachmentCount = existingFiles.filter(
					(file) => file.startsWith("attachment_") || file.startsWith("image_"),
				).length;

				// Download attachments from the new description
				// Use organizationId from webhook as the Linear-native workspace ID source
				const linearToken = this.getLinearTokenForWorkspace(
					webhook.organizationId,
				);
				const downloadResult = await this.downloadCommentAttachments(
					issueData.description,
					attachmentsDir,
					linearToken,
					existingAttachmentCount,
				);

				if (downloadResult.totalNewAttachments > 0) {
					attachmentManifest =
						this.generateNewAttachmentManifest(downloadResult);
					this.logger.debug(
						`Downloaded ${downloadResult.totalNewAttachments} attachments from updated description`,
					);
				}
			} catch (error) {
				this.logger.error(
					"Failed to process attachments from updated description:",
					error,
				);
			}
		}

		// Build the XML-formatted prompt showing old vs new values
		const promptBody = this.buildIssueUpdatePrompt(
			issueIdentifier,
			issueData,
			updatedFrom,
		);

		// CYPACK-954: Issue update events are ONLY delivered to the first running
		// session (by most-recently-updated) that supports streaming input.
		// If no such session exists, the event is silently ignored.

		// Combine prompt body with attachment manifest
		let fullPrompt = promptBody;
		if (attachmentManifest) {
			fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
		}

		// Sort by updatedAt descending so the most recent session is first
		const sortedSessions = [...sessions].sort(
			(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);

		let delivered = false;
		for (const session of sortedSessions) {
			const sessionId = session.id;
			const existingRunner = session.agentRunner;
			const isRunning = existingRunner?.isRunning() || false;

			if (
				isRunning &&
				existingRunner?.supportsStreamingInput &&
				existingRunner.addStreamMessage
			) {
				// Best-effort; a steer-only backend may reject when no turn is active.
				try {
					existingRunner.addStreamMessage(fullPrompt);
					delivered = true;
					this.logger.debug(
						`[issue-update] Streamed update to session ${sessionId} (key=${webhookKey}, changed=[${changedFields.join(", ")}])`,
					);
					break;
				} catch (error) {
					this.logger.debug(
						`[issue-update] Stream rejected for session ${sessionId}; skipping (key=${webhookKey})`,
						{ error: error instanceof Error ? error.message : String(error) },
					);
				}
			} else if (isRunning) {
				this.logger.debug(
					`[issue-update] Session ${sessionId} is running but doesn't support streaming input, skipping (key=${webhookKey})`,
				);
			} else {
				this.logger.debug(
					`[issue-update] Session ${sessionId} is idle, ignoring update (key=${webhookKey})`,
				);
			}
		}

		if (!delivered) {
			this.logger.debug(
				`[issue-update] No running streaming sessions for ${issueIdentifier}, update discarded (key=${webhookKey})`,
			);
		}
	}

	/**
	 * Build an XML-formatted prompt for issue content updates (title, description, attachments).
	 *
	 * The prompt clearly shows what fields changed by comparing old vs new values,
	 * and includes guidance for the agent to evaluate whether these changes affect
	 * its current implementation or action plan.
	 */
	/**
	 * Check if an issue has unresolved blocked-by dependencies.
	 * Fetches the issue from Linear and checks its inverse relations for blocking issues
	 * that haven't been completed or canceled.
	 */
	private async checkBlockedByDependencies(
		agentSession: AgentSessionCreatedWebhook["agentSession"],
		linearWorkspaceId: string,
	): Promise<{
		blocked: boolean;
		blockingIssueIds: string[];
		blockingIdentifiers: string[];
	}> {
		const issue = agentSession.issue;
		if (!issue) {
			return { blocked: false, blockingIssueIds: [], blockingIdentifiers: [] };
		}

		try {
			const fullIssue = await this.fetchFullIssueDetails(
				issue.id,
				linearWorkspaceId,
			);
			if (!fullIssue) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			const blockingIssues =
				await this.promptBuilder.fetchBlockingIssues(fullIssue);
			if (blockingIssues.length === 0) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			// Filter to only unresolved blockers (not completed or canceled)
			const unresolvedBlockers: Array<{
				id: string;
				identifier: string;
			}> = [];
			for (const blocker of blockingIssues) {
				try {
					const state = await blocker.state;
					if (
						state &&
						state.type !== "completed" &&
						state.type !== "canceled"
					) {
						unresolvedBlockers.push({
							id: blocker.id,
							identifier: blocker.identifier,
						});
					}
				} catch {
					// If we can't resolve the state, assume it's unresolved
					unresolvedBlockers.push({
						id: blocker.id,
						identifier: blocker.identifier,
					});
				}
			}

			if (unresolvedBlockers.length === 0) {
				return {
					blocked: false,
					blockingIssueIds: [],
					blockingIdentifiers: [],
				};
			}

			return {
				blocked: true,
				blockingIssueIds: unresolvedBlockers.map((b) => b.id),
				blockingIdentifiers: unresolvedBlockers.map((b) => b.identifier),
			};
		} catch (error) {
			this.logger.error(
				`Failed to check blocked-by dependencies for ${issue.identifier}:`,
				error,
			);
			// On error, don't block — proceed with normal flow
			return { blocked: false, blockingIssueIds: [], blockingIdentifiers: [] };
		}
	}

	/**
	 * Handle issue state change webhooks.
	 * When a blocking issue is completed, wake up any parked sessions that were waiting on it.
	 */
	private async handleIssueStateChange(
		webhook: IssueUpdateWebhook,
	): Promise<void> {
		const issueData = webhook.data;
		const completedIssueId = issueData.id;
		const issueIdentifier = issueData.identifier;

		// Only care about transitions TO completed or canceled states
		// The IssueWebhookPayload has a stateId field — resolve the state
		// via the issue tracker to check if it's a completion state
		const stateId = issueData.stateId;
		if (!stateId) {
			return;
		}

		// Find workspace for this webhook to resolve state type
		const linearWorkspaceId = webhook.organizationId;
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			return;
		}

		// Fetch the issue to check its current state type
		let stateType: string | undefined;
		try {
			const fullIssue = await issueTracker.fetchIssue(completedIssueId);
			const state = await fullIssue.state;
			stateType = state?.type;
		} catch {
			// Can't resolve state — skip
			return;
		}

		if (stateType !== "completed" && stateType !== "canceled") {
			return;
		}

		this.logger.debug(
			`Issue ${issueIdentifier} moved to ${stateType} — checking for parked sessions to wake`,
		);

		// Find parked sessions that were blocked by this issue
		const sessionsToWake: string[] = [];
		for (const [blockedIssueId, parked] of this.parkedSessions.entries()) {
			if (parked.blockingIssueIds.includes(completedIssueId)) {
				// Remove this blocker from the list
				parked.blockingIssueIds = parked.blockingIssueIds.filter(
					(id) => id !== completedIssueId,
				);

				// If no more blockers, wake the session
				if (parked.blockingIssueIds.length === 0) {
					sessionsToWake.push(blockedIssueId);
				} else {
					this.logger.debug(
						`Parked session for issue ${blockedIssueId} still has ${parked.blockingIssueIds.length} remaining blocker(s)`,
					);
				}
			}
		}

		// Wake up unblocked sessions
		for (const blockedIssueId of sessionsToWake) {
			const parked = this.parkedSessions.get(blockedIssueId);
			if (!parked) continue;

			this.parkedSessions.delete(blockedIssueId);

			this.logger.info(
				`Waking parked session for issue ${parked.agentSession.issue?.identifier} — all blockers resolved`,
			);

			// Post activity about waking up
			await this.activityPoster.postThoughtActivity(
				parked.agentSession.id,
				parked.linearWorkspaceId,
				`All blocking dependencies are now resolved — starting work.`,
			);

			// Replay the normal initializeAgentRunner flow
			try {
				await this.initializeAgentRunner(
					parked.agentSession,
					parked.repositories,
					parked.linearWorkspaceId,
					parked.guidance,
					parked.commentBody,
					parked.baseBranchOverrides,
					parked.routingMethod,
				);
			} catch (error) {
				this.logger.error(
					`Failed to wake parked session for issue ${blockedIssueId}:`,
					error,
				);
			}
		}
	}

	/**
	 * Handle a user re-prompt on a parked (blocked-by) session.
	 * Re-checks blocking status: if clear, wakes the session; if still blocked, re-posts status.
	 */
	private async handleParkedSessionReprompt(
		_webhook: AgentSessionPromptedWebhook,
		issueId: string,
	): Promise<void> {
		const parked = this.parkedSessions.get(issueId);
		if (!parked) return;

		const blockResult = await this.checkBlockedByDependencies(
			parked.agentSession,
			parked.linearWorkspaceId,
		);

		if (blockResult.blocked) {
			// Still blocked — update the parked entry and re-post status
			parked.blockingIssueIds = blockResult.blockingIssueIds;
			const blockerList = blockResult.blockingIdentifiers
				.map((id) => `**${id}**`)
				.join(", ");
			await this.activityPoster.postThoughtActivity(
				parked.agentSession.id,
				parked.linearWorkspaceId,
				`Still blocked by ${blockerList}. Will start automatically when resolved.`,
			);
			this.logger.info(
				`Re-prompt on parked session for ${parked.agentSession.issue?.identifier}: still blocked by ${blockResult.blockingIdentifiers.join(", ")}`,
			);
			return;
		}

		// Blockers resolved — wake the session
		this.parkedSessions.delete(issueId);
		this.logger.info(
			`Re-prompt cleared blockers for ${parked.agentSession.issue?.identifier} — waking session`,
		);

		await this.activityPoster.postThoughtActivity(
			parked.agentSession.id,
			parked.linearWorkspaceId,
			`Blocking dependencies are now resolved — starting work.`,
		);

		try {
			await this.initializeAgentRunner(
				parked.agentSession,
				parked.repositories,
				parked.linearWorkspaceId,
				parked.guidance,
				parked.commentBody,
				parked.baseBranchOverrides,
				parked.routingMethod,
			);
		} catch (error) {
			this.logger.error(
				`Failed to wake parked session for issue ${issueId} on re-prompt:`,
				error,
			);
		}
	}

	private buildIssueUpdatePrompt(
		issueIdentifier: string,
		issueData: {
			title: string;
			description?: string | null;
			attachments?: unknown;
		},
		updatedFrom: {
			title?: string;
			description?: string;
			attachments?: unknown;
		},
	): string {
		return this.promptBuilder.buildIssueUpdatePrompt(
			issueIdentifier,
			issueData,
			updatedFrom,
		);
	}

	/**
	 * Get issue tracker for a workspace (direct lookup by workspace ID)
	 */
	private getIssueTrackerForWorkspace(
		linearWorkspaceId: string,
	): IIssueTrackerService | undefined {
		return this.issueTrackers.get(linearWorkspaceId);
	}

	/**
	 * Get the activity sink for a repository by looking up its workspace.
	 */
	private getActivitySinkForRepo(repoId: string): IActivitySink | undefined {
		const repo = this.repositories.get(repoId);
		if (!repo?.linearWorkspaceId) return undefined;
		return this.activitySinks.get(repo.linearWorkspaceId);
	}

	/**
	 * Get the Linear API token for a workspace from workspace-level config.
	 */
	private getLinearTokenForWorkspace(linearWorkspaceId: string): string | null {
		const workspaceConfig = this.config.linearWorkspaces?.[linearWorkspaceId];
		if (!workspaceConfig) {
			return null; // CLI platform or unconfigured workspace
		}
		return workspaceConfig.linearToken;
	}

	/**
	 * Create a new Cyrus agent session with all necessary setup
	 * @param sessionId The Linear agent activity session ID
	 * @param issue Linear issue object
	 * @param repositories Repository configurations (primary repo is repositories[0])
	 * @param agentSessionManager Agent session manager instance
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 * @returns Object containing session details and setup information
	 */
	private async createCyrusAgentSession(
		sessionId: string,
		issue: { id: string; identifier: string },
		repositoriesOrSingle: RepositoryConfig | RepositoryConfig[],
		agentSessionManager: AgentSessionManager,
		linearWorkspaceId: string,
		baseBranchOverrides?: Map<string, string>,
		routingMethod?: string,
	): Promise<AgentSessionData> {
		const repositories = Array.isArray(repositoriesOrSingle)
			? repositoriesOrSingle
			: [repositoriesOrSingle];
		const primaryRepo = repositories[0]!;

		// Fetch full Linear issue details using workspace ID from webhook context
		const fullIssue = await this.fetchFullIssueDetails(
			issue.id,
			linearWorkspaceId,
		);
		if (!fullIssue) {
			throw new Error(`Failed to fetch full issue details for ${issue.id}`);
		}

		// Move issue to started state automatically, in case it's not already
		await this.moveIssueToStartedState(fullIssue, linearWorkspaceId);

		// Create workspace using full issue data
		// IMPORTANT: The CLI app (apps/cli/src/services/WorkerService.ts) typically provides
		// a custom createWorkspace handler, so the handler path is the one taken in production.
		// When adding new options here, always update the handler signature in config-types.ts
		// AND the CLI's handler implementation in WorkerService.ts to pass them through.
		this.logger.info(
			`createCyrusAgentSession: passing baseBranchOverrides=${baseBranchOverrides ? `Map(size=${baseBranchOverrides.size}, keys=[${Array.from(baseBranchOverrides.keys()).join(",")}])` : "undefined"}, useCustomHandler=${!!this.config.handlers?.createWorkspace}`,
		);
		let workspace: import("cyrus-core").Workspace;
		try {
			workspace = this.config.handlers?.createWorkspace
				? await this.config.handlers.createWorkspace(fullIssue, repositories, {
						baseBranchOverrides,
						onRepoSetupHookEvent: (activity) =>
							this.activityPoster.postRepoSetupHookActivity(
								sessionId,
								linearWorkspaceId,
								activity,
							),
						// PON-162: the handler's GitService is the CLI's instance,
						// which has no constructor-wired credential resolver — this
						// is how the production worktree path authenticates.
						resolveGitAuth: (repositoryPath, operation) =>
							this.resolveGitAuthForRepoPath(repositoryPath, operation),
					})
				: await this.gitService.createGitWorktree(fullIssue, repositories, {
						baseBranchOverrides,
						onRepoSetupHookEvent: (activity) =>
							this.activityPoster.postRepoSetupHookActivity(
								sessionId,
								linearWorkspaceId,
								activity,
							),
					});
		} catch (error) {
			if (error instanceof WorktreeCreationRefusedError) {
				// PON-161: the refusal is TERMINAL for the session. The client
				// has already seen the ack — without this post they would see
				// "Got it" followed by silence; observed live on agent-prod,
				// the swallowed refusal instead started the session in an
				// empty directory. Post the failure where the client looks,
				// close the cockpit mirror, and rethrow: the caller's lane
				// backstop releases the slot (not_started), and no runner
				// ever starts.
				// PON-194: through the floor like every other direct post.
				const refusalTracker =
					this.getIssueTrackerForWorkspace(linearWorkspaceId);
				if (refusalTracker) {
					await this.postActivityDirect(
						refusalTracker,
						{
							agentSessionId: sessionId,
							content: {
								type: "error",
								body: CLIENT_MESSAGES.worktreeRefusedAtStart(
									error.repositoryName,
								),
							},
						},
						"worktree refusal",
						"sanctioned",
						linearWorkspaceId,
					);
				}
				void this.cockpitMirror.close(issue.id, "not_started");
				this.logger.event("worktree_refusal_terminal", {
					issueId: issue.id,
					repository: error.repositoryName,
					sessionId,
				});
			}
			throw error;
		}

		this.logger.debug(`Workspace created at: ${workspace.path}`);

		const issueMinimal = this.convertLinearIssueToCore(fullIssue);

		// Create RepositoryContext entries for ALL repositories
		// Use resolved base branches from workspace creation (already accounts for
		// commit-ish overrides, graphite blocked-by, parent issues, and defaults)
		const repositoryContexts = repositories.map((repo) => ({
			repositoryId: repo.id,
			branchName: issueMinimal.branchName,
			baseBranchName:
				workspace.resolvedBaseBranches?.[repo.id]?.branch ?? repo.baseBranch,
		}));

		agentSessionManager.createCyrusAgentSession(
			sessionId,
			issue.id,
			issueMinimal,
			workspace,
			"linear",
			repositoryContexts,
		);

		// Register session-to-repo mapping and activity sink (use primary repo)
		this.sessionRepositories.set(sessionId, primaryRepo.id);
		const activitySink = this.getActivitySinkForRepo(primaryRepo.id);
		if (activitySink) {
			agentSessionManager.setActivitySink(sessionId, activitySink);
		}

		// PON-189: routing is operator information, not client information.
		// It used to post as a thought on the client thread — repo name,
		// target branch and our routing method, as the second thing a client
		// ever saw from us. It goes to the journal instead; nothing about
		// routing reaches a client surface on any workspace.
		{
			const repoLines = repositories.map((repo) => {
				const resolution = workspace.resolvedBaseBranches?.[repo.id];
				const branch = resolution?.branch ?? repo.baseBranch;
				const sourceLabel = !resolution
					? "default"
					: resolution.source === "commit-ish"
						? "override"
						: resolution.source === "graphite-blocked-by"
							? (resolution.detail ?? "graphite")
							: resolution.source === "parent-issue"
								? (resolution.detail ?? "parent")
								: "default";
				return `${repo.name}→${branch}(${sourceLabel})`;
			});
			this.logger.event("repository_routed", {
				sessionId,
				workspaceId: linearWorkspaceId,
				routingMethod,
				repositories: repoLines.join(", "),
			});
		}

		// Get the newly created session
		const session = agentSessionManager.getSession(sessionId);
		if (!session) {
			throw new Error(
				`Failed to create session for agent activity session ${sessionId}`,
			);
		}

		// Download attachments before creating Claude runner
		const attachmentResult = await this.downloadIssueAttachments(
			fullIssue,
			linearWorkspaceId,
			workspace.path,
		);

		// Pre-create attachments directory even if no attachments exist yet
		const workspaceFolderName = basename(workspace.path);
		const attachmentsDir = getAttachmentsDir(
			this.cyrusHome,
			workspaceFolderName,
			linearWorkspaceId,
		);
		await mkdir(attachmentsDir, { recursive: true });

		// Write Claude settings to disable co-authored-by attribution in the workspace.
		// This uses the SDK's "local" settings source (loaded via settingSources: ["user", "project", "local"])
		// to ensure Cyrus sessions don't add "Co-Authored-By: Claude" trailers to git commits.
		const claudeSettingsDir = join(workspace.path, ".claude");
		await mkdir(claudeSettingsDir, { recursive: true });
		await writeFile(
			join(claudeSettingsDir, "settings.local.json"),
			JSON.stringify(
				{
					includeCoAuthoredBy: false,
				},
				null,
				"\t",
			),
		);

		// Build allowed directories list - always include attachments directory
		// Include repository paths from all repositories
		const allRepoPaths = repositories.map((repo) => repo.repositoryPath);
		const allowedDirectories: string[] = [
			...new Set([
				attachmentsDir,
				...allRepoPaths,
				...this.gitService.getGitMetadataDirectoriesForWorkspace(workspace),
			]),
		];

		this.logger.debug(
			`Configured allowed directories for ${fullIssue.identifier}:`,
			allowedDirectories,
		);

		// Build allowed tools list with Linear MCP tools
		const allowedTools = this.buildAllowedTools(repositories);
		const disallowedTools = this.buildDisallowedTools(repositories);

		return {
			session,
			fullIssue,
			workspace,
			attachmentResult,
			attachmentsDir,
			allowedDirectories,
			allowedTools,
			disallowedTools,
		};
	}

	/**
	 * Handle agent session created webhook
	 * Can happen due to being 'delegated' or @ mentioned in a new thread
	 * @param webhook The agent session created webhook
	 * @param repos All available repositories for routing
	 */
	private async handleAgentSessionCreatedWebhook(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
		laneOptions?: LaneStartOptions,
	): Promise<void> {
		const receivedAt = Date.now();
		const issueId = webhook.agentSession?.issue?.id;
		const sessionId = webhook.agentSession.id;
		const workspaceId = webhook.organizationId;

		// PON-226: remember that Linear made a thread for this issue, whatever
		// becomes of it. The re-delegation recovery below reads this to tell
		// "Linear never created one" from "one was created and it died".
		if (issueId) this.agentSessionSeenAt.set(issueId, receivedAt);

		// PON-152: an @mention on a COCKPIT MIRROR issue is an operator
		// action (approve / reject), not a work request — intercept before
		// any lane, routing, or runner machinery. No model session starts.
		if (issueId) {
			const clientIssueId = this.cockpitMirror.clientIssueIdFor(issueId);
			if (clientIssueId) {
				// PON-237: same resolution as the prompted path. A mention
				// normally sets `creator`, but the mentioning comment carries
				// the person too — one helper so the two entrances to the same
				// reviewer check can never disagree about who is asking.
				const actor = resolveMirrorActor(webhook);
				await this.handleMirrorAction(
					{
						organizationId: workspaceId,
						mirrorSessionId: sessionId,
						actorId: actor.id,
						actorName: actor.name,
						rawBody: webhook.agentSession.comment?.body ?? "",
					},
					clientIssueId,
				);
				return;
			}
			// PON-219: the waiting room is an operator artefact in the cockpit
			// team, and the natural response to its stall comment is to reply
			// in the thread — which Linear delivers here as a delegation. It
			// is not a mirror, so the check above does not catch it, and
			// falling through starts a paid session that would try to route an
			// operator list to a client repository. Answer and stop.
			if (
				workspaceId === this.config.cockpit?.linearWorkspaceId &&
				webhook.agentSession.issue?.title === WAITING_ROOM_TITLE
			) {
				await this.agentSessionManager
					.createResponseActivity?.(
						sessionId,
						"This is a list, not a piece of work — it shows scope conversations still waiting on a client. Nudging them happens on the client's own issue; nothing here is mine to pick up. The list clears itself as clients reply.",
					)
					.catch(() => {});
				return;
			}
		}

		// PON-112: serialized-lane admission, before the ack so the FIRST
		// activity is already queue-aware. Lane bookkeeping is synchronous and
		// local — it adds no latency to the acknowledgment path.
		let laneHeld = laneOptions?.laneAssigned === true;
		if (this.laneManager.isEnabled(workspaceId) && !laneOptions?.laneAssigned) {
			// Child sessions bypass the lane: the active (parent) session waits
			// on their result, so queueing a child would deadlock the lane.
			const isChildSession = Boolean(
				this.globalSessionRegistry.getParentSessionId(sessionId),
			);
			if (!isChildSession) {
				const existingPosition = this.laneManager.positionOf(sessionId);
				if (existingPosition !== null) {
					// Duplicate webhook delivery for an already-queued session —
					// restate the position, never enqueue twice.
					await this.activityPoster.postQueuedAcknowledgment(
						sessionId,
						workspaceId,
						existingPosition,
					);
					return;
				}
				if (this.laneManager.acquire(workspaceId, sessionId)) {
					laneHeld = true;
				} else {
					const position = this.laneManager.enqueue(workspaceId, {
						sessionId,
						issueId,
						issueIdentifier: webhook.agentSession.issue?.identifier,
						enqueuedAt: new Date().toISOString(),
						webhook,
						kind: "created",
					});
					// Cockpit (PON-151): a freshly queued delegation mirrors
					// with its position. Mentions queue too but are
					// conversations — the marker heuristic (same one
					// initializeAgentRunner uses) keeps them out.
					const queuedCommentBody = webhook.agentSession.comment?.body;
					const queuedIsMention =
						!!queuedCommentBody &&
						!queuedCommentBody.includes("This thread is for an agent session");
					if (webhook.agentSession.issue && !queuedIsMention) {
						void this.cockpitMirror.upsert(
							{
								issueId: webhook.agentSession.issue.id,
								issueIdentifier: webhook.agentSession.issue.identifier,
								title: webhook.agentSession.issue.title,
								url: (webhook.agentSession.issue as { url?: string }).url,
							},
							workspaceId,
							"queued",
							{ position },
						);
					}
					// Persist BEFORE the client-visible ack: once the client has
					// been told "position #N", a crash must not lose the entry.
					// Strict: a failed write rolls the entry back and aborts —
					// told-but-not-persisted must be impossible.
					try {
						await this.savePersistedStateStrict();
					} catch (error) {
						this.laneManager.removeQueued(sessionId);
						this.logger.event("lane_enqueue_persist_failed", {
							workspaceId,
							sessionId,
						});
						throw error;
					}
					await this.activityPoster.postQueuedAcknowledgment(
						sessionId,
						workspaceId,
						position,
					);
					this.logger.event("session_ack_posted", {
						kind: "created",
						queued: true,
						position,
						sessionId,
						elapsedMs: Date.now() - receivedAt,
					});
					return;
				}
			}
		}

		try {
			await this.runAgentSessionCreatedFlow(
				webhook,
				repos,
				receivedAt,
				laneOptions,
			);
		} finally {
			// Backstop (PON-112): if this session took the lane but no runner
			// ever started — routing "none", pending repository selection,
			// blocked-by park, blocked user, or a thrown error — free the lane
			// so queued work continues. Release is idempotent.
			if (laneHeld) {
				if (this.agentSessionManager.getSession(sessionId)?.agentRunner) {
					this.clearLaneGrace(workspaceId);
				} else {
					this.releaseLaneAndContinue(workspaceId, sessionId, "not_started");
				}
			}
		}
	}

	/**
	 * The pre-PON-112 body of handleAgentSessionCreatedWebhook: ack, routing,
	 * access checks, blocked-by check, runner initialization. Split out so the
	 * lane admission above can wrap it with a release backstop.
	 */
	private async runAgentSessionCreatedFlow(
		webhook: AgentSessionCreatedWebhook,
		repos: RepositoryConfig[],
		receivedAt: number,
		laneOptions?: LaneStartOptions,
	): Promise<void> {
		const issueId = webhook.agentSession?.issue?.id;

		// Acknowledge before routing, access checks, or any repository work —
		// Linear marks the session unresponsive if no activity arrives within
		// 10 seconds of the created webhook. Everything below this may hit the
		// Linear API (token refresh, label/description routing, blocked-by
		// checks) and must not delay the first activity.
		await this.postInstantAcknowledgment(
			webhook.agentSession.id,
			webhook.organizationId,
		);
		this.logger.event("session_ack_posted", {
			kind: "created",
			...(laneOptions?.laneAssigned && { laneDequeue: true }),
			sessionId: webhook.agentSession.id,
			elapsedMs: Date.now() - receivedAt,
		});

		// Check the cache first, as the agentSessionCreated webhook may have been triggered by an @mention
		// on an issue that already has an agentSession and an associated repository.
		let repositories: RepositoryConfig[] | null = null;
		let baseBranchOverrides: Map<string, string> | undefined;
		let routingMethod: string | undefined;
		if (issueId) {
			const cachedRepos = this.getCachedRepositories(issueId);
			if (cachedRepos && cachedRepos.length > 0) {
				repositories = cachedRepos;
				this.logger.debug(
					`Using cached repositories [${cachedRepos.map((r) => r.name).join(", ")}] for issue ${issueId}`,
				);
			}
		}

		// If not cached, perform routing logic
		if (!repositories) {
			const routingResult =
				await this.repositoryRouter.determineRepositoryForWebhook(
					webhook,
					repos,
				);

			if (routingResult.type === "none") {
				if (process.env.CYRUS_WEBHOOK_DEBUG === "true") {
					this.logger.info(
						`No repository configured for webhook from workspace ${webhook.organizationId}`,
					);
				}
				return;
			}

			// Unmapped team (2a): no repository is mapped for this issue. Refuse
			// in client language + notify the operator; NEVER guess a repo and
			// never start a runner.
			if (routingResult.type === "unmapped") {
				await this.repositoryRouter.refuseUnmappedRepository(
					webhook,
					routingResult.workspaceRepos,
				);
				return;
			}

			// Ambiguous route (2b): an implicit mapping matched >1 repo. Ask,
			// once, with a canonical Select of the candidates. Resolution
			// continues in handleRepositorySelectionResponse.
			if (routingResult.type === "ambiguous") {
				await this.repositoryRouter.elicitAmbiguousRepository(
					webhook,
					routingResult.candidates,
				);
				return;
			}

			// At this point, routingResult.type === "selected"
			repositories = routingResult.repositories;
			baseBranchOverrides = routingResult.baseBranchOverrides;
			if (baseBranchOverrides && baseBranchOverrides.size > 0) {
				this.logger.info(
					`baseBranchOverrides received from routing: ${Array.from(
						baseBranchOverrides.entries(),
					)
						.map(([id, branch]) => `${id}→${branch}`)
						.join(", ")}`,
				);
			} else {
				this.logger.info(`No baseBranchOverrides from routing result`);
			}
			routingMethod = routingResult.routingMethod;

			// Cache all matched repositories for this issue as string[]
			if (issueId) {
				this.repositoryRouter.getIssueRepositoryCache().set(
					issueId,
					repositories.map((r) => r.id),
				);
			}
		}

		if (!webhook.agentSession.issue) {
			this.logger.warn("Agent session created webhook missing issue");
			return;
		}

		// User access control check (use primary repo)
		const primaryRepo = repositories[0]!;
		const accessResult = this.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from delegating: ${accessResult.reason}`,
			);
			await this.handleBlockedUser(webhook, primaryRepo, accessResult.reason);
			return;
		}

		// Use organizationId from webhook as the Linear-native workspace ID source
		const linearWorkspaceId = webhook.organizationId;

		const log = this.logger.withContext({
			sessionId: webhook.agentSession.id,
			platform: this.getRepositoryPlatform(linearWorkspaceId),
			issueIdentifier: webhook.agentSession.issue.identifier,
			workspaceId: linearWorkspaceId,
		});
		log.info(`Handling agent session created`);
		const { agentSession, guidance } = webhook;
		const commentBody = agentSession.comment?.body;

		// Check for blocked-by dependencies before starting work
		const blockResult = await this.checkBlockedByDependencies(
			agentSession,
			linearWorkspaceId,
		);
		if (blockResult.blocked) {
			// Park the session — don't create worktree or runner
			const parkedIssueId = agentSession.issue!.id;
			this.parkedSessions.set(parkedIssueId, {
				agentSession,
				repositories,
				linearWorkspaceId,
				guidance,
				commentBody,
				baseBranchOverrides,
				routingMethod,
				blockingIssueIds: blockResult.blockingIssueIds,
			});

			// Post acknowledgment to the Linear agent session
			const blockerList = blockResult.blockingIdentifiers
				.map((id) => `**${id}**`)
				.join(", ");
			await this.activityPoster.postThoughtActivity(
				agentSession.id,
				linearWorkspaceId,
				`Blocked by ${blockerList} — will start automatically when ${blockResult.blockingIdentifiers.length === 1 ? "it is" : "they are"} resolved.`,
			);

			log.info(
				`Session parked: issue ${agentSession.issue!.identifier} is blocked by ${blockResult.blockingIdentifiers.join(", ")}`,
			);
			return;
		}

		// Deliver prompts the user posted while this session sat in the lane
		// queue (PON-112): appended to the comment body so prompt assembly
		// includes them in the initial prompt.
		const queuedContext = laneOptions?.queuedContextPrompts?.length
			? `Context added while this issue was queued:\n${laneOptions.queuedContextPrompts
					.map((p) => `- ${p}`)
					.join("\n")}`
			: undefined;
		const effectiveCommentBody = queuedContext
			? `${commentBody ?? ""}\n\n${queuedContext}`
			: commentBody;

		// Initialize agent runner using shared logic (pass full repositories array)
		await this.initializeAgentRunner(
			agentSession,
			repositories,
			linearWorkspaceId,
			guidance,
			effectiveCommentBody,
			baseBranchOverrides,
			routingMethod,
		);
	}

	/**
	 * Bound the issue-update dedupe cache PER TENANT (PON-115).
	 *
	 * A single global cap made this a cross-tenant interference channel: a
	 * busy workspace could evict a quiet one's keys, and the quiet tenant
	 * would then reprocess a duplicate webhook it had already handled. Keys
	 * are workspace-prefixed, so pruning the largest tenant's oldest entries
	 * keeps one tenant's volume from costing another its dedupe history.
	 */
	private pruneProcessedIssueUpdateKeys(): void {
		const PER_TENANT_LIMIT = 250;
		if (this.processedIssueUpdateKeys.size <= PER_TENANT_LIMIT) return;

		const byTenant = new Map<string, string[]>();
		for (const key of this.processedIssueUpdateKeys) {
			const tenant = key.slice(0, key.indexOf(":"));
			const bucket = byTenant.get(tenant);
			if (bucket) bucket.push(key);
			else byTenant.set(tenant, [key]);
		}

		for (const keys of byTenant.values()) {
			if (keys.length <= PER_TENANT_LIMIT) continue;
			// Insertion order is chronological, so the head is the oldest.
			for (const key of keys.slice(0, keys.length - PER_TENANT_LIMIT)) {
				this.processedIssueUpdateKeys.delete(key);
			}
		}
	}

	// ========================================================================
	// TENANT REVOCATION (PON-115)
	// ========================================================================

	/**
	 * Handle a permission/access change for this app in a workspace.
	 *
	 * Linear's PermissionChange payload reports team access being added or
	 * removed — it is not an explicit "uninstalled" event, and the payload
	 * alone cannot tell us whether ANY access remains (it lists the delta, not
	 * the resulting set). So rather than inferring revocation from an empty
	 * `addedTeamIds` or a false `canAccessAllPublicTeams`, we ask the only
	 * authority that knows: we probe with that tenant's own token. An auth
	 * failure, or a successful probe showing no reachable teams, means the
	 * tenant can no longer be served.
	 *
	 * A partial scope change is logged and otherwise left alone: routing
	 * already fails safely for a team we cannot read.
	 */
	private async handlePermissionChange(
		webhook: PermissionChangeWebhook,
	): Promise<void> {
		const workspaceId = webhook.organizationId;
		const wsConfig = this.config.linearWorkspaces?.[workspaceId];
		if (!wsConfig) {
			this.logger.event("webhook_unknown_workspace", {
				action: webhook.action,
				organizationId: workspaceId,
			});
			return;
		}

		// The payload names the app user it concerns. If we have one recorded
		// and it differs, this is about a different installation.
		if (wsConfig.appUserId && webhook.appUserId !== wsConfig.appUserId) {
			this.logger.warn(
				`Ignoring permission change for workspace ${workspaceId}: appUserId mismatch`,
			);
			return;
		}

		this.logger.event("permission_change_received", {
			workspaceId,
			action: webhook.action,
			addedTeams: webhook.addedTeamIds?.length ?? 0,
			removedTeams: webhook.removedTeamIds?.length ?? 0,
			canAccessAllPublicTeams: webhook.canAccessAllPublicTeams,
		});

		const stillHasAccess = await this.tenantStillHasAccess(workspaceId);
		if (stillHasAccess) {
			this.logger.info(
				`Permission change for workspace ${workspaceId}: access retained`,
			);
			return;
		}

		await this.deactivateTenant(workspaceId, "permission_revoked");
	}

	/**
	 * Free the lane while a session waits on a human (PON-113).
	 *
	 * A session parked on a question is not working, and holding a serialized
	 * lane on an unanswered question blocks every other issue the client has
	 * queued — for as long as they take to reply. The answer re-enters through
	 * `admitAnsweredSessionToLane`, so the one-active-session guarantee still
	 * holds; the lane is simply not held during the wait.
	 */
	private releaseLaneWhileAwaitingInput(
		sessionId: string,
		reasonOverride?: string,
	): void {
		const workspaceId = this.laneManager.workspaceOf(sessionId);
		if (!workspaceId || !this.laneManager.isActive(sessionId)) return;
		// PON-150: while the issue's scope is unapproved, a wait on a human is
		// a wait on scope confirmation — recorded distinctly so the cockpit
		// can tell "blocked on an answer" from "blocked on the gate". The
		// gate outranks any override (PON-172's needs-info reason included).
		const issueId = this.sessionIssueId(sessionId);
		const reason =
			issueId && this.scopeGatePendingForIssue(workspaceId, issueId)
				? "awaiting_scope_confirm"
				: (reasonOverride ?? "awaiting_user_input");
		this.releaseLaneAndContinue(workspaceId, sessionId, reason);
	}

	// ========================================================================
	// SCOPE-CONFIRM GATE (PON-150)
	// ========================================================================

	/**
	 * Whether the scope-confirm gate is on for a workspace. Default on —
	 * the gate exists for people who are paying us; explicit `false` opts a
	 * workspace out (our own development workspace).
	 */
	private scopeGateEnabled(workspaceId: string | undefined): boolean {
		if (!workspaceId) return false;
		return (
			this.config.linearWorkspaces?.[workspaceId]?.scopeConfirmGate !== false
		);
	}

	/**
	 * PON-179: a session whose workspace runs EITHER client-flow gate is a
	 * client-quiet session — its Linear activity stream reads as a client
	 * surface, so working narration is suppressed and whatever still posts
	 * is policy-sanitized. Non-gated workspaces (the dev box's, by Harold's
	 * explicit choice) are untouched.
	 */
	private clientQuietSession(
		sessionId: string,
		workspaceIdFallback?: string,
	): boolean {
		// PON-191: the repo-setup hook posts from inside worktree creation,
		// BEFORE the session is registered against its repository, so neither
		// lookup below can answer yet and quietness resolved to "not quiet" —
		// hook output (script tails, box paths) on a client thread. Callers
		// that know their workspace pass it, and it is used when the session
		// mapping cannot answer.
		// PON-208: an operator session is a WORKING surface, not a client
		// one. Its subject is the client's repository, so every flag below
		// would resolve against the CLIENT's workspace and silence the very
		// narration Harold is there to read. Quietness is a property of the
		// audience, and this audience is the operator.
		if (this.operatorSessions.isOperatorSession(sessionId)) return false;
		const workspaceId =
			this.resolveWorkspaceIdForSession(sessionId) ??
			this.laneManager.workspaceOf(sessionId) ??
			workspaceIdFallback;
		if (!workspaceId) return false;
		const ws = this.config.linearWorkspaces?.[workspaceId];
		// PON-182: the explicit per-workspace flag wins — narration
		// suppression is independent of the gates. ABSENT falls back to the
		// gate-derived default (RAW flags, not verificationGateEnabled: that
		// helper folds in cockpit topology, but a gated tenant without a
		// cockpit must still never receive narration), which preserves
		// pre-flag behaviour with zero config edits.
		if (ws?.clientQuiet !== undefined) return ws.clientQuiet;
		return (
			this.scopeGateEnabled(workspaceId) || ws?.verifyBeforeDelivery !== false
		);
	}

	/**
	 * Publish the client-facing lifecycle plan on a client session (v3.1).
	 *
	 * The client's native plan (Linear's numbered step list) never shows the
	 * model's task list — that stays the reviewer's surface on the mirror. It
	 * shows a fixed four-step lifecycle whose status is driven from HERE, the
	 * state machine, at each transition. Operator-guarded: a mirror session
	 * must keep its detailed model plan, so this refuses to overwrite one even
	 * if a caller passes a mirror session by mistake. Best-effort — a lost plan
	 * update is never a broken session.
	 */
	private async publishClientLifecyclePlan(
		sessionId: string | undefined,
		phase: ClientLifecyclePhase,
	): Promise<void> {
		if (!sessionId) return;
		if (this.operatorSessions.isOperatorSession(sessionId)) return;
		try {
			await this.agentSessionManager.publishSessionPlan(
				sessionId,
				buildClientLifecyclePlan(phase),
			);
		} catch (error) {
			this.logger.debug(
				`Client lifecycle plan publish failed for ${sessionId}: ${String(error)}`,
			);
		}
	}

	/**
	 * The rule blocks appended to a session's system prompt (PON-211).
	 *
	 * An operator session gets NEITHER of the client-facing blocks. Appending
	 * them was a straight contradiction: the client-surface block bans
	 * internal vocabulary, bans "narration diaries" and mandates deliverable
	 * framing, while the operator block asks for the opposite — name files,
	 * show diffs, the client register does not apply here. The model was being
	 * told both at once, on the one thread where the reviewer wants an
	 * engineer. The needs-info block is wrong here too: it points questions at
	 * the client, and on this thread they belong to the reviewer.
	 */
	private sessionRuleBlocks(sessionId: string | undefined): string {
		if (this.operatorSessions.isOperatorSession(sessionId)) return "";
		// PON-229: once work is delivered, the client's thread stays open and
		// what arrives on it is either a question about what they got or a
		// request to change it. Told neither, a session treats both as work —
		// the same defect the reviewer's thread had, except here it changes
		// delivered software in front of the person who owns it. The block
		// only decides question-versus-change-request; the queue mechanics of
		// a reopened piece of work are §8.8's own increment.
		return (
			buildClientSurfaceRuleBlock() +
			buildNeedsInfoRuleBlock() +
			(this.isDeliveredClientSession(sessionId)
				? buildDeliveredRequestBlock()
				: "")
		);
	}

	/**
	 * A CLIENT session (never an operator one) whose issue is delivered and
	 * so must not be changed directly — a change goes back through review as
	 * rework. Drives both the prompt guardrail and the tool denial.
	 */
	private isDeliveredClientSession(sessionId: string | undefined): boolean {
		if (this.operatorSessions.isOperatorSession(sessionId)) return false;
		const issueId = sessionId ? this.sessionIssueId(sessionId) : undefined;
		return Boolean(
			issueId && this.verificationGate.get(issueId)?.state === "delivered",
		);
	}

	/**
	 * Capability by state (Harold's ruling, 2026-09-02). Building the work —
	 * file edits, git write/push — is a capability of the DELEGATED MIRROR
	 * session and nothing else. Two invariants, both enforced here rather than
	 * asked in a prompt:
	 *   A. A client-workspace session never mutates the work, in any state —
	 *      before or after approval, on delivery, ever. It scopes, elicits,
	 *      confirms, answers, relays.
	 *   B. A mirror session mutates only after claim + delegation. Inert birth
	 *      is a capability, not the absence of activity: a session Linear
	 *      creates on a mirror before it is delegated (isOperatorSession is
	 *      false) still cannot build, however many activities it has.
	 * Native cockpit work (the team's own build issues) and non-client-flow
	 * workspaces are untouched.
	 */
	private shouldDenyMutation(
		sessionId: string | undefined,
		workspaceId: string | undefined,
	): boolean {
		const cockpit = this.config.cockpit;
		if (!cockpit) return false;
		// The delegated mirror build/review session is the one that may build.
		if (this.operatorSessions.isOperatorSession(sessionId)) return false;
		const issueId = sessionId ? this.sessionIssueId(sessionId) : undefined;
		if (workspaceId === cockpit.linearWorkspaceId) {
			// Invariant B: a cockpit-workspace session is denied only on a
			// DERIVED mirror issue (an un-delegated mirror session). A native
			// cockpit build is normal work.
			return Boolean(issueId && this.cockpitMirror.clientIssueIdFor(issueId));
		}
		// Invariant A: a client-workspace session never mutates while its
		// workspace runs the client flow.
		const ws = workspaceId
			? this.config.linearWorkspaces?.[workspaceId]
			: undefined;
		if (ws?.clientQuiet !== undefined) return ws.clientQuiet;
		return (
			this.scopeGateEnabled(workspaceId) || ws?.verifyBeforeDelivery !== false
		);
	}

	/** File edits and git write/push — the tools that change the work. */
	private isMutationTool(
		toolName: string,
		input: Record<string, unknown>,
	): boolean {
		if (
			toolName === "Write" ||
			toolName === "Edit" ||
			toolName === "MultiEdit" ||
			toolName === "NotebookEdit"
		) {
			return true;
		}
		if (toolName === "Bash") {
			const cmd = String((input as { command?: unknown }).command ?? "");
			return /\bgit\s+(commit|push|add|merge|rebase|cherry-pick|reset|apply|am|tag|stash)\b/.test(
				cmd,
			);
		}
		return false;
	}

	/** Sessions already handed a delivered-change confirm this turn (dedup). */
	private deliveredConfirmPosted = new Set<string>();

	/**
	 * The v3.1 capability gate (Harold's ruling): consulted before any tool
	 * runs. Denies a mutation the session has no capability for, and — on a
	 * DELIVERED client session (decision 1) — posts the canonical
	 * "make this change?" confirm itself and logs the attempt as a classifier
	 * miss, so the model never has to author the confirm and a blocked change
	 * still reaches the client as a choice.
	 */
	private createCapabilityGuard(
		sessionId: string,
		workspaceId: string,
	): NonNullable<AgentRunnerConfig["guardCapability"]> {
		return async (toolName, input) => {
			if (!this.isMutationTool(toolName, input)) return undefined;
			if (!this.shouldDenyMutation(sessionId, workspaceId)) return undefined;
			const issueId = this.sessionIssueId(sessionId);
			const delivered = Boolean(
				issueId && this.verificationGate.get(issueId)?.state === "delivered",
			);
			if (delivered && issueId) {
				this.postDeliveredChangeConfirm(sessionId, issueId, workspaceId);
			}
			this.logger.event("capability_denied", {
				sessionId,
				toolName,
				issueId,
				// Decision 1: a blocked mutation on delivered work is a miss by
				// whatever should have classified the message as a change
				// request before it reached a build attempt.
				classifierMiss: delivered,
				phase: delivered ? "delivered" : "pre-build",
			});
			return {
				deny: true,
				message: delivered
					? "This work is already delivered. A change goes back through review as rework, never straight onto the client's branch — I've asked the client to confirm the change. Do not edit, commit or push here."
					: "Building happens on the reviewer's mirror once it is delegated, not on this session. Read and propose, or ask — do not edit, commit or push here.",
			};
		};
	}

	/**
	 * Post the canonical change-request confirm on a delivered client session
	 * (decision 1). Once per turn. The client's "Yes, make this change" is read
	 * by interpretReworkReply, which reopens the work as rework.
	 */
	private postDeliveredChangeConfirm(
		sessionId: string,
		_issueId: string,
		workspaceId: string,
	): void {
		if (this.deliveredConfirmPosted.has(sessionId)) return;
		this.deliveredConfirmPosted.add(sessionId);
		const tracker = this.issueTrackers.get(workspaceId);
		if (!tracker?.createAgentActivity) return;
		const body =
			"It sounds like you'd like a change to what was delivered. Shall I make it? It goes back through review, the same path the first delivery took.";
		void tracker
			.createAgentActivity({
				agentSessionId: sessionId,
				content: {
					type: "elicitation",
					body: this.agentSessionManager.sanitizeClientSurfaceText(
						sessionId,
						"elicitation",
						body,
					),
				},
				signal: AgentActivitySignal.Select,
				signalMetadata: {
					options: [
						{ value: REWORK_YES_LABEL },
						{ value: REWORK_NO_LABEL },
						{ value: "Other" },
					],
				},
			})
			.then(() => {
				this.logger.event("delivered_change_confirm_posted", { sessionId });
			})
			.catch((error) => {
				this.logger.error("Could not post the change confirm:", error);
			});
	}

	/** Gate on for the workspace AND the issue's scope not yet approved. */
	private scopeGatePendingForIssue(
		workspaceId: string | undefined,
		issueId: string | undefined,
	): boolean {
		if (!workspaceId || !issueId) return false;
		return (
			this.scopeGateEnabled(workspaceId) &&
			!this.scopeApprovals.isApproved(issueId)
		);
	}

	/**
	 * Per-git-process credential for a repository path (PON-143/162): mint an
	 * installation token from the worktree's OWN origin remote. Returns null
	 * for non-GitHub remotes, missing remotes, or no-App installs — those
	 * keep working unchanged. Threaded into BOTH GitService instances: the
	 * one EdgeWorker constructs, and — via the createWorkspace handler
	 * options — the CLI's, which is the instance the production worktree
	 * path actually uses (found live on agent-prod, PON-162).
	 */
	private async resolveGitAuthForRepoPath(
		repositoryPath: string,
		operation: "fetch" | "ls-remote" | "push",
	): Promise<{
		env: Record<string, string | undefined>;
		args: string[];
	} | null> {
		if (!this.gitHubInstallationResolver) return null;
		let originUrl: string;
		try {
			originUrl = execSync("git remote get-url origin", {
				cwd: repositoryPath,
				stdio: "pipe",
				encoding: "utf-8",
			}).trim();
		} catch {
			return null; // no remote: nothing to authenticate against
		}
		// PON-203: a credential embedded in the remote URL is a live token in
		// .git/config — it outlives the process, lands in backups, and is
		// readable by anything that can read the repository. Sessions used to
		// improvise exactly this shape when they had no credential of their
		// own. Strip it here, where every session's repository passes anyway,
		// rather than trusting that nothing ever writes one again.
		if (remoteUrlHasEmbeddedCredential(originUrl)) {
			const clean = stripEmbeddedCredential(originUrl);
			try {
				execSync(`git remote set-url origin ${JSON.stringify(clean)}`, {
					cwd: repositoryPath,
					stdio: "pipe",
				});
				this.logger.warn(
					`[event:embedded_credential_stripped] removed a credential from the origin URL of ${repositoryPath}`,
				);
			} catch (error) {
				this.logger.error(
					`[event:embedded_credential_strip_failed] ${repositoryPath}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			originUrl = clean;
		}

		const ref = parseGitHubRepoUrl(originUrl);
		if (!ref) return null; // not GitHub: leave it alone

		const token = await this.gitHubInstallationResolver.mintTokenForRef(
			ref,
			operation,
		);
		return {
			env: gitAuthEnv(token),
			args: [...GIT_NO_AMBIENT_CREDENTIALS],
		};
	}

	/**
	 * Git and GitHub credentials for the SESSION itself (PON-202).
	 *
	 * The machinery authenticated its own clones and fetches from the start,
	 * but the session — the thing that actually pushes the branch and opens
	 * the pull request, which is the entire deliverable — was handed nothing.
	 * No token, no askpass, not even HOME. Sessions coped by writing their own
	 * token minters and embedding credentials in remote URLs, which worked on
	 * exactly one account: the one whose installation id happened to be in the
	 * box-wide env. The first client repository under a different installation
	 * got "Repository not found", and the client was told the GitHub
	 * integration was not connected. It was; we simply never gave the session
	 * a way to use it.
	 *
	 * The token is resolved from the worktree's OWN origin remote, so it is
	 * the installation that actually covers this repository rather than
	 * whatever the box was configured with.
	 *
	 * Returns an empty object when there is nothing to inject — a non-GitHub
	 * remote, no App configured — which leaves the previous behaviour exactly
	 * as it was.
	 */
	private async buildSessionGitEnv(
		worktreePath: string,
	): Promise<Record<string, string | undefined>> {
		try {
			const auth = await this.resolveGitAuthForRepoPath(worktreePath, "push");
			if (!auth) return {};
			const token = auth.env.CYRUS_GIT_TOKEN;
			if (!token) return {};
			// PON-206: commits must be authored as the App's own bot user. A
			// commit GitHub cannot link to an account is an unverified commit,
			// and Vercel refuses to build such a pull request — so the preview
			// link, which is the deliverable, never appears.
			let identity: Record<string, string> = {};
			try {
				const bot = await this.appBotIdentity();
				if (bot) {
					identity = {
						GIT_AUTHOR_NAME: bot.name,
						GIT_AUTHOR_EMAIL: bot.email,
						GIT_COMMITTER_NAME: bot.name,
						GIT_COMMITTER_EMAIL: bot.email,
					};
				}
			} catch (error) {
				// A commit with the box's default identity still lands; only the
				// preview is lost. Never fail session start for it.
				this.logger.warn(
					`Could not resolve the App bot identity: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			return {
				...(auth.env as Record<string, string>),
				...identity,
				// PON-205: the box-wide installation id never reaches a session
				// again. It is dead config (PON-143 resolves installations per
				// repository) and it was the pointer that made improvisation
				// possible: a session with no credential found this, minted a
				// token for the WRONG installation, and told the client the
				// integration was disconnected. Unset explicitly rather than
				// relying on the env file, so it holds however the box is set up.
				GITHUB_APP_INSTALLATION_ID: undefined as unknown as string,
				// `gh pr create` reads GH_TOKEN; the same installation token
				// carries pull_requests:write.
				GH_TOKEN: token,
				// Without HOME, git and gh cannot read their own config and fail
				// with "fatal: $HOME not set" before they ever reach a
				// credential. Observed on the first client push.
				HOME: process.env.HOME ?? homedir(),
			};
		} catch (error) {
			// A credential that cannot be minted must not stop the session from
			// starting: it fails later, loudly, on the push itself.
			this.logger.warn(
				`Could not resolve session git credentials for ${worktreePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return {};
		}
	}

	/**
	 * The App's bot identity, for authoring commits (PON-206). Null when no
	 * GitHub App is configured, which is the same condition under which no
	 * credential is injected at all.
	 */
	private async appBotIdentity(): Promise<{
		name: string;
		email: string;
	} | null> {
		const appId = process.env.GITHUB_APP_ID;
		// Same location the installation resolver is built from, so the two
		// cannot disagree about which App we are.
		const privateKeyPath = join(this.cyrusHome, "github-app.pem");
		if (!appId || !existsSync(privateKeyPath)) return null;
		return await appBotIdentity({ appId, privateKeyPath });
	}

	/** The Linear issue id a session is working, from the session manager. */
	private sessionIssueId(sessionId: string): string | undefined {
		const session = this.agentSessionManager.getSession(sessionId);
		return session?.issueContext?.issueId ?? session?.issueId;
	}

	/**
	 * Append the gate block when the gate is pending for the issue (PON-150).
	 * Called from every path that hands a system prompt to a runner on a
	 * gated issue: new delegated sessions, mention sessions on an issue whose
	 * gate is already open, and — critically — session RESUME. A resumed
	 * runner does not inherit the previous invocation's appended prompt, so
	 * without re-injection a routine restart would silently remove the gate
	 * (adversarial review finding, 2026-08-22). Child sessions are exempt:
	 * they work inside a scope their parent already carries.
	 */
	private appendScopeGateIfPending(
		systemPrompt: string | undefined,
		workspaceId: string | undefined,
		issueId: string | undefined,
		sessionId: string | undefined,
	): string | undefined {
		if (
			sessionId &&
			this.globalSessionRegistry.getParentSessionId(sessionId) != null
		) {
			return systemPrompt;
		}
		// PON-208: never gate an operator session. In practice its issue is
		// already approved — approval is a precondition of reaching
		// verification — but that is a chain of three other invariants, and
		// the failure it protects against (asking Harold to approve the scope
		// of his own iteration, on the operator's own thread) is absurd enough
		// to be worth stating directly rather than inferring.
		if (this.operatorSessions.isOperatorSession(sessionId)) {
			return systemPrompt;
		}
		if (this.scopeGatePendingForIssue(workspaceId, issueId)) {
			return (systemPrompt ?? "") + buildScopeConfirmGateBlock();
		}
		// PON-224: between approval and implementation start, every session
		// on the client thread carries the parked block — the approval turn
		// itself (which must confirm and stop) and any follow-up (which must
		// converse without picking the work up). Same injection points as the
		// gate: a resumed runner does not inherit the previous invocation's
		// appended prompt, so a restart would otherwise remove the rule.
		if (issueId && this.scopeApprovals.isImplementationDeferred(issueId)) {
			return (systemPrompt ?? "") + buildImplementationParkedBlock();
		}
		return systemPrompt;
	}

	/**
	 * Persist scope-approval state, logging rather than throwing: gate
	 * bookkeeping must never break the elicitation or answer flow it rides on.
	 */
	private async persistScopeApprovals(context: string): Promise<void> {
		try {
			await this.savePersistedStateStrict();
		} catch (error) {
			this.logger.error(
				`Failed to persist scope approvals (${context}):`,
				error,
			);
		}
		// PON-219: every scope-state change funnels through here — proposed,
		// approved, revised, cancelled — so the waiting room is refreshed from
		// one place rather than at each of its callers.
		this.syncScopeWaitingRoom();
	}

	/**
	 * Drop scope records whose client issue has already reached a terminal
	 * state (PON-219). Bounded by the number of OPEN gates, not by issues.
	 */
	private async pruneEndedScopeConversations(): Promise<void> {
		let removed = 0;
		// PON-224: parked approvals join the sweep. A deferred record whose
		// client issue ended while we were down would otherwise park forever —
		// same drift, same repair, still bounded by open work.
		for (const entry of [
			...this.scopeApprovals.listPending(),
			...this.scopeApprovals.listDeferred(),
		]) {
			if (!entry.workspaceId) continue;
			try {
				const state = await this.cockpitMirror.clientIssueStateType(
					entry.workspaceId,
					entry.issueId,
				);
				// Unreadable is NOT a reason to forget a live gate — only an
				// explicitly terminal state is.
				if (state === "completed" || state === "canceled") {
					if (this.scopeApprovals.remove(entry.issueId)) removed++;
				}
			} catch {
				// A prune failure must never stop the boot.
			}
		}
		if (removed > 0) {
			this.logger.info(
				`[event:scope_records_pruned] ${JSON.stringify({ removed })}`,
			);
			await this.persistScopeApprovals("pruned_ended_conversations");
		}
	}

	/**
	 * Refresh the pre-approval visibility list (PON-219).
	 *
	 * Fire-and-forget and never throws: this is an operator convenience, and
	 * a failure here must never touch a client's scope conversation.
	 */
	private syncScopeWaitingRoom(): void {
		try {
			void this.scopeWaitingRoom?.sync([
				...this.scopeApprovals.listPending().map((entry) => ({
					issueId: entry.issueId,
					issueIdentifier: entry.issueIdentifier,
					workspaceId: entry.workspaceId,
					proposedAt: entry.proposedAt,
					state: entry.state,
				})),
				// v3.1 P2: a mid-work question to the client is a wait too, and
				// the one register built to be read at a glance must show it.
				...this.needsInfo.listAwaiting().map((entry) => ({
					issueId: entry.issueId,
					issueIdentifier: entry.issueIdentifier,
					workspaceId: entry.workspaceId,
					proposedAt: entry.askedAt,
					state: "needs-info",
				})),
			]);
		} catch (error) {
			this.logger.debug(`Waiting room sync skipped: ${String(error)}`);
		}
	}

	/**
	 * Interpret a structured reply to the gate's confirmation elicitation
	 * (PON-150). Called from the prompted-webhook path BEFORE lane admission,
	 * so `approvedAt` — the SLA clock start — is the answer's arrival, not
	 * whenever a queued resume finally replays. Idempotent under replay:
	 * `recordApproved` only reports the first transition.
	 */
	private async interpretScopeConfirmReply(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const sessionId = webhook.agentSession.id;
		const workspaceId = webhook.organizationId;
		const issueId =
			webhook.agentSession.issue?.id ?? this.sessionIssueId(sessionId);
		if (!this.scopeGatePendingForIssue(workspaceId, issueId)) return;

		const response = webhook.agentActivity?.content?.body ?? "";
		if (!response.trim()) return;

		// Resolve against the options that were actually posted (PON-142's
		// lesson: by the answer, never by fallback). After a restart the
		// pending question is gone from memory — fall back to the canonical
		// labels alone, exact matches only, so a confirmed issue never
		// re-asks just because the box restarted mid-elicitation.
		const pendingQuestion =
			this.askUserQuestionHandler.getPendingQuestion(sessionId);

		// With no pending question AND no record, nothing was ever proposed —
		// record nothing. This is what stops a late answer webhook, arriving
		// after terminal-state cleanup removed the record, from resurrecting
		// an approval for a Done issue that nothing will ever clean up again.
		if (!pendingQuestion && !this.scopeApprovals.get(issueId as string)) {
			return;
		}
		const reply = pendingQuestion
			? isScopeConfirmQuestion(pendingQuestion)
				? interpretScopeConfirmAnswer(pendingQuestion, response)
				: { verdict: "other" as const }
			: interpretCanonicalScopeAnswer(response);
		const verdict = reply.verdict;
		// PON-230: what they typed alongside the option. On a revision it is
		// the revision itself; on an approval it is a caveat the operator
		// brief should carry rather than lose.
		const replyNote = reply.note;

		if (verdict === "approved") {
			const identifier = webhook.agentSession.issue?.identifier;
			if (
				this.scopeApprovals.recordApproved(issueId as string, {
					workspaceId,
					issueIdentifier: identifier,
					...(replyNote !== undefined ? { replyNote } : {}),
				})
			) {
				const record = this.scopeApprovals.get(issueId as string);
				this.logger.event("scope_confirmed", {
					issueId,
					issueIdentifier: identifier,
					workspaceId,
					approvedAt: record?.approvedAt,
					proposedAt: record?.proposedAt,
					revisions: record?.revisions ?? 0,
					// PON-224: approval parks the work — the journal must be able
					// to prove that no implementation followed this line.
					implementationDeferred: record?.implementationDeferred === true,
					hasClientNote: replyNote !== undefined,
				});
				await this.persistScopeApprovals("scope_confirmed");
				// v3.1: the client's lifecycle plan advances to "scope agreed".
				// Their session's native plan is code-driven from here, never
				// the model's task list.
				void this.publishClientLifecyclePlan(webhook.agentSession.id, "agreed");
				// PON-219: this is now the mirror's BIRTH, not a transition on
				// an existing one — the cockpit contains only approved work.
				//
				// Two consequences that were easy to miss. First, this write is
				// the first one, so it has to carry the issue's title and url;
				// the delegation-time create used to supply them, and without
				// them the mirror renders "(untitled)" with no link back — the
				// exact way CKP-1 was left. Second, the internal reading is on
				// the SCOPE record, not on a mirror record that no longer
				// exists before this moment, so it has to be passed through
				// here or PON-169's reading silently stops reaching the board.
				const approvedIssue = webhook.agentSession.issue;
				// PON-224: the birth state is `queued` unconditionally.
				// Approval no longer starts implementation — the work parks
				// until the reviewer delegates the mirror — so a free lane no
				// longer means "active"; nothing is running and nothing will
				// run until that delegation. The lane position, when the
				// scoping session itself is still queued, is kept as detail.
				const queuedPosition = this.laneManager
					.queuedEntriesOf(workspaceId)
					.find((entry) => entry.issueId === issueId)?.position;
				// Wrapped, because this write now happens at the moment consent
				// is recorded rather than as one transition among many. `void`
				// swallows a rejected promise but not a synchronous throw, and
				// the approval is the fact the whole gate exists to capture —
				// a derived view failing must never be able to cost us it.
				try {
					void this.cockpitMirror.upsert(
						{
							issueId: issueId as string,
							issueIdentifier: identifier,
							title:
								approvedIssue?.title ??
								this.agentSessionManager.getSession(sessionId)?.issue?.title,
							url: (approvedIssue as { url?: string } | undefined)?.url,
						},
						workspaceId,
						"queued",
						{
							...(queuedPosition !== undefined
								? { position: queuedPosition }
								: {}),
							// PON-224: notify at birth. Queued work is claimable
							// work now, and a reviewer who only hears about a
							// mirror at in-verification would never learn there
							// is something to start.
							subscriberIds: this.subscribersForWorkspace(workspaceId),
							...(record?.operatorNote !== undefined
								? { operatorNote: record.operatorNote }
								: {}),
							brief: {
								...(record?.clientScope !== undefined
									? { clientScope: record.clientScope }
									: {}),
								...(record?.approvedAt !== undefined
									? { approvedAt: record.approvedAt }
									: {}),
								revisions: record?.revisions ?? 0,
							},
						},
					);
				} catch (error) {
					this.logger.error(
						"Could not create the cockpit mirror at approval:",
						error,
					);
				}
			}
		} else if (verdict === "revision") {
			if (this.scopeApprovals.recordRevised(issueId as string)) {
				this.logger.event("scope_revision_requested", {
					issueId,
					issueIdentifier: webhook.agentSession.issue?.identifier,
					workspaceId,
					revisions: this.scopeApprovals.get(issueId as string)?.revisions,
				});
				await this.persistScopeApprovals("scope_revision_requested");
			}
		} else if (verdict === "canceled") {
			// The client closed the gate. Remove the record: the pending list
			// stays honest (a cancelled gate is not "awaiting"), and a later
			// re-delegation re-engages the gate fresh — the scope was never
			// approved. Idempotent under replay: remove reports the first
			// removal only.
			if (this.scopeApprovals.remove(issueId as string)) {
				this.logger.event("scope_confirm_canceled", {
					issueId,
					issueIdentifier: webhook.agentSession.issue?.identifier,
					workspaceId,
				});
				await this.persistScopeApprovals("scope_confirm_canceled");
				void this.cockpitMirror.close(issueId as string, "scope_canceled");
			}
		}
		// "other" — free text or an ambiguity answer: nothing to record. The
		// reply flows to the session as context.
	}

	/**
	 * The client confirmed a change to work they already have (PON-236).
	 *
	 * Delivered work does not get changed quietly. The client's confirmation
	 * puts it back in the queue as REWORK — at the head of the order, because
	 * a correction to something already delivered outranks a fresh start —
	 * and the reviewer is told, in their inbox, that a finished item has
	 * reopened. It re-enters through exactly the path a first start uses:
	 * `implementationDeferred` back on the scope record, so the reviewer's
	 * delegate gesture starts it and the WIP gate still applies.
	 */
	private async interpretReworkReply(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const sessionId = webhook.agentSession.id;
		const issueId =
			webhook.agentSession.issue?.id ?? this.sessionIssueId(sessionId);
		if (!issueId) return;
		// Only for work that has actually been delivered — otherwise these
		// labels mean nothing and must not move anything.
		const record = this.verificationGate.get(issueId);
		if (!record || record.state !== "delivered") return;
		// Recognised by the canonical label. With the ask still in memory it
		// must be OUR rework ask; after a restart the ask is gone and the
		// canonical "yes" is accepted on its own — the same fallback the
		// scope gate has had since PON-150, for the same reason: a client
		// who confirms a change must never be ignored because the box
		// restarted mid-elicitation.
		const pending = this.askUserQuestionHandler.getPendingQuestion(sessionId);
		if (pending && !isReworkConfirmQuestion(pending)) return;

		const response = webhook.agentActivity?.content?.body ?? "";
		const { confirmed, note } = interpretReworkAnswer(response);
		if (!confirmed) return;

		// Back into the queue by the same door a first start uses.
		this.scopeApprovals.recordReworkRequested(issueId, note);
		// The record leaves "delivered": the rework run's completion is held
		// like a first pass, and approve: refuses until it is. The pull
		// request goes back to draft so the client is not offered a merge
		// button on commits nobody has reviewed.
		this.verificationGate.reopenForRework(issueId);
		void this.redraftPullRequestForRework(issueId, record);
		await this.persistScopeApprovals("rework_requested");
		this.logger.event("client_requested_rework", {
			issueId,
			issueIdentifier: record.issueIdentifier,
			workspaceId: record.workspaceId,
			hasNote: note !== undefined,
		});
		void this.cockpitMirror.upsert(
			{ issueId, issueIdentifier: record.issueIdentifier },
			record.workspaceId,
			"rework",
			{ subscriberIds: this.subscribersForWorkspace(record.workspaceId) },
		);
		// The inbox half — an activity does not reach one, a comment does.
		void this.cockpitMirror.commentOnMirror(
			issueId,
			`**Reopened — the client asked for a change.** ${
				note ? `They said: "${note}"\n\n` : ""
			}It is back at the head of your queue as rework. Delegate this mirror to me and I'll pick it up on the same branch.`,
		);
	}

	/**
	 * Re-admit a session whose question has just been answered (PON-113).
	 *
	 * Returns true when the session may resume immediately. Returns false when
	 * the lane is busy: the answer webhook is queued as a resume entry and
	 * replayed once the lane frees, at which point this returns true and the
	 * pending question resolves.
	 */
	private async admitAnsweredSessionToLane(
		webhook: AgentSessionPromptedWebhook,
		receivedAt: number,
	): Promise<boolean> {
		const sessionId = webhook.agentSession.id;
		const workspaceId = webhook.organizationId;
		if (!this.laneManager.isEnabled(workspaceId)) return true;
		if (this.globalSessionRegistry.getParentSessionId(sessionId)) return true;

		// Ask the lane whether it can admit, rather than comparing against a
		// single holder: with a limit above 1 an occupied lane may still have a
		// free slot, and `acquire` is the only thing that knows the limit.
		if (this.laneManager.isActive(sessionId)) return true;
		if (this.laneManager.acquire(workspaceId, sessionId)) {
			return true;
		}

		// Already queued (a duplicate delivery) — restate position, do not
		// enqueue twice.
		const existingPosition = this.laneManager.positionOf(sessionId);
		if (existingPosition !== null) {
			await this.activityPoster.postQueuedAcknowledgment(
				sessionId,
				workspaceId,
				existingPosition,
			);
			return false;
		}

		const position = this.laneManager.enqueue(workspaceId, {
			sessionId,
			issueId: webhook.agentSession.issue?.id,
			issueIdentifier: webhook.agentSession.issue?.identifier,
			enqueuedAt: new Date().toISOString(),
			webhook,
			kind: "resume",
		});
		// Cockpit (PON-151): an answered session waiting for the lane is
		// queued, position visible.
		if (webhook.agentSession.issue) {
			void this.cockpitMirror.upsert(
				{
					issueId: webhook.agentSession.issue.id,
					issueIdentifier: webhook.agentSession.issue.identifier,
					title: webhook.agentSession.issue.title,
					url: (webhook.agentSession.issue as { url?: string }).url,
				},
				workspaceId,
				"queued",
				{ position },
			);
		}
		try {
			await this.savePersistedStateStrict();
		} catch (error) {
			this.laneManager.removeQueued(sessionId);
			this.logger.event("lane_enqueue_persist_failed", {
				workspaceId,
				sessionId,
			});
			throw error;
		}
		await this.activityPoster.postQueuedAcknowledgment(
			sessionId,
			workspaceId,
			position,
		);
		this.logger.event("session_ack_posted", {
			kind: "prompted",
			queued: true,
			answeredQuestion: true,
			position,
			sessionId,
			elapsedMs: Date.now() - receivedAt,
		});
		return false;
	}

	/**
	 * React to a tenant's credentials failing conclusively (PON-115).
	 *
	 * Deliberately does NOT re-probe: the caller already proved the token is
	 * dead by getting a 401 that a refresh could not repair, and a probe would
	 * use the same dead credentials. Deactivation is idempotent, so repeated
	 * failures from in-flight requests collapse into one teardown.
	 */
	private async handleTenantAccessLost(
		workspaceId: string,
		error: unknown,
	): Promise<void> {
		const wsConfig = this.config.linearWorkspaces?.[workspaceId];
		if (!wsConfig || wsConfig.active === false) return;

		this.logger.event("tenant_access_lost", {
			workspaceId,
			error: error instanceof Error ? error.message : String(error),
		});

		try {
			await this.deactivateTenant(workspaceId, "access_lost");
		} catch (deactivateError) {
			this.logger.error(
				`Failed to deactivate tenant ${workspaceId} after access loss:`,
				deactivateError,
			);
		}
	}

	/**
	 * Probe whether we can still act in a workspace, using that tenant's own
	 * token. Returns true on any inconclusive error so a transient API blip
	 * never deactivates a paying tenant — revocation is confirmed by a clear
	 * signal (auth failure or zero reachable teams), not by absence of one.
	 */
	private async tenantStillHasAccess(workspaceId: string): Promise<boolean> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) return false;

		try {
			const teams = await issueTracker.fetchTeams?.();
			if (teams && Array.isArray(teams.nodes)) {
				return teams.nodes.length > 0;
			}
			// Tracker cannot enumerate teams — fall back to identity, which
			// still fails hard on a revoked token.
			await issueTracker.fetchCurrentUser();
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isAuthFailure = /401|403|unauthor|forbidden|invalid.*token/i.test(
				message,
			);
			if (isAuthFailure) return false;
			this.logger.warn(
				`Access probe for workspace ${workspaceId} was inconclusive; leaving tenant active:`,
				error,
			);
			return true;
		}
	}

	/**
	 * Stop serving a tenant: persist the inactive flag, stop its sessions,
	 * clear its lane, and drop its tracker and activity sinks. Persisted so a
	 * restart does not silently resume work for a revoked workspace.
	 */
	private async deactivateTenant(
		workspaceId: string,
		reason: string,
	): Promise<void> {
		const wsConfig = this.config.linearWorkspaces?.[workspaceId];
		if (!wsConfig || wsConfig.active === false) return;

		wsConfig.active = false;
		wsConfig.revokedAt = new Date().toISOString();
		await this.persistWorkspaceConfig();

		// Stop every session belonging to this tenant's repositories.
		const repoIds = new Set(
			Array.from(this.repositories.values())
				.filter((repo) => repo.linearWorkspaceId === workspaceId)
				.map((repo) => repo.id),
		);
		let stopped = 0;
		for (const [sessionId, repoId] of this.sessionRepositories.entries()) {
			if (!repoIds.has(repoId)) continue;
			const session = this.agentSessionManager.getSession(sessionId);
			// Only sessions that are actually running. sessionRepositories
			// retains every session this process has seen, so stopping all of
			// them would flag long-finished sessions as stopped and report a
			// session count that has nothing to do with what was interrupted.
			if (!session?.agentRunner?.isRunning?.()) continue;
			this.agentSessionManager.requestSessionStop(sessionId);
			session.agentRunner.stop();
			stopped++;
		}

		// Free the lane and drop anything queued for this tenant; no further
		// work should start on its behalf.
		// Release every holder, not just the first: a lane may admit N (PON-139),
		// and a deactivated tenant must not leave slots held by sessions that
		// will never end.
		for (const heldSessionId of this.laneManager.activeSessionsOf(
			workspaceId,
		)) {
			this.laneManager.release(workspaceId, heldSessionId);
		}
		this.clearLaneGrace(workspaceId);
		let dequeued = 0;
		// Release exactly the session takeNext just admitted. Releasing "whichever
		// is active" would, with more than one holder, free the wrong session and
		// leave the drained one holding a slot.
		let drained = this.laneManager.takeNext(workspaceId);
		while (drained) {
			this.laneManager.release(workspaceId, drained.sessionId);
			dequeued++;
			drained = this.laneManager.takeNext(workspaceId);
		}

		this.issueTrackers.delete(workspaceId);

		this.logger.event("tenant_deactivated", {
			workspaceId,
			reason,
			sessionsStopped: stopped,
			queuedDropped: dequeued,
		});
		await this.savePersistedState();
	}

	/**
	 * Whether a webhook's workspace is one this instance serves: configured in
	 * linearWorkspaces or referenced by a repository's linearWorkspaceId.
	 * Fails open only when the config carries no workspace information at all
	 * (legacy setups predating both fields); on any configured instance an
	 * unknown or missing workspace id is rejected.
	 */
	/**
	 * The Linear workspace owning a session, resolved through its repository.
	 * Used to tag log lines per tenant (PON-115); returns undefined for
	 * sessions with no Linear repository (GitHub/Slack) or none recorded yet.
	 */
	private resolveWorkspaceIdForSession(sessionId: string): string | undefined {
		const repoId = this.sessionRepositories.get(sessionId);
		if (!repoId) return undefined;
		return this.repositories.get(repoId)?.linearWorkspaceId;
	}

	private isKnownWorkspace(workspaceId: string | undefined): boolean {
		// A deactivated tenant (access revoked) is not served: its webhooks are
		// dropped exactly like an unknown workspace's.
		const known = new Set<string>(
			Object.entries(this.config.linearWorkspaces ?? {})
				.filter(([, wsConfig]) => wsConfig.active !== false)
				.map(([id]) => id),
		);
		for (const repo of this.repositories.values()) {
			if (repo.linearWorkspaceId) known.add(repo.linearWorkspaceId);
		}
		// Repositories still reference a revoked tenant's workspace, so strip
		// explicitly deactivated ones back out — otherwise the repo loop would
		// silently re-admit a workspace whose access was just revoked.
		for (const [id, wsConfig] of Object.entries(
			this.config.linearWorkspaces ?? {},
		)) {
			if (wsConfig.active === false) known.delete(id);
		}
		if (known.size === 0) return true;
		return workspaceId !== undefined && known.has(workspaceId);
	}

	// ========================================================================
	// SERIALIZED LANES (PON-112)
	// ========================================================================

	/**
	 * A session ended (result message: success, error, or user stop). Release
	 * the lane if this session holds one and start the next queued session.
	 */
	/** Trailing debounce for cockpit-driven state persists (PON-151). */
	private cockpitPersistTimer: NodeJS.Timeout | undefined;
	private scheduleCockpitPersist(): void {
		if (this.cockpitPersistTimer) clearTimeout(this.cockpitPersistTimer);
		this.cockpitPersistTimer = setTimeout(() => {
			this.cockpitPersistTimer = undefined;
			this.savePersistedStateStrict().catch((error) => {
				this.logger.error("Failed to persist cockpit mirrors:", error);
			});
		}, 500);
	}

	/**
	 * Whether an ending session really ends its issue's delegated work
	 * (PON-151). False while: the session was a mention conversation, the
	 * issue's scope gate is still open, other sessions on the issue are
	 * still running or lane-active, or queue entries for the issue remain.
	 */
	private shouldCloseCockpitMirror(
		endingSessionId: string,
		issueId: string,
	): boolean {
		if (this.mentionSessionIds.has(endingSessionId)) return false;
		const gate = this.scopeApprovals.get(issueId);
		if (gate && gate.state !== "approved") return false;
		// PON-224: approved-but-parked work is not over — the session that
		// just ended was the scoping conversation, and the queued mirror IS
		// the ticket the reviewer starts the real work from. Closing it here
		// would erase the work the client just approved.
		if (gate?.implementationDeferred === true) return false;
		// PON-233: delivered work the client is still reviewing is not over
		// either. Any stray session ending on the issue — a follow-up
		// question, say — would otherwise close the mirror out from under a
		// cycle that ends at their merge.
		const delivery = this.verificationGate.get(issueId);
		if (delivery?.mergeWatch && !delivery.mergedAt) return false;
		if (this.laneManager.queuedSessionIdsForIssue(issueId).length > 0) {
			return false;
		}
		const others = this.agentSessionManager.getSessionsByIssueId(issueId);
		for (const other of others) {
			if (other.id === endingSessionId) continue;
			if (
				other.agentRunner?.isRunning?.() ||
				this.laneManager.isActive(other.id)
			) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Cockpit (PON-151): push current queue positions for one workspace to
	 * the mirror after any queue change. Fire-and-forget, never throws.
	 */
	private syncCockpitQueue(workspaceId: string): void {
		for (const entry of this.laneManager.queuedEntriesOf(workspaceId)) {
			if (!entry.issueId) continue;
			void this.cockpitMirror.upsert(
				{ issueId: entry.issueId, issueIdentifier: entry.issueIdentifier },
				workspaceId,
				"queued",
				{ position: entry.position },
			);
		}
	}

	/**
	 * Build the live picture (active lane holders, queued entries, open scope
	 * gates) and hand it to the cockpit for reconciliation (PON-151).
	 */
	private async reconcileCockpitMirror(): Promise<void> {
		try {
			const snapshot = this.laneManager.snapshot();
			const active: Array<{
				issue: { issueId: string; issueIdentifier?: string };
				tenantWorkspaceId: string;
			}> = [];
			const queued: Array<{
				issue: { issueId: string; issueIdentifier?: string };
				tenantWorkspaceId: string;
				position: number;
			}> = [];
			for (const [workspaceId, lane] of Object.entries(snapshot)) {
				for (const sessionId of lane.activeSessionIds) {
					const issueId = this.sessionIssueId(sessionId);
					if (issueId) {
						const session = this.agentSessionManager.getSession(sessionId);
						active.push({
							issue: {
								issueId,
								issueIdentifier: session?.issueContext?.issueIdentifier,
							},
							tenantWorkspaceId: workspaceId,
						});
					}
				}
				for (const entry of this.laneManager.queuedEntriesOf(workspaceId)) {
					if (!entry.issueId) continue;
					queued.push({
						issue: {
							issueId: entry.issueId,
							issueIdentifier: entry.issueIdentifier,
						},
						tenantWorkspaceId: workspaceId,
						position: entry.position,
					});
				}
			}
			// PON-219: reconcile no longer rebuilds mirrors for open scope
			// gates. It used to be the belt-and-braces that made a mirror
			// reappear for anything unapproved, which is precisely the
			// behaviour being removed — and it would have quietly undone the
			// creation guard on the next boot. Those conversations surface in
			// the waiting room instead, which this same boot refreshes.
			const inVerification = this.verificationGate
				.listPending()
				.map((record) => ({
					issue: {
						issueId: record.issueId,
						issueIdentifier: record.issueIdentifier,
					},
					tenantWorkspaceId: record.workspaceId,
				}));
			// PON-224: approved-but-parked work is live work — the queued
			// mirror is the reviewer's ticket to start it, and a reconcile
			// that cannot see it would close it as an orphan on every boot.
			// An issue the lane already accounts for keeps its lane-derived
			// entry (which carries the position); parked covers the rest.
			// v3.1: a mirror-owned run that died with the process. Runners are
			// never resumed on boot, so a link with nothing held and nothing
			// running is an interrupted run, not an active one — reported as
			// Active it sat with nothing running until the NEXT boot closed
			// it as reconciled. Park it again first, so the parked category
			// below picks it up and a re-delegation resumes it.
			for (const link of this.operatorSessions.serialize()) {
				if (!link.ownsDelivery) continue;
				const scope = this.scopeApprovals.get(link.clientIssueId);
				if (!scope || scope.state !== "approved") continue;
				if (scope.implementationDeferred === true) continue;
				if (this.verificationGate.get(link.clientIssueId)) continue;
				const runner = this.agentSessionManager.getSession(
					link.mirrorSessionId,
				)?.agentRunner;
				if (runner?.isRunning?.()) continue;
				this.reparkInterruptedMirrorRun(
					link.clientIssueId,
					link,
					"service_restart",
				);
				const laneWs = this.laneManager.workspaceOf(link.mirrorSessionId);
				if (laneWs && this.laneManager.isActive(link.mirrorSessionId)) {
					this.releaseLaneAndContinue(
						laneWs,
						link.mirrorSessionId,
						"service_restart",
					);
				}
			}
			// v3.1: rework and mid-work needs-info are live states too. Without
			// them a restart demoted rework to In client review (the deferred
			// flag put it in `parked`, the delivered record in `inClientReview`,
			// last write won) and closed a needs-info wait as reconciled.
			const rework = this.verificationGate.listRework().map((record) => ({
				issue: {
					issueId: record.issueId,
					issueIdentifier: record.issueIdentifier,
				},
				tenantWorkspaceId: record.workspaceId,
			}));
			const needsInfo = this.needsInfo
				.listAwaiting()
				.filter(
					(entry) =>
						entry.workspaceId !== undefined &&
						this.scopeApprovals.isApproved(entry.issueId),
				)
				.map((entry) => ({
					issue: {
						issueId: entry.issueId,
						issueIdentifier: entry.issueIdentifier,
					},
					tenantWorkspaceId: entry.workspaceId as string,
				}));
			const accountedFor = new Set([
				...active.map((e) => e.issue.issueId),
				...queued.map((e) => e.issue.issueId),
				...inVerification.map((e) => e.issue.issueId),
				...rework.map((e) => e.issue.issueId),
			]);
			const parked = this.scopeApprovals
				.listDeferred()
				.filter(
					(record) =>
						record.workspaceId !== undefined &&
						!accountedFor.has(record.issueId),
				)
				.map((record) => ({
					issue: {
						issueId: record.issueId,
						issueIdentifier: record.issueIdentifier,
					},
					tenantWorkspaceId: record.workspaceId as string,
				}));
			// PON-233: delivered-but-unmerged work is LIVE. Reconcile closes
			// anything it cannot see, into Canceled, and an item can sit in
			// client review for days — so leaving this out would destroy the
			// record of a delivery on the first restart after it.
			const inClientReview = this.verificationGate
				.awaitingMergeIssueIds()
				.flatMap((clientIssueId) => {
					const r = this.verificationGate.get(clientIssueId);
					return r && r.state === "delivered"
						? [
								{
									issue: {
										issueId: clientIssueId,
										issueIdentifier: r.issueIdentifier,
									},
									tenantWorkspaceId: r.workspaceId,
								},
							]
						: [];
				});
			await this.cockpitMirror.reconcile({
				active,
				queued,
				inVerification,
				parked,
				inClientReview,
				rework,
				needsInfo,
			});
			// PON-219: prune scope records whose client issue is already over
			// before rebuilding the list.
			//
			// The waiting room renders listPending() and holds no state of its
			// own, which is what keeps it honest — but it inherits whatever
			// the record store believes. A record can outlive its issue when
			// the terminal webhook was missed, and the row then ages forever
			// on the operator's stall list and re-announces on every restart.
			// Reconciliation repairs drift rather than preserving it; this is
			// the same read-Linear-not-the-map rule the mirror already lives
			// by, applied to the one store the room depends on.
			await this.pruneEndedScopeConversations();
			this.syncScopeWaitingRoom();
			// PON-212: reconcile re-upserts an in-verification mirror through
			// the plain path, which carries no review block — so the preview
			// link, the changed files and the held summary only ever appeared
			// when a session ENDED. After a restart (or a release that changes
			// what the block contains) the mirror sat there without the one
			// thing the reviewer opens it for. Recompose them properly.
			for (const entry of inVerification) {
				this.mirrorInVerification(entry.issue.issueId);
			}
		} catch (error) {
			this.logger.error("Cockpit reconciliation failed:", error);
		}
	}

	// ========================================================================
	// VERIFY-BEFORE-CLIENT-SEES (PON-152)
	// ========================================================================

	/**
	 * Default on; explicit false opts a workspace out — same shape as the
	 * scope gate. The gate additionally requires a working approval surface:
	 * without a configured cockpit there is no notification and no approve
	 * action, and the cockpit's own workspace is never mirrored — holding a
	 * summary nobody can ever release is worse than posting it (review
	 * finding, 2026-08-24).
	 */
	private verificationGateEnabled(workspaceId: string | undefined): boolean {
		if (!workspaceId) return false;
		const cockpit = this.config.cockpit;
		if (!cockpit) return false;
		if (workspaceId === cockpit.linearWorkspaceId) return false;
		return (
			this.config.linearWorkspaces?.[workspaceId]?.verifyBeforeDelivery !==
			false
		);
	}

	/**
	 * Is this session's work still held from its client? (PON-221)
	 *
	 * Governs the session SURFACE — the external-URL buttons — where the
	 * verification gate governs the summary. Same question, different
	 * channel, so the same answer: while a delivery is held for review, the
	 * client gets neither the words nor the links.
	 *
	 * An operator session is excluded FIRST and explicitly. Its subject is
	 * the client's repository, so every workspace lookup below would resolve
	 * against the CLIENT's workspace and hold the links on the one surface
	 * built to show them — the same trap `clientQuietSession` documents, and
	 * the reason Harold has a preview link to click at all.
	 */
	/**
	 * Issues whose entry into verification has been announced (PON-221).
	 *
	 * In memory only, deliberately: after a restart nobody has been told
	 * whose move it is in THIS process, and one sign-off on the way back up
	 * is a reminder rather than noise. It is the three-minute repeat that had
	 * to stop, not the reminder.
	 */
	private verificationSignedOff = new Set<string>();

	private linksHeldForSession(sessionId: string): boolean {
		if (this.operatorSessions.isOperatorSession(sessionId)) return false;
		const workspaceId =
			this.resolveWorkspaceIdForSession(sessionId) ??
			this.laneManager.workspaceOf(sessionId);
		if (!workspaceId) return false;
		if (!this.verificationGateEnabled(workspaceId)) return false;

		// Every exemption below mirrors one in `holdCompletionForVerification`,
		// and they must stay in step: that method decides whether a delivery
		// is ever held, and `releaseHeldLinks` only runs when one is released.
		// Hold on a session it exempts and the links have no release event
		// coming — held forever is the same as lost. This is the ONE way this
		// gate can be too wide, so it is checked rather than assumed.
		const session = this.agentSessionManager.getSession(sessionId);
		// Non-Linear (GitHub/GitLab PR-comment) sessions answer on their own
		// thread and are never gated.
		if (session?.issueContext?.trackerId !== "linear") return false;
		// Mentions and child sessions are conversation, not the deliverable.
		if (this.mentionSessionIds.has(sessionId)) return false;
		if (this.globalSessionRegistry.getParentSessionId(sessionId)) return false;
		// Already delivered: the work is released, so links flow normally
		// again — a post-delivery follow-up is not work in progress.
		const issueId = this.sessionIssueId(sessionId);
		if (!issueId) return false;
		if (this.verificationGate.get(issueId)?.state === "delivered") return false;
		return true;
	}

	/**
	 * The final-response interceptor body (PON-152). Returns true when the
	 * summary was stored for verification instead of posted.
	 */
	private holdCompletionForVerification(
		sessionId: string,
		content: string,
		isError: boolean,
	): boolean {
		// Resolve the workspace from the session's repository, NOT from the
		// lane: in the runner-already-stopped ordering the lane has released
		// (and dropped its session mapping) before this interceptor runs.
		const workspaceId =
			this.resolveWorkspaceIdForSession(sessionId) ??
			this.laneManager.workspaceOf(sessionId);
		// PON-208: an operator session's completion is a report to Harold in
		// his own thread, not a deliverable awaiting his approval. Holding it
		// would mint a SECOND pending delivery for one issue and overwrite the
		// summary the client is actually owed. The existing held record stays
		// pending — release is still only an explicit `approve:`.
		//
		// PON-225 narrows that to operator sessions which do NOT own the
		// delivery. A session started from a queued mirror is the client's
		// implementation run wearing an operator session's clothes: its
		// closing summary IS the deliverable, so the gate must hold it. The
		// reasoning above still holds for every other operator turn.
		const operatorLink = this.operatorSessions.get(sessionId);
		if (operatorLink && !operatorLink.ownsDelivery) return false;
		const issueId = this.sessionIssueId(sessionId);
		if (!issueId || !this.verificationGateEnabled(workspaceId)) return false;
		const session = this.agentSessionManager.getSession(sessionId);
		// Only Linear delegations are gated. GitHub/GitLab PR-comment
		// sessions answer on the PR thread through their own reply path —
		// gating their SDK result here would mint phantom held records for
		// synthetic issue ids while the real reply ships anyway (review
		// finding, 2026-08-24).
		if (session?.issueContext?.trackerId !== "linear") return false;
		// Mentions and child sessions are conversation, not the deliverable.
		if (this.mentionSessionIds.has(sessionId)) return false;
		if (this.globalSessionRegistry.getParentSessionId(sessionId)) return false;
		// Already delivered for this issue: a post-delivery follow-up result
		// posts normally rather than vanishing.
		if (this.verificationGate.get(issueId)?.state === "delivered") {
			return false;
		}
		// PON-224: implementation is parked — this completion is the queue
		// acceptance confirmation (or a follow-up answer), not a deliverable;
		// holding it would strand the client's confirmation behind a review
		// of work that does not exist. Deliberately NOT mirrored into
		// `linksHeldForSession`, breaking the stay-in-step rule the two share:
		// a parked session should mint no links, and if one leaks anyway the
		// release event still comes at eventual delivery — held is safe,
		// leaked work-in-progress is not. The exemption is scoped to the flag,
		// which only ever exists between approval and implementation start,
		// so a `reject:`-resumed regeneration (approved, flag long cleared)
		// is still held exactly as before.
		if (this.scopeApprovals.isImplementationDeferred(issueId)) {
			return false;
		}

		// PON-235: prefer the summary the run HANDED OVER for the client over
		// the one scraped from its final message. Twice a run has opened that
		// message with a line addressed to the reviewer and the client
		// received it, because the interceptor captures the whole thing.
		// Only a summary recorded during THIS run counts — the field
		// persists, and a previous run's text is exactly the stale-artefact
		// problem the hand-off guard already fixed once.
		const recorded = this.scopeApprovals.get(issueId);
		const recordedAt = recorded?.clientSummaryAt;
		const startedAt = operatorLink?.startedAt;
		const handedOver =
			recorded?.clientSummary &&
			recordedAt &&
			(!startedAt || recordedAt > startedAt)
				? recorded.clientSummary
				: undefined;
		if (handedOver) {
			this.logger.event("client_summary_from_handover", {
				issueId,
				issueIdentifier: session?.issueContext?.issueIdentifier,
			});
		}
		this.verificationGate.recordPending(issueId, {
			workspaceId: operatorLink?.clientWorkspaceId ?? (workspaceId as string),
			issueIdentifier: session?.issueContext?.issueIdentifier,
			// PON-225: the record names the session the DELIVERY posts to, not
			// the one that produced it. `deliverVerifiedWork` posts to
			// `record.sessionId`; storing the mirror session here would deliver
			// the client's work onto the cockpit thread and mark it delivered
			// with the client none the wiser. Everything else that reads this
			// field — the origin ref for PR-readying, the branch in the
			// checkout instructions — wants the client side too.
			sessionId: operatorLink?.clientSessionId ?? sessionId,
			summary: handedOver ?? content,
			isError,
		});
		this.logger.event("verification_pending", {
			issueId,
			issueIdentifier: session?.issueContext?.issueIdentifier,
			workspaceId,
			isError,
			prUrls: (this.verificationGate.get(issueId)?.prUrls ?? []).join(" "),
		});
		void this.persistScopeApprovals("verification_pending");
		// The mirror transition belongs to the ACTUAL session end. When the
		// runner already stopped (result processed after stream end), fire it
		// here; the still-streaming case is handled by handleLaneSessionEnded
		// when runner_complete lands. Both are idempotent.
		if (session?.agentRunner?.isRunning?.() !== true) {
			this.mirrorInVerification(issueId);
		}
		return true;
	}

	/**
	 * The allowed-reviewer set (PON-173): `cockpit.reviewers` when declared
	 * (first entry = default assignee), else the legacy single
	 * `cockpit.assigneeId`. Empty = no approval surface.
	 */
	private cockpitReviewers(): string[] {
		const cockpit = this.config.cockpit;
		if (cockpit?.reviewers?.length) return cockpit.reviewers;
		return cockpit?.assigneeId ? [cockpit.assigneeId] : [];
	}

	/**
	 * Who to notify about a tenant's mirrors (PON-173, re-pointed by PON-211).
	 *
	 * The routing intent is unchanged — a client whose reviews belong to one
	 * reviewer notifies that reviewer, everyone otherwise. What changed is the
	 * mechanism: this used to pick an ASSIGNEE, which made the mirror overwrite
	 * a reviewer's claim on every transition. Subscribers carry the same
	 * signal (Linear notifies subscribers in the Inbox) and carry no claim.
	 */
	private subscribersForWorkspace(
		tenantWorkspaceId: string | undefined,
	): string[] {
		const cockpit = this.config.cockpit;
		const routed =
			tenantWorkspaceId && cockpit?.assignments?.[tenantWorkspaceId];
		return routed ? [routed] : this.cockpitReviewers();
	}

	/**
	 * The preview link for the delivery footer (PON-171): the first Vercel
	 * deployment URL the held summary mentions. Absent = omitted honestly.
	 */
	/**
	 * The tenant's Vercel Protection Bypass secret (PON-213).
	 *
	 * Read at the point of use and never held anywhere else, so a rotation is
	 * a config edit that hot-reload picks up with no restart. Never logged,
	 * never journalled by value, never written into a worktree.
	 */
	/**
	 * Has this client confirmed their preview database is not production
	 * (PON-215)? Absent means unconfirmed, never "fine".
	 */
	private previewDataSeparationFor(
		workspaceId: string | undefined,
	): "confirmed" | "unconfirmed" | "reads-production" {
		if (!workspaceId) return "unconfirmed";
		return (
			this.config.linearWorkspaces?.[workspaceId]?.previewDataSeparation ??
			"unconfirmed"
		);
	}

	/**
	 * Which accounts the reviewer can sign in with (PON-215).
	 *
	 * Rendered next to the preview link because that is the moment it is
	 * needed: a reviewer who has to go hunting for a login in an old thread
	 * reviews by looking rather than by using, which is the difference the
	 * whole preview exists to make.
	 */
	private testAccountLines(workspaceId: string | undefined): string[] {
		const accounts = workspaceId
			? this.config.linearWorkspaces?.[workspaceId]?.previewTestAccounts
			: undefined;
		if (!accounts?.length) return [];
		// Sits directly under the preview link, because the link alone gets a
		// reviewer as far as the application's own login screen and no
		// further (PON-221). "The preview opens" and "the reviewer can use
		// the preview" are different questions.
		return [
			"**Sign in with:** " +
				accounts
					.map((a) =>
						a.password
							? `${a.label} \`${a.username}\` / \`${a.password}\``
							: `${a.label} \`${a.username}\``,
					)
					.join(" · "),
		];
	}

	private previewBypassTokenFor(
		workspaceId: string | undefined,
	): string | undefined {
		if (!workspaceId) return undefined;
		return this.config.linearWorkspaces?.[workspaceId]?.previewBypassToken;
	}

	private extractPreviewUrl(summary: string): string | undefined {
		return /https?:\/\/[\w][\w.-]*vercel\.app[\w\-./?=&#%]*/i.exec(
			summary,
		)?.[0];
	}

	/**
	 * The ONE preview link the client is given (PON-238).
	 *
	 * It used to be scraped out of the summary's prose and then bypassed. That
	 * put TWO links in front of the client: the prose kept its own bare copy,
	 * which redirects to a hosting-provider login they have no account for,
	 * beside a footer copy that works. Worse, they could point at different
	 * builds — the prose link is whatever the run happened to write down,
	 * which is the deployment of the commit it finished on, while the reviewer
	 * verified the deployment of the head as it now stands.
	 *
	 * So the link is RESOLVED for the commit the summary describes
	 * (`capturedHeadSha`, the same fact the staleness gate is keyed on) rather
	 * than read out of prose — the PON-235 move applied to the link: a
	 * client-facing artefact should not depend on a model writing the right
	 * URL in the right place.
	 *
	 * Falls back to the scraped link (bypassed) rather than shipping none: a
	 * delivery with no way to see the work is worse than one whose link came
	 * from prose, and legacy records have no captured head at all.
	 */
	private async clientPreviewUrl(
		record: VerificationRecord,
		originRef: { owner: string; repo: string } | undefined,
	): Promise<string | undefined> {
		const bypass = this.previewBypassTokenFor(record.workspaceId);
		const sha = record.capturedHeadSha;
		if (originRef && sha) {
			try {
				const token = await this.mintGitHubTokenForRepo(
					originRef.owner,
					originRef.repo,
				);
				if (token) {
					const preview = await fetchPreviewDeployment(
						token,
						originRef,
						sha,
						undefined,
						bypass,
					);
					// Only a READY deployment is offered. A building or failed
					// one has no url, and a link that 404s in front of the
					// client teaches them the link lies.
					if (preview?.state === "ready" && preview.url) return preview.url;
				}
			} catch (error) {
				this.logger.debug(
					`Could not resolve the delivery preview: ${String(error)}`,
				);
			}
		}
		return (
			withPreviewBypass(this.extractPreviewUrl(record.summary) ?? "", bypass) ||
			undefined
		);
	}

	/**
	 * No bare protected preview URL ever reaches the client (PON-238).
	 *
	 * The footer's link is built with the bypass, but the held summary is
	 * posted VERBATIM, and a run that wrote a preview URL into its own prose
	 * wrote the bare one. Harold followed such a link: it 302s to the hosting
	 * provider's login page, which the client cannot pass.
	 *
	 * Runs are now asked to leave links out of the client summary entirely, so
	 * on a regenerated summary this finds nothing. It exists for the ones
	 * already held under the old scraping path, where the alternative is
	 * shipping a link we know is dead.
	 */
	private bypassPreviewLinksIn(
		summary: string,
		workspaceId: string | undefined,
		issueId: string,
	): string {
		const bypass = this.previewBypassTokenFor(workspaceId);
		if (!bypass) return summary;
		return summary.replace(
			/https?:\/\/[\w][\w.-]*vercel\.app[\w\-./?=&#%]*/gi,
			(url) => {
				// Sentence punctuation after a URL is not part of it: ".../dashboard."
				// rewritten whole hands the client a 404.
				const trailing = /[.,;:!?)]+$/.exec(url)?.[0] ?? "";
				const bare = trailing ? url.slice(0, -trailing.length) : url;
				// Opaque when the box can resolve it; the credential stays here.
				return (
					this.opaquePreviewLink(
						withPreviewBypass(bare, bypass),
						issueId,
						workspaceId,
					) + trailing
				);
			},
		);
	}

	/**
	 * Remove the pull-request and preview links from a held client summary
	 * (cosmetic, 2026-09-02). The delivery footer carries each link exactly
	 * once — "See it working" / "To take it: merge …" — so a summary that also
	 * names them shows the client every link twice. The run is asked to omit
	 * them; this makes it certain. It drops a line that is only a labelled link
	 * ("Preview: …", "Pull request: …", a bare URL) and a "you can see it here:"
	 * lead-in whose links it just removed, then collapses the gap.
	 */
	private stripDeliveryLinks(summary: string): string {
		const PATTERN =
			"https?:\\/\\/(?:[^\\s)]*(?:vercel\\.app|\\/preview\\/)[^\\s)]*|github\\.com\\/[^\\s)]+\\/pull\\/\\d+)";
		const kept: string[] = [];
		for (const line of summary.split("\n")) {
			if (new RegExp(PATTERN, "i").test(line)) {
				const rest = line.replace(new RegExp(PATTERN, "gi"), "").trim();
				const labelOnly =
					/^(?:\*\*|__)?\s*(?:preview|pull request|pr|link|see it working|to take it)?\s*(?:\*\*|__)?\s*[:>*_.—-]*$/i.test(
						rest,
					);
				if (labelOnly) continue;
			}
			kept.push(line);
		}
		const out: string[] = [];
		for (let i = 0; i < kept.length; i++) {
			const line = kept[i] ?? "";
			const isLeadIn =
				/^\s*(?:you can see it here|here(?:'?s)? (?:where|the)\b[^:]*|see (?:it|the change)\b[^:]*)\s*[:.]?\s*$/i.test(
					line,
				);
			if (isLeadIn && (kept[i + 1] ?? "").trim() === "") continue;
			out.push(line);
		}
		return out
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	/** Upsert the cockpit mirror to in-verification, assigned, with the held summary. */
	/**
	 * End the mirror's narration turn in plain words (PON-221).
	 *
	 * A Linear agent session that simply stops posting is marked `stale`, and
	 * Linear renders that to the reviewer as **"Stopped responding"** — which
	 * reads like a crash. What actually happened is that the agent finished
	 * its turn and it is now someone else's move. Harold read it as a fault,
	 * which is the correct reading of those words and the wrong picture of the
	 * state.
	 *
	 * So every path that ends a turn says what state the work is in and whose
	 * move it is. Posted as a `response`, not a thought: the activity TYPE is
	 * what tells Linear the turn completed, so a thought here would leave the
	 * session looking hung no matter how good the sentence was.
	 *
	 * Best-effort throughout — a missing sign-off must never hold up the work
	 * it is describing.
	 */

	private mirrorInVerification(issueId: string): void {
		const record = this.verificationGate.get(issueId);
		if (!record || record.state !== "in-verification") return;
		// The composition needs two round trips (the PRs' draft state and the
		// repo's origin), so it runs detached — the caller is a synchronous
		// session-end path and a mirror write has never been allowed to hold
		// one up.
		this.mirrorComposition = this.mirrorComposition
			.then(() => this.composeVerificationMirror(issueId))
			.then(() => this.signOffIntoVerification(issueId))
			.catch((error) => {
				this.logger.error("Failed to compose the verification mirror:", error);
			});
	}

	/**
	 * Say the turn ended — exactly once per entry into verification (PON-221).
	 *
	 * `mirrorInVerification` is NOT a transition hook. It also runs from the
	 * mirror refresh tick (every 3 minutes, for every pending delivery) and
	 * from boot reconcile, because re-composing a mirror is idempotent. A
	 * sign-off is not: chained there unguarded, it posted "Finished this turn
	 * — over to you" onto the reviewer's thread every three minutes for as
	 * long as the work sat unapproved. The surface built to be noticed is the
	 * one that must never cry wolf.
	 *
	 * The record's own lifecycle is the key: cleared when the work leaves
	 * verification (delivered, or rejected back to the agent), so a second
	 * round of review signs off again — which is correct, it is a second turn.
	 */
	private signOffIntoVerification(issueId: string): void {
		if (this.verificationSignedOff.has(issueId)) return;
		// Persisted on the record as well (v3.1): the set is in-memory, and
		// boot reconcile recomposes every held mirror, so each restart
		// re-posted the hand-off and the "Ready for review" comment for every
		// held item — a fresh inbox ping per deploy for work nobody touched.
		if (!this.verificationGate.markSignedOff(issueId)) return;
		this.verificationSignedOff.add(issueId);
		void this.persistScopeApprovals("verification_signed_off");
		// PON-228: work started from the mirror ran on its OWN thread, and
		// that is the thread the reviewer is standing in — so the sign-off
		// belongs there, not on the narration thread beside it.
		const link = this.operatorSessions.forClientIssue(issueId);
		if (link?.ownsDelivery) {
			void this.handOffToReviewer(issueId, link);
			return;
		}
		// v3.1 (requirement A): status goes to the inbox, never to a thread.
		void this.cockpitMirror.commentOnMirror(
			issueId,
			"**Finished this turn — over to you.** The work is complete and held; nothing has gone to the client. Read the summary and links, then `approve:` to release it, `reject: <feedback>` to send it back, or just say what you want changed.",
		);
	}

	/**
	 * Close the implementation turn with a report written for the reviewer
	 * (PON-228).
	 *
	 * Three failures shared one cause. The verification gate suppresses the
	 * final response — correctly, it is the client's and it is held — but a
	 * Linear turn is closed only BY a response, so the mirror session was
	 * left running forever: no finished moment, the reviewer's own messages
	 * queueing behind a turn that never ended, and no notification that
	 * anything was ready. The work was done and the surface could not say so.
	 *
	 * So the machinery posts the reviewer's half. Deliberately a different
	 * register from the held client summary, which is untouched: this one
	 * names commits, files and blockers, because its reader is technical and
	 * about to review a diff. The two audiences finally get one message each.
	 */
	/**
	 * Our own lifecycle clock (2026-09-02). Linear's session timer counts from
	 * the thread's birth (the mirror's auto-session), not from delegation —
	 * agentSessionUpdate has no startedAt to correct it, and reusing the birth
	 * thread is requirement A — so the native number is thread age and THESE
	 * are the authoritative ones, read from the records the flow already
	 * stamps. Build time is delegation -> build end; queue wait is scope
	 * approval -> delegation; cycle is scope approval -> merge.
	 */
	private lifecycleTiming(
		issueId: string,
		link?: OperatorSessionLink,
	): { queueWait?: string; buildTime?: string; cycle?: string } {
		const scope = this.scopeApprovals.get(issueId);
		const record = this.verificationGate.get(issueId);
		const startedAt =
			link?.startedAt ??
			this.operatorSessions.forClientIssue(issueId)?.startedAt;
		const approvedAt = scope?.approvedAt;
		const heldAt = record?.completedAt;
		const mergedAt = record?.mergedAt;
		const span = (a?: string, b?: string): string | undefined =>
			a && b && Date.parse(b) >= Date.parse(a)
				? formatLifecycleDuration(Date.parse(b) - Date.parse(a))
				: undefined;
		return {
			queueWait: span(approvedAt, startedAt),
			buildTime: span(startedAt, heldAt),
			cycle: span(approvedAt, mergedAt),
		};
	}

	private async handOffToReviewer(
		issueId: string,
		link: OperatorSessionLink,
	): Promise<void> {
		const record = this.verificationGate.get(issueId);
		if (!record) return;
		const tracker = this.issueTrackers.get(link.cockpitWorkspaceId);
		try {
			const [startHere, prs, checkout] = await Promise.all([
				this.buildStartHereBlock(record.prUrls, record.workspaceId),
				this.describePullRequests(record.prUrls),
				this.buildCheckoutInstructions(issueId),
			]);
			// The session's own hand-off, if it left one. Everything else here
			// is fact; this is the part only the run can know — why it made
			// the calls it made, and what it wants a human to decide.
			//
			// It must be from THIS run. The same field holds the pre-approval
			// internal reading, and on CKP-22 that scoping-time note appeared
			// under "From the run" — a note about what the work was going to
			// be, presented as an account of what it turned out to be. Only a
			// note recorded after the work started qualifies.
			const scopeRecord = this.scopeApprovals.get(issueId);
			const noteAt = scopeRecord?.operatorNoteAt;
			const handOff =
				noteAt && noteAt > link.startedAt
					? scopeRecord?.operatorNote
					: undefined;
			// v3.1 (Harold's ruling): a background task never blocks delivery,
			// so any that were still running when the work finished were cut
			// off with it. Name them, so the reviewer knows what stopped —
			// a dev server or a watch the run left up is now down.
			const terminated = this.agentSessionManager.getTerminatedBackgroundTasks(
				link.mirrorSessionId,
			);
			const terminatedNote =
				terminated.length > 0
					? `\n**Background tasks stopped with the run** (a delivery is a finished state): ${terminated
							.map(
								(task) =>
									`\`${(task.command ?? task.description ?? task.type)
										.replace(/\s+/g, " ")
										.slice(0, 80)}\``,
							)
							.join(", ")}`
					: "";
			const timing = this.lifecycleTiming(issueId, link);
			const timingLine =
				timing.buildTime || timing.queueWait
					? `**Timing:** ${[
							timing.buildTime ? `built in ${timing.buildTime}` : "",
							timing.queueWait ? `queued ${timing.queueWait} first` : "",
						]
							.filter(Boolean)
							.join(
								" · ",
							)}. _(Our clock, from delegation; Linear's timer shows thread age.)_`
					: "";
			const body = [
				`**Finished — over to you.** The work is complete and held; nothing has gone to the client.${
					record.isError ? " **The session ended with an error.**" : ""
				}`,
				record.capturedHeadSha ? `Commit \`${record.capturedHeadSha}\`` : "",
				timingLine,
				prs,
				startHere,
				handOff ? `\n**From the run:**\n\n${handOff}` : "",
				terminatedNote,
				checkout ? `\n**Work on it yourself**\n\n${checkout}` : "",
				"\n`approve: <notes>` delivers it · `reject: <feedback>` sends it back · `mine` hands me the branch · `ask client: <question>` is the only thing that reaches them. Plain instructions are fine — say what you want changed and I'll do it on this same branch.",
			]
				.filter(Boolean)
				.join("\n");
			await tracker?.createAgentActivity?.({
				agentSessionId: link.mirrorSessionId,
				content: { type: "response", body },
			});
			this.logger.event("reviewer_handoff_posted", {
				clientIssueId: issueId,
				issueIdentifier: record.issueIdentifier,
				mirrorSessionId: link.mirrorSessionId,
				hasRunHandOff: Boolean(handOff),
			});
		} catch (error) {
			this.logger.error("Could not hand off to the reviewer:", error);
		}
		// The inbox half. An agent activity does not notify; a comment on an
		// issue they are assigned to does, and that is the whole point of
		// saying it twice.
		void this.cockpitMirror.commentOnMirror(
			issueId,
			`**Ready for review** — ${record.issueIdentifier ?? "this work"} is complete and held. Nothing has gone to the client.${
				record.prUrls.length ? `\n\n${record.prUrls.join("\n")}` : ""
			}`,
		);
	}

	/**
	 * The tail of the detached mirror compositions.
	 *
	 * Chained rather than parallel so two transitions in quick succession
	 * cannot land out of order, and awaitable so a test can assert on the
	 * write instead of racing a timer.
	 */
	private mirrorComposition: Promise<void> = Promise.resolve();

	/**
	 * Last review block written per issue (PON-212).
	 *
	 * The block is refreshed on a clock, so it has to be able to decide that
	 * nothing changed — otherwise every tick rewrites the description and the
	 * reviewer's issue fills with activity noise.
	 */
	private lastReviewBlock = new Map<string, string>();

	private async composeVerificationMirror(issueId: string): Promise<void> {
		const record = this.verificationGate.get(issueId);
		if (!record || record.state !== "in-verification") return;
		const checkout = await this.buildCheckoutInstructions(issueId);
		// PON-210: record which commit this summary describes. Runs at the
		// first composition after capture and never again (first attempt
		// wins), so later refresh ticks cost nothing and cannot re-stamp it.
		await this.captureSummaryHead(issueId, record);
		// PON-223 punch list (token hygiene): the reviewer's preview link is
		// published as a SESSION link rather than written into the persisted
		// description. Same access, same click, but the client's bypass value
		// stops being carried in body text that every later transition
		// rewrites and every read of the issue prints.
		let previewForSession: string | undefined;
		const startHere = await this.buildStartHereBlock(
			record.prUrls,
			record.workspaceId,
			(url) => {
				previewForSession = url;
			},
		);
		const note = [
			"---",
			"**Held for review.** Reply on this issue to work on it with me — plain instructions are fine. `approve: <notes>` delivers it to the client, `reject: <feedback>` sends it back, `mine` hands me off the branch, `ask client: <question>` is the only thing that reaches them.",
			await this.describePullRequests(record.prUrls),
			startHere,
			record.isError ? "**The session ended with an error.**" : "",
			// The blank line is part of the heading, not its own element
			// (PON-238). It used to be a bare `""`, which `.filter(Boolean)`
			// removed — so the heading landed on the line directly after the
			// last `Files changed` bullet and Markdown read it as a
			// continuation of that list item. The client summary was rendered
			// as though it belonged to the last file, which is why a reviewer
			// looking for it on the mirror could not find it.
			"\n**What the session reported:**",
			record.summary.length > 3000
				? `${record.summary.slice(0, 3000)}\n\n*(truncated — full summary delivered on approval)*`
				: record.summary,
			checkout ? `\n---\n\n**Work on it yourself**\n\n${checkout}` : "",
		]
			.filter(Boolean)
			.join("\n");
		// Nothing changed since the last render — do not rewrite the body.
		if (this.lastReviewBlock.get(issueId) === note) return;
		this.lastReviewBlock.set(issueId, note);
		void this.cockpitMirror.upsert(
			{ issueId, issueIdentifier: record.issueIdentifier },
			record.workspaceId,
			"in-verification",
			{
				// PON-211: subscribe the reviewers, never assign them. The
				// assignee field is the claim, and a reviewer's claim must
				// survive every later transition — which it cannot if the
				// mirror re-stamps it. Assignment auto-subscribes in Linear,
				// so a claimed mirror keeps its notifications either way.
				subscriberIds: this.subscribersForWorkspace(record.workspaceId),
				note,
				// The PR links join the persistent operator brief (PON-170) —
				// unlike `note`, they survive later transitions.
				...(record.prUrls.length ? { brief: { addLinks: record.prUrls } } : {}),
			},
		);

		// The Preview button on the reviewer's own thread. Best-effort and
		// last: the review block is the deliverable here, and a mirror that
		// cannot take a session link must still get its description.
		if (previewForSession) {
			const link = this.operatorSessions.forClientIssue(issueId);
			const cockpitWs = this.config.cockpit?.linearWorkspaceId;
			if (link?.mirrorSessionId && cockpitWs) {
				try {
					await this.issueTrackers
						.get(cockpitWs)
						?.updateAgentSession?.(link.mirrorSessionId, {
							addedExternalUrls: [
								{
									url: this.opaquePreviewLink(
										previewForSession,
										issueId,
										link.clientWorkspaceId,
									),
									label: "Preview",
								},
							],
						});
				} catch (error) {
					this.logger.debug(
						`Could not publish the reviewer's preview link: ${String(error)}`,
					);
				}
			}
		}
	}

	/**
	 * What the reviewer needs before touching anything (PON-212).
	 *
	 * The preview to click, and the files that changed. Both are FACTS read
	 * from GitHub rather than claims from the session — a summary can be
	 * wrong about which files it touched; the PR cannot.
	 *
	 * Best-effort throughout: this block is the reason to open the mirror, but
	 * it is not worth losing the mirror write that carries everything else.
	 */
	private async buildStartHereBlock(
		prUrls: string[],
		workspaceId: string | undefined,
		/** Receives the tokenized preview URL so the caller can publish it as
		 * a session link instead of persisting it in the description. */
		onPreviewUrl?: (url: string) => void,
	): Promise<string> {
		const first = prUrls.map(parsePullRequestUrl).find(Boolean);
		if (!first) return "";
		try {
			const token = await this.mintGitHubTokenForRepo(first.owner, first.repo);
			if (!token) return "";
			const pr = await this.fetchPullRequestFacts(token, first);
			if (!pr) return "";
			// PON-215: refuse to hand over a preview we believe carries the
			// client's real customer data.
			//
			// We cannot check this — it lives in a dashboard we have no access
			// to — so it is what they told us at onboarding, and silence means
			// unconfirmed. Unconfirmed is treated as unsafe: reviewing anyway
			// would make "we never touch your production data" quietly false
			// for exactly the client who bought us for it.
			// The changed files are worth reading whether or not the preview can
			// be shown — a withheld preview makes the diff the ONLY way to
			// review, so this is when it matters most.
			const files = pr.files.length
				? [
						"",
						`**Files changed** (${pr.files.length}${pr.truncated ? "+" : ""}):`,
						...pr.files
							.slice(0, 15)
							.map((f) => `- \`${f.path}\` (+${f.additions}/-${f.deletions})`),
						pr.files.length > 15
							? `- …and ${pr.files.length - 15} more on the PR`
							: "",
					]
				: [];

			const separation = this.previewDataSeparationFor(workspaceId);
			if (separation !== "confirmed") {
				return [
					separation === "reads-production"
						? "**Preview: withheld** — this client's preview runs against their production database, so reviewing on it would mean looking at real customer records. Review from the diff, and say on delivery what you could not exercise."
						: "**Preview: withheld** — we have not confirmed this client's preview uses a database separate from production, and unconfirmed is treated as unsafe. Ask them, or review from the diff and say on delivery what you could not exercise.",
					...files,
				]
					.filter(Boolean)
					.join("\n");
			}

			// PON-213: the bypass goes IN to the fetch, not on after it. The
			// reachability probe has to run against the link we publish —
			// appending the bypass afterwards left the state decided by a
			// probe of the bare URL, so a link that opens rendered next to
			// "it asks for a login" and an instruction to change a Vercel
			// setting that was no longer the problem. Without a token this is
			// unchanged behaviour for an unconfigured client.
			const preview = await fetchPreviewDeployment(
				token,
				first,
				pr.headSha,
				undefined,
				this.previewBypassTokenFor(workspaceId),
			);
			// The client's bypass value is a credential, and a description is
			// the worst place to keep one: it is persisted, carried across
			// every later transition, and surfaced verbatim by any read of the
			// issue — it reached this session's own terminal output twice that
			// way. So the tokenized link is handed to the caller to publish as
			// a session link instead, and the description says where it is
			// rather than repeating it.
			//
			// Deliberately NOT rendering the bare URL here as a consolation:
			// that is exactly the login-walled link the delivery path stopped
			// shipping to clients, and a reviewer deserves the same rule.
			const bypassed =
				preview?.state === "ready" &&
				preview.url &&
				containsBypassToken(preview.url);
			if (bypassed && preview.url) onPreviewUrl?.(preview.url);
			return [
				bypassed
					? `**Preview:** open it from the **Preview** link on this session${preview.sha ? ` (\`${preview.sha.slice(0, 7)}\`)` : ""} — it carries the client's access value, which is deliberately not written into this description.`
					: renderPreview(preview),
				...this.testAccountLines(workspaceId),
				...files,
			]
				.filter(Boolean)
				.join("\n");
		} catch (error) {
			this.logger.warn(`Could not build the review block: ${String(error)}`);
			return "";
		}
	}

	/** Head SHA and changed files for a PR — facts, not model claims. */
	private async fetchPullRequestFacts(
		token: string,
		pr: { owner: string; repo: string; number: number },
	): Promise<
		| {
				headSha: string;
				files: Array<{ path: string; additions: number; deletions: number }>;
				truncated: boolean;
				// PON-233: the merge fact was always in this response and was
				// always thrown away. Reading it is what makes merge detection
				// free — the refresh clock already makes this exact request.
				merged: boolean;
				closed: boolean;
				mergeCommitSha?: string;
		  }
		| undefined
	> {
		const api = async <T>(path: string): Promise<T | undefined> => {
			const response = await fetch(`https://api.github.com${path}`, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "cyrus-agent",
				},
			});
			if (!response.ok) return undefined;
			return (await response.json()) as T;
		};
		const detail = await api<{
			head: { sha: string };
			changed_files: number;
			merged?: boolean;
			state?: string;
			merge_commit_sha?: string;
		}>(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
		if (!detail?.head?.sha) return undefined;
		const files =
			(await api<
				Array<{ filename: string; additions: number; deletions: number }>
			>(
				`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100`,
			)) ?? [];
		return {
			merged: detail.merged === true,
			closed: detail.state === "closed",
			...(detail.merge_commit_sha
				? { mergeCommitSha: detail.merge_commit_sha }
				: {}),
			headSha: detail.head.sha,
			files: files.map((f) => ({
				path: f.filename,
				additions: f.additions,
				deletions: f.deletions,
			})),
			truncated: (detail.changed_files ?? files.length) > files.length,
		};
	}

	/**
	 * Describe the PRs, saying "draft" only when that is actually true.
	 *
	 * The mirror used to assert `**PR (draft):**` unconditionally. Draft-ness
	 * is a MODEL behaviour (the verify-and-ship skill opens with `--draft`),
	 * not something the platform enforces, so the label was a hope rather than
	 * a fact — and the fact matters: it is exactly the thing the operator is
	 * deciding about. Unknown stays unknown.
	 */
	private async describePullRequests(prUrls: string[]): Promise<string> {
		if (prUrls.length === 0) return "**PR:** none found in the summary.";
		try {
			return await this.describePullRequestsInner(prUrls);
		} catch (error) {
			// A truthful label is worth two network calls; it is NOT worth
			// losing the mirror write that carries the summary the operator
			// is waiting for.
			this.logger.warn(`Could not read PR draft state: ${String(error)}`);
			return `**PR:** ${prUrls.join(" · ")}`;
		}
	}

	private async describePullRequestsInner(prUrls: string[]): Promise<string> {
		const described = await Promise.all(
			prUrls.map(async (url) => {
				const parsed = parsePullRequestUrl(url);
				if (!parsed) return url;
				const token = await this.mintGitHubTokenForRepo(
					parsed.owner,
					parsed.repo,
				);
				if (!token) return url;
				const draft = await isPullRequestDraft(token, parsed);
				if (draft === true) return `${url} (draft)`;
				if (draft === undefined) return url;

				// Draft-until-release, enforced rather than described.
				//
				// This ran as a describe-only check for exactly one live cycle,
				// and the first PR it looked at was already marked ready — the
				// session had done it itself, so a client watching their
				// repository saw a finished-looking PR for work no human had
				// reviewed. The skill text says not to; the model did anyway.
				// Instructions cannot make this an invariant. Re-asserting it
				// can: we hold the App token, so the gate puts it back.
				try {
					const result = await convertPullRequestToDraft(token, parsed);
					this.logger.event("pr_draft_reasserted", {
						owner: parsed.owner,
						repo: parsed.repo,
						number: parsed.number,
						result,
					});
					return `${url} (draft — it had been marked ready; put back)`;
				} catch (error) {
					// Loud, and honest on the mirror: an un-draftable PR is
					// visible to the client right now, and the operator is the
					// one who can do something about it.
					this.logger.error(
						`Could not put ${parsed.owner}/${parsed.repo}#${parsed.number} back into draft:`,
						error,
					);
					this.logger.event("pr_draft_reassert_failed", {
						owner: parsed.owner,
						repo: parsed.repo,
						number: parsed.number,
					});
					return `${url} — ⚠️ **marked ready and I could not put it back — the client can see this now**`;
				}
			}),
		);
		return `**PR:** ${described.join(" · ")}`;
	}

	/**
	 * A GitHub token for one repository, for the approval path (PON-152).
	 * The ref comes from OUR stored record (the session's own summary), not
	 * from an unverified webhook payload, and the trigger is an explicit
	 * operator action — so per-repo App resolution applies directly, with
	 * the legacy ambient token as the last resort.
	 */
	private async mintGitHubTokenForRepo(
		owner: string,
		repo: string,
	): Promise<string | undefined> {
		if (this.gitHubInstallationResolver) {
			try {
				return await this.gitHubInstallationResolver.mintTokenForRef(
					{ owner, repo },
					"github-api",
				);
			} catch (error) {
				this.logger.error(
					`No usable GitHub App installation for ${owner}/${repo}:`,
					error,
				);
			}
		}
		// Deliberately NO ambient-PAT fallback here: the approval path acts
		// on URLs a model wrote into free text, and a broad PAT would let a
		// quoted foreign PR link flip someone else's draft (review finding,
		// 2026-08-24). No App coverage → the PR stays draft, reported
		// honestly.
		return undefined;
	}

	/**
	 * The session repository's origin "owner/repo", for scoping which PR
	 * links an approval may act on. Undefined when unknown — the caller then
	 * marks nothing ready rather than guessing.
	 */
	private async sessionRepoOriginRef(
		sessionId: string,
	): Promise<{ owner: string; repo: string } | undefined> {
		const repoId = this.sessionRepositories.get(sessionId);
		const repository = repoId ? this.repositories.get(repoId) : undefined;
		if (!repository) return undefined;
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const { stdout } = await promisify(execFile)(
				"git",
				["-C", repository.repositoryPath, "remote", "get-url", "origin"],
				{ timeout: 10_000 },
			);
			const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/.exec(
				stdout.trim(),
			);
			if (!match) return undefined;
			return { owner: match[1] as string, repo: match[2] as string };
		} catch {
			return undefined;
		}
	}

	/**
	 * The operator approved: mark the draft PR(s) ready FIRST, then post the
	 * held summary on the client's thread — in that order, so the client is
	 * never pointed at a draft. Returns a human-readable report for the
	 * mirror thread.
	 */
	/**
	 * Has the code moved since the held summary was written? (PON-210)
	 *
	 * Returns undefined for "cannot tell" as well as "no" — deliberately the
	 * same answer, because both must let delivery proceed. We only ever hold
	 * a delivery on a fact: a head we recorded and a head GitHub reports now,
	 * both different. No captured head (a record from before this shipped, or
	 * a summary whose mirror composition never ran), no PR, no origin, no
	 * token, a failed lookup — every one of those is unknown, and blocking a
	 * client's delivery on something we do not know would be worse than the
	 * bug this fixes.
	 */
	/**
	 * The PR this record's work actually lives in (PON-210).
	 *
	 * Own-repo only, and shared by the capture and the comparison so they can
	 * never disagree. `prUrls` comes from model-written free text and can
	 * quote a foreign PR; if capture stamped the head of one PR and the
	 * comparison read another, every delivery would look stale forever — or,
	 * worse, a genuinely stale one would look fine.
	 */
	private async ownRepoPullRequestFor(
		record: VerificationRecord,
	): Promise<{ owner: string; repo: string; number: number } | undefined> {
		const originRef = await this.sessionRepoOriginRef(record.sessionId);
		if (!originRef) return undefined;
		return record.prUrls
			.map(parsePullRequestUrl)
			.find(
				(pr): pr is { owner: string; repo: string; number: number } =>
					!!pr &&
					pr.owner.toLowerCase() === originRef.owner.toLowerCase() &&
					pr.repo.toLowerCase() === originRef.repo.toLowerCase(),
			);
	}

	/**
	 * Record the commit the held summary describes (PON-210).
	 *
	 * Marks the attempt even when it fails, so a transient GitHub error at
	 * capture leaves staleness permanently unknown rather than leaving the
	 * slot for a later tick to fill with a head that already carries the
	 * reviewer's commits.
	 */
	private async captureSummaryHead(
		issueId: string,
		record: VerificationRecord,
	): Promise<void> {
		if (record.capturedHeadResolved) return;
		try {
			const pr = await this.ownRepoPullRequestFor(record);
			if (!pr) {
				this.verificationGate.recordCapturedHead(issueId, undefined);
				return;
			}
			const token = await this.mintGitHubTokenForRepo(pr.owner, pr.repo);
			const facts = token
				? await this.fetchPullRequestFacts(token, pr)
				: undefined;
			this.verificationGate.recordCapturedHead(issueId, facts?.headSha);
		} catch (error) {
			this.logger.warn(`Could not capture the summary head: ${String(error)}`);
			this.verificationGate.recordCapturedHead(issueId, undefined);
		}
	}

	/**
	 * The files that changed between two commits — the real delta (PON-210).
	 *
	 * The PR's own file list is its diff against BASE, which is the whole
	 * change, not what the reviewer altered. Showing that under "changed in
	 * between" would tell them everything changed every time, which is the
	 * same as telling them nothing.
	 */
	private async filesBetween(
		token: string,
		repo: { owner: string; repo: string },
		base: string,
		head: string,
	): Promise<string[]> {
		try {
			const response = await fetch(
				`https://api.github.com/repos/${repo.owner}/${repo.repo}/compare/${base}...${head}`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github+json",
						"User-Agent": "cyrus-agent",
					},
				},
			);
			if (!response.ok) return [];
			const body = (await response.json()) as {
				files?: Array<{ filename: string }>;
			};
			return (body.files ?? []).map((f) => f.filename);
		} catch {
			// The delta is a courtesy on a refusal that stands without it.
			return [];
		}
	}

	private async summaryStaleness(record: VerificationRecord): Promise<
		| {
				capturedHead: string;
				currentHead: string;
				changedFiles: string[];
		  }
		| undefined
	> {
		try {
			if (!record.capturedHeadSha) return undefined;
			// The SAME selection the capture used — see ownRepoPullRequestFor.
			const target = await this.ownRepoPullRequestFor(record);
			if (!target) return undefined;
			const token = await this.mintGitHubTokenForRepo(
				target.owner,
				target.repo,
			);
			if (!token) return undefined;
			const pr = await this.fetchPullRequestFacts(token, target);
			if (!pr?.headSha) return undefined;
			if (pr.headSha === record.capturedHeadSha) return undefined;
			return {
				capturedHead: record.capturedHeadSha,
				currentHead: pr.headSha,
				// The delta between the two commits, not the PR's whole diff.
				changedFiles: await this.filesBetween(
					token,
					target,
					record.capturedHeadSha,
					pr.headSha,
				),
			};
		} catch (error) {
			// Unknown, per the doc above: never hold a delivery on a failure
			// to check.
			this.logger.warn(`Could not check summary staleness: ${String(error)}`);
			return undefined;
		}
	}

	/**
	 * The client confirmed a change to delivered work: the pull request they
	 * were told to merge goes back to draft until the rework is released
	 * again (v3.1). Best effort — the record's own state is the guard that
	 * matters; this removes the merge button from commits nobody reviewed.
	 */
	private async redraftPullRequestForRework(
		issueId: string,
		record: { mergeWatch?: { owner: string; repo: string; number: number } },
	): Promise<void> {
		const pr = record.mergeWatch;
		if (!pr) return;
		try {
			const token = await this.mintGitHubTokenForRepo(pr.owner, pr.repo);
			if (!token) return;
			const result = await convertPullRequestToDraft(token, pr);
			this.logger.event("rework_pr_redrafted", {
				issueId,
				owner: pr.owner,
				repo: pr.repo,
				number: pr.number,
				result,
			});
		} catch (error) {
			this.logger.warn(
				`Could not return the pull request to draft for rework: ${String(error)}`,
			);
		}
	}

	private async deliverVerifiedWork(
		issueId: string,
		notes?: string,
	): Promise<string> {
		const record = this.verificationGate.get(issueId);
		if (!record) {
			return "Nothing is awaiting verification on this issue.";
		}
		if (record.state === "delivered") {
			return `Already delivered at ${record.deliveredAt}.`;
		}
		if (record.state === "rework") {
			return "Nothing new is held for this issue yet — the client asked for a change and the rework has not finished. Once it hands over, approve again.";
		}
		// PON-237: the state guard above catches a REPLAYED approve, but two
		// approves arriving together would both pass it — the record is not
		// marked delivered until after the post. A client receiving their
		// delivery twice is the kind of thing that only ever happens in front
		// of them, so hold the issue for the length of one delivery.
		if (this.deliveriesInFlight.has(issueId)) {
			return "A delivery for this issue is already going out — nothing sent twice.";
		}
		this.deliveriesInFlight.add(issueId);
		try {
			return await this.performDelivery(issueId, notes, record);
		} finally {
			this.deliveriesInFlight.delete(issueId);
		}
	}

	/** Issues with a delivery mid-flight (PON-237). */
	private deliveriesInFlight = new Set<string>();

	private async performDelivery(
		issueId: string,
		notes: string | undefined,
		record: VerificationRecord,
	): Promise<string> {
		// PON-233: the mirror session that did the work, when there is one.
		// It decides where the sign-off goes and who signed the delivery.
		const link = this.operatorSessions.forClientIssue(issueId);

		// PON-171: the operator's notes land on a CLIENT surface — the R2
		// policy applies to them like any other outbound text, and here the
		// operator is present to rephrase, so a violation refuses the whole
		// delivery BEFORE anything irreversible (no PR readied, no post).
		if (notes) {
			const violations = findClientContentViolations(notes);
			if (violations.length) {
				const offending = [
					...new Set(violations.map((violation) => violation.match)),
				].slice(0, 3);
				this.logger.event("delivery_notes_refused", {
					issueId,
					issueIdentifier: record.issueIdentifier,
					rules: [
						...new Set(violations.map((violation) => violation.rule)),
					].join(","),
				});
				return `❌ Delivery refused: the notes contain internal terms the client must not see (${offending.join(", ")}). Rephrase the notes and approve again — nothing was delivered, the PR stays draft.`;
			}
		}

		// PON-210: does the held summary still describe what merges?
		//
		// Review can move the code after the summary was captured — operator
		// iteration is exempt from the gate, so nothing refreshes it — and the
		// client was then told about a version that is not the one they get.
		// Checked BEFORE anything irreversible, alongside the notes check
		// above, for the same reason: nothing readied, nothing posted.
		const staleness = await this.summaryStaleness(record);
		if (staleness && record.staleNotifiedForSha !== staleness.currentHead) {
			this.verificationGate.noteStaleWarned(issueId, staleness.currentHead);
			void this.persistScopeApprovals("summary_stale");
			this.logger.event("delivery_refused_stale_summary", {
				issueId,
				issueIdentifier: record.issueIdentifier,
				capturedHead: staleness.capturedHead.slice(0, 7),
				currentHead: staleness.currentHead.slice(0, 7),
			});
			return [
				`⏸️ **Not delivered — the code moved after this summary was written.**`,
				``,
				`The summary describes \`${staleness.capturedHead.slice(0, 7)}\`; the PR head is now \`${staleness.currentHead.slice(0, 7)}\`. Delivering it would tell the client they are getting something other than what merges.`,
				staleness.changedFiles.length
					? `\nChanged in between: ${staleness.changedFiles
							.slice(0, 8)
							.map((f) => `\`${f}\``)
							.join(
								", ",
							)}${staleness.changedFiles.length > 8 ? ` and ${staleness.changedFiles.length - 8} more` : ""}.`
					: "",
				``,
				`**To get a summary that matches:** \`reject: rewrite the client summary for the code as it now stands\` — that resumes the session and holds the new summary here for you, exactly as a first pass does.`,
				``,
				`**To send this one anyway:** \`approve:\` again and it goes, with any notes you add.`,
			]
				.filter(Boolean)
				.join("\n");
		}

		const report: string[] = [];
		/** Own-repo PRs confirmed ready — the merge path shown to the client. */
		const mergeablePrUrls: string[] = [];
		// Only PRs in the session's OWN repository are acted on: the URL list
		// comes from model-written free text, which can quote foreign PR
		// links (review finding, 2026-08-24).
		const originRef = await this.sessionRepoOriginRef(record.sessionId);
		for (const url of record.prUrls) {
			const parsed = parsePullRequestUrl(url);
			if (!parsed) continue;
			if (
				!originRef ||
				parsed.owner.toLowerCase() !== originRef.owner.toLowerCase() ||
				parsed.repo.toLowerCase() !== originRef.repo.toLowerCase()
			) {
				report.push(
					`⚠️ ${url}: outside this session's repository${originRef ? ` (${originRef.owner}/${originRef.repo})` : " (origin unknown)"} — not touched.`,
				);
				continue;
			}
			try {
				const token = await this.mintGitHubTokenForRepo(
					parsed.owner,
					parsed.repo,
				);
				if (!token) {
					report.push(`⚠️ ${url}: no GitHub credential — left as draft.`);
					continue;
				}
				const outcome = await markPullRequestReady(token, parsed);
				mergeablePrUrls.push(url);
				report.push(
					outcome === "ready"
						? `✅ ${url} marked ready for review.`
						: `ℹ️ ${url} was already ready.`,
				);
			} catch (error) {
				report.push(
					`⚠️ ${url}: could not mark ready (${error instanceof Error ? error.message.slice(0, 140) : String(error)}) — left as draft.`,
				);
			}
		}

		// PON-171: the client summary is the held summary (already
		// deliverable-framed by R2's intrinsic rules) plus a delivery footer
		// — preview, merge path, and the operator's notes when present.
		// PON-213: the client's copy is the one that has to open without a
		// Vercel account — that is the whole point of holding the token.
		const resolvedPreview = await this.clientPreviewUrl(record, originRef);
		const previewUrl = resolvedPreview
			? this.opaquePreviewLink(resolvedPreview, issueId, record.workspaceId)
			: undefined;
		// PON-233: who did this, and who checked it. Derived from the mirror's
		// assignee — the reviewer's own claim, which the mirror never writes —
		// so it scales to more reviewers without another source of truth.
		const signature = await this.deliverySignature(issueId);
		const footer = CLIENT_MESSAGES.deliveryFooter(
			previewUrl,
			mergeablePrUrls.join(" · ") || undefined,
			notes || undefined,
			signature,
		);
		// PON-233: the cycle ends at THEIR merge, not at our delivery, so the
		// message has to say whose move it is. Without this a delivered pull
		// request sits open because nobody told them the last step was theirs.
		const whatNext = CLIENT_MESSAGES.reviewAndMerge(
			this.testAccountsLine(record.workspaceId),
		);
		const clientSummary = [
			// Bypass first (a preview link the strip misses still opens), then
			// strip the preview/PR links the footer already carries once.
			this.stripDeliveryLinks(
				this.bypassPreviewLinksIn(record.summary, record.workspaceId, issueId),
			),
			whatNext,
			footer,
		]
			.filter(Boolean)
			.join("\n\n");

		// Post the summary to the client's session thread — STRICTLY:
		// the lenient posting paths swallow failures, and a swallowed failure
		// here would mark work delivered that the client never saw (review
		// finding, 2026-08-24: the previous catch was dead code).
		try {
			await this.agentSessionManager.postResponseActivityStrict(
				record.sessionId,
				clientSummary,
			);
			report.push("✅ Client summary posted.");
			// PON-221: the work is released, so the links may follow it. Held
			// since implementation; attached now, with the delivery.
			await this.agentSessionManager.releaseHeldLinks?.(record.sessionId);
			// PON-233: on a mirror-originated run that release is a no-op —
			// the links were published to the MIRROR session, so the client's
			// side has nothing held to release. Attach them explicitly, or
			// their Linear renders a delivery with no Diff and no merge
			// button, which is the whole surface they are asked to act on.
			await this.attachClientDeliveryLinks(record, mergeablePrUrls, previewUrl);
		} catch (error) {
			// Delivery of the summary is the point — if it failed, do NOT
			// mark delivered; the operator retries.
			report.push(
				`❌ Posting the client summary FAILED (${error instanceof Error ? error.message.slice(0, 140) : String(error)}) — still in verification, approve again to retry.`,
			);
			return report.join("\n");
		}

		this.verificationGate.markDelivered(issueId);
		this.verificationSignedOff.delete(issueId);
		this.logger.event("verification_delivered", {
			issueId,
			issueIdentifier: record.issueIdentifier,
			workspaceId: record.workspaceId,
			deliveredAt: this.verificationGate.get(issueId)?.deliveredAt,
		});
		void this.persistScopeApprovals("verification_delivered");
		// PON-233: the client has it now, and that is a different thing from
		// done. `delivered` is kept as the RECORD state (four behaviours key
		// on that literal) while the board says what is actually true.
		void this.cockpitMirror.upsert(
			{ issueId, issueIdentifier: record.issueIdentifier },
			record.workspaceId,
			"in-client-review",
		);
		// Name the pull request whose merge ends the cycle, from the own-repo
		// selection rather than the summary's free text, so the poller cannot
		// drift onto a PR the client was never handed.
		const watch = await this.ownRepoPullRequestFor(record);
		if (watch) {
			this.verificationGate.setMergeWatch(issueId, watch);
			void this.persistScopeApprovals("merge_watch_set");
			report.push(
				`👀 Watching ${watch.owner}/${watch.repo}#${watch.number} for their merge.`,
			);
		} else {
			report.push(
				"⚠️ No own-repo pull request to watch — this will not close itself on merge.",
			);
		}
		this.signOffIntoClientReview(issueId, link);
		return report.join("\n");
	}

	/**
	 * "Implemented by … · Reviewed by …" (PON-233).
	 *
	 * The reviewer comes from the mirror's ASSIGNEE — their own claim, which
	 * the mirror never writes — so it scales to more reviewers without a
	 * second source of truth. Resolved against the cockpit workspace, where
	 * those user ids live; looking them up in the client's workspace finds
	 * nothing. Any failure omits the line: a signature is worth having and
	 * never worth a raw uuid on a client's thread.
	 */
	private async deliverySignature(
		issueId: string,
	): Promise<string | undefined> {
		const cockpitWs = this.config.cockpit?.linearWorkspaceId;
		if (!cockpitWs) return undefined;
		try {
			// The assignee, and nothing else. The two fallbacks this had — the
			// last actor on the thread, then the configured reviewer — could
			// put a name on a client's thread that never reviewed the work.
			// No assignee: no signature, and a journal line so it is noticed.
			const reviewerId = await this.cockpitMirror.assigneeIdFor(issueId);
			if (!reviewerId) {
				this.logger.event("delivery_signature_omitted", {
					issueId,
					reason: "no_assignee",
				});
				return undefined;
			}
			const user = await this.issueTrackers
				.get(cockpitWs)
				?.fetchUser?.(reviewerId);
			// The reviewer's full name reads better on a client surface than
			// their short handle. Linear's `name` is the full name ("Harold
			// Ponte da Costa"); `displayName` is the handle ("haroldpdc").
			// Prefer the name, fall back to the handle.
			const name = user?.name || user?.displayName;
			if (!name) return undefined;
			return `Implemented by Ponte Digital · Reviewed by ${name}`;
		} catch (error) {
			this.logger.debug(`No delivery signature: ${String(error)}`);
			return undefined;
		}
	}

	/** The tenant's role logins, rendered for a client surface (PON-233). */
	private testAccountsLine(
		workspaceId: string | undefined,
	): string | undefined {
		const accounts = workspaceId
			? this.config.linearWorkspaces?.[workspaceId]?.previewTestAccounts
			: undefined;
		if (!accounts?.length) return undefined;
		return accounts
			.map(
				(a) =>
					`${a.label} \`${a.username}\`${a.password ? ` / \`${a.password}\`` : ""}`,
			)
			.join(" · ");
	}

	/**
	 * Put the pull request and preview on the CLIENT's session (PON-233).
	 *
	 * `releaseHeldLinks` cannot do this for mirror-originated work: the links
	 * were published to the mirror session, so there is nothing held under
	 * the client's id to release. Without this their Linear renders a
	 * delivery with no Diff and no merge button — the whole surface they are
	 * being asked to act on. Best-effort: a missing button must never
	 * un-deliver work that has already been posted.
	 */
	private async attachClientDeliveryLinks(
		record: { sessionId: string; workspaceId: string },
		prUrls: string[],
		previewUrl?: string,
	): Promise<void> {
		// v3.1: the client's lifecycle advances to "ready for your review" as
		// the work reaches their session — independent of whether links attach.
		void this.publishClientLifecyclePlan(record.sessionId, "review");
		const urls = [
			...prUrls.map((url) => ({ url, label: "Pull request" })),
			...(previewUrl ? [{ url: previewUrl, label: "Preview" }] : []),
		];
		if (!urls.length) return;
		try {
			await this.issueTrackers
				.get(record.workspaceId)
				?.updateAgentSession?.(record.sessionId, { addedExternalUrls: urls });
			this.logger.event("client_delivery_links_attached", {
				sessionId: record.sessionId,
				count: urls.length,
			});
		} catch (error) {
			this.logger.error("Could not attach the client's delivery links:", error);
		}
	}

	/**
	 * Close the reviewer's turn when the work goes out (PON-233).
	 *
	 * On the thread the reviewer typed `approve:` in, for the same reason
	 * PON-228 moved the verification sign-off there: the narration thread is
	 * beside the one they are standing in.
	 */
	private signOffIntoClientReview(
		issueId: string,
		link?: OperatorSessionLink,
	): void {
		const body =
			"**Released — the client's move.** The summary, the pull request and the preview are on their thread. It stays in client review until they squash-merge, and I'll close it out here when they do. If they come back with a change, it reopens as rework at the head of your queue.";
		if (link?.ownsDelivery) {
			const tracker = this.issueTrackers.get(link.cockpitWorkspaceId);
			void tracker
				?.createAgentActivity?.({
					agentSessionId: link.mirrorSessionId,
					content: { type: "response", body },
				})
				.catch((error: unknown) => {
					this.logger.debug(`Could not sign off delivery: ${String(error)}`);
				});
			return;
		}
		void this.cockpitMirror.commentOnMirror(issueId, body);
	}

	/**
	 * The operator rejected: the work goes back to the agent with the
	 * feedback as a direct prompt. The feedback text itself is never posted
	 * to the client's thread — only its consequences appear, as continued
	 * work.
	 */
	private async rejectVerifiedWork(
		issueId: string,
		feedback: string,
	): Promise<string> {
		// PON-238: resolve everything the resume needs BEFORE clearing the
		// record. `reject()` deletes it, and the resumability check used to
		// come after — so a rejection that could not resume destroyed the
		// client's held summary and had nothing to regenerate it with. The
		// summary only survived truncated to 3000 characters in the mirror
		// body. Look first, delete second.
		const peek = this.verificationGate.get(issueId);
		if (!peek || peek.state !== "in-verification") {
			return "Nothing is awaiting verification on this issue.";
		}
		const owning = this.operatorSessions.forClientIssue(issueId);
		const resumeSessionId =
			owning?.ownsDelivery && owning.mirrorSessionId
				? owning.mirrorSessionId
				: peek.sessionId;
		const session = this.agentSessionManager.getSession(resumeSessionId);
		const repoId = this.sessionRepositories.get(resumeSessionId);
		const repository = repoId ? this.repositories.get(repoId) : undefined;
		if (!session || !repository) {
			return "Rejection NOT recorded — this session can no longer be resumed (session or repository no longer known), and clearing the held summary would lose it with nothing to replace it. The summary is untouched and still deliverable. Prompt the client issue's thread directly to continue.";
		}

		// The peek above is the guard: reject() returns the same object, or
		// nothing under exactly the same condition, and nothing awaits in
		// between. The second check had been dead since #95.
		this.verificationGate.reject(issueId);
		const record = peek;
		// A rejected regeneration is a new run for the hand-over guard. The
		// summary being regenerated was recorded during THIS link's life, so
		// with startedAt unchanged it passed the "recorded during this run"
		// check and was re-held unchanged whenever the model did not hand a
		// new one over — the stale artefact the guard exists to stop.
		if (owning?.ownsDelivery) {
			this.operatorSessions.register({
				...owning,
				startedAt: new Date().toISOString(),
			});
		}
		// PON-221: the work is going back to the agent, so the next time it
		// reaches review it is a genuinely new turn and says so again.
		this.verificationSignedOff.delete(issueId);
		this.logger.event("verification_rejected", {
			issueId,
			issueIdentifier: record.issueIdentifier,
			workspaceId: record.workspaceId,
		});
		void this.persistScopeApprovals("verification_rejected");
		void this.cockpitMirror.upsert(
			{ issueId, issueIdentifier: record.issueIdentifier },
			record.workspaceId,
			"active",
		);

		// PON-225: work started from the mirror is continued ON the mirror —
		// resolved above, before the record was cleared. The record names the
		// CLIENT session (that is where delivery posts), so resuming it
		// blindly would move the conversation off the thread the reviewer is
		// standing in and onto the client's — silent, and a fork of the very
		// conversation that produced the work.
		//
		// PON-238: a regeneration hands the client's text over rather than
		// having it scraped back out of the final message. `reject:` is the
		// designated regeneration path (PON-210 refused to build a second one
		// beside it), so it is where the PON-235 hand-off has to be asked for
		// — otherwise every rewrite silently falls back to scraping, which is
		// the failure PON-235 exists to remove. The link instruction is here
		// for the same reason: the delivery composes exactly one preview link
		// with the client's access value applied, so a URL written into the
		// prose can only be a second, bare, login-walled copy of it.
		const prompt = `The completed work was reviewed internally and needs another pass before it reaches the client. Reviewer feedback:\n\n${feedback}\n\nAddress the feedback on the same branch and PR (keep the PR a draft), then stop and wait for verification again.\n\nWhen you are done, hand the client's summary over with the \`client_summary\` input of \`record_operator_note\` — their language, what now works, complete and verbatim as they should receive it. Do NOT put a PREVIEW URL in it: the delivery composes that link itself with the client's access value, and one written into the prose reaches them bare and opens a login page they cannot pass. Naming the pull request URL is fine and expected. Your own final message is for the reviewer, not for them, and is not what gets delivered.`;
		void this.resumeAgentSession(
			session,
			repository,
			resumeSessionId,
			this.agentSessionManager,
			prompt,
			"",
			false,
			[],
			record.workspaceId,
		).catch((error) => {
			this.logger.error("Failed to resume session after rejection:", error);
		});
		return "Rejection sent back to the agent with your feedback. The client was told nothing.";
	}

	/**
	 * Keep the review block true to the world (PON-212).
	 *
	 * The block reports things we do not own and are not told about: whether a
	 * preview finished building, whether it went from protected to open, what
	 * the newest commit deployed to. None of that produces a Linear event, so
	 * a mirror rendered once at session-end could sit for hours saying
	 * "building" about a deployment that finished in ninety seconds — which is
	 * exactly the shape of staleness that has bitten this surface three times.
	 *
	 * A clock is the honest answer for derived state whose source is silent.
	 * Writes are suppressed when the block is unchanged, so a quiet mirror
	 * costs a couple of reads and no activity on the reviewer's issue.
	 */
	private armMirrorRefresh(): void {
		if (this.mirrorRefreshTimer) return;
		const raw = Number(process.env.CYRUS_MIRROR_REFRESH_MS);
		const intervalMs =
			Number.isFinite(raw) && raw > 0 ? Math.max(60_000, raw) : 3 * 60 * 1000;
		this.mirrorRefreshTimer = setInterval(() => {
			try {
				for (const issueId of this.verificationGate.pendingIssueIds()) {
					this.mirrorInVerification(issueId);
				}
				// PON-233: the same clock asks whether the client has merged.
				// The merge fact rides in a response this tick already makes
				// for work in review, so watching for it costs one extra call
				// per item in client review and nothing at all otherwise.
				// A poll rather than a webhook deliberately: the GitHub App
				// subscribes to no events and has no webhook URL, and turning
				// one on would start delivering comment events for every pull
				// request in every client repository — a live request-path
				// change bought for one boolean.
				for (const issueId of this.verificationGate.awaitingMergeIssueIds()) {
					void this.checkForClientMerge(issueId);
				}
			} catch (error) {
				this.logger.error("Mirror refresh tick failed:", error);
			}
		}, intervalMs);
		this.mirrorRefreshTimer.unref?.();
	}

	private mirrorRefreshTimer?: ReturnType<typeof setInterval>;

	/**
	 * Has the client merged? (PON-233)
	 *
	 * Only a merge — or a cancel — ends the cycle. Everything here fails
	 * UNKNOWN and retries on the next tick: a missing token, a 404, a
	 * rate-limit or a parse failure is never read as "not merged" and never
	 * as "merged". The same posture the staleness check takes, for the same
	 * reason — a wrong answer here closes a client's work.
	 *
	 * A pull request closed WITHOUT merging is not a completion. That is a
	 * client rejecting work, and it needs a human, so it goes to the
	 * reviewer as a comment and the item stays where it is.
	 */
	private async checkForClientMerge(issueId: string): Promise<void> {
		const record = this.verificationGate.get(issueId);
		const pr = record?.mergeWatch;
		if (!record || !pr || record.mergedAt) return;
		try {
			const token = await this.mintGitHubTokenForRepo(pr.owner, pr.repo);
			if (!token) {
				this.noteMergePollUnreadable(issueId, record, pr, "no_github_token");
				return;
			}
			const facts = await this.fetchPullRequestFacts(token, pr);
			if (!facts) {
				this.noteMergePollUnreadable(issueId, record, pr, "pr_unreadable");
				return;
			}

			if (!facts.merged) {
				// Once per pull request, across restarts: the guard used to be
				// an in-memory set, so every deploy re-posted the notice.
				if (
					facts.closed &&
					this.verificationGate.markClosedUnmergedNoticed(issueId)
				) {
					this.logger.event("client_closed_pr_unmerged", {
						issueId,
						issueIdentifier: record.issueIdentifier,
					});
					await this.persistScopeApprovals("client_closed_pr_unmerged");
					void this.cockpitMirror.commentOnMirror(
						issueId,
						`**The client closed the pull request without merging.** That is not a completion — it usually means they do not want this as it stands. Nothing has been changed on their behalf; it is waiting on you.`,
					);
				}
				return;
			}

			if (!this.verificationGate.markMerged(issueId, facts.mergeCommitSha))
				return;
			this.logger.event("client_merged", {
				issueId,
				issueIdentifier: record.issueIdentifier,
				workspaceId: record.workspaceId,
				pr: `${pr.owner}/${pr.repo}#${pr.number}`,
				mergeCommitSha: facts.mergeCommitSha,
			});
			await this.persistScopeApprovals("client_merged");
			const closedOut = await this.closeOutMergedWork(issueId, record);
			if (!closedOut) {
				// The close-out is the one message this cycle owes the client.
				// Do not complete their issue in silence: forget the merge mark
				// so the next tick tries again, and tell the reviewer once.
				this.verificationGate.unmarkMerged(issueId);
				await this.persistScopeApprovals("client_merge_closeout_failed");
				this.logger.event("client_merge_closeout_failed", {
					issueId,
					issueIdentifier: record.issueIdentifier,
					pr: `${pr.owner}/${pr.repo}#${pr.number}`,
				});
				if (!this.closeOutFailureNoticed.has(issueId)) {
					this.closeOutFailureNoticed.add(issueId);
					void this.cockpitMirror.commentOnMirror(
						issueId,
						`**The client merged, but their close-out did not post.** Their issue stays open until it does; I retry every few minutes. If it keeps failing, the journal has the reason.`,
					);
				}
			}
		} catch (error) {
			// Unknown, not "no". The next tick asks again — but say so: this
			// used to log at debug, which production journals do not carry.
			this.logger.warn(`Merge check failed for ${issueId}: ${String(error)}`);
		}
	}

	/** A failed close-out is announced to the reviewer once, not per tick. */
	private closeOutFailureNoticed = new Set<string>();
	/** One journal line per issue and reason, not one per tick. */
	private mergePollUnreadableNoted = new Set<string>();

	/**
	 * A merge poll that cannot read the pull request used to return in
	 * silence — no journal line, no counter — so a repository we lost access
	 * to sat in "In client review" forever under a "watching" promise.
	 */
	private noteMergePollUnreadable(
		issueId: string,
		record: { issueIdentifier?: string },
		pr: { owner: string; repo: string; number: number },
		reason: "no_github_token" | "pr_unreadable",
	): void {
		const key = `${issueId}:${reason}`;
		if (this.mergePollUnreadableNoted.has(key)) return;
		this.mergePollUnreadableNoted.add(key);
		this.logger.event("merge_poll_unreadable", {
			issueId,
			issueIdentifier: record.issueIdentifier,
			pr: `${pr.owner}/${pr.repo}#${pr.number}`,
			reason,
		});
	}

	/**
	 * Issues WE moved to Done after the client merged (PON-235).
	 *
	 * In memory only: it exists to suppress one line in the seconds between
	 * our own write and the webhook it causes, and after a restart there is
	 * no pending close-out for it to collide with.
	 */
	private selfCompletedIssues = new Set<string>();

	/**
	 * Mirror birth sessions that have had their honest "parked" line posted.
	 *
	 * Linear opens an agent session when a mirror is created; on parked work
	 * nothing runs on it, which Linear renders as "Agent didn't start — Retry"
	 * — a failure shape on work that is merely waiting to be delegated. We
	 * close the turn once with a plain line; this remembers which sessions we
	 * already closed so a re-delivered birth webhook does not double-post.
	 */
	private parkedBirthClosed = new Set<string>();

	/**
	 * The client merged: end the cycle on both sides (PON-233).
	 *
	 * Order is load-bearing. The client's close-out and the merged mark go
	 * FIRST, because moving their issue to a completed state fires the
	 * terminal-state path, which removes the verification record, closes the
	 * mirror and deletes the worktree. Do it the other way round and the
	 * close-out is posted into a session that has just been torn down, or
	 * lost entirely.
	 */
	private async closeOutMergedWork(
		issueId: string,
		record: {
			sessionId: string;
			workspaceId: string;
			issueIdentifier?: string;
		},
	): Promise<boolean> {
		const timing = this.lifecycleTiming(issueId);
		try {
			await this.agentSessionManager.postResponseActivityStrict(
				record.sessionId,
				CLIENT_MESSAGES.mergedCloseOut(undefined, timing.cycle),
			);
			// v3.1: the client's lifecycle completes at "merged".
			void this.publishClientLifecyclePlan(record.sessionId, "merged");
		} catch (error) {
			// Not "carry on": the caller retries the whole close-out next tick
			// and tells the reviewer. Completing the client's issue without
			// the one message it owes them was the previous behaviour.
			this.logger.error("Could not post the merge close-out:", error);
			return false;
		}
		void this.cockpitMirror.commentOnMirror(
			issueId,
			`**Merged by the client** — ${record.issueIdentifier ?? "this work"} is done and closing out.${
				timing.cycle
					? ` Total cycle time ${timing.cycle} (scope approval → merge).`
					: ""
			}`,
		);
		// The mirror closes honestly against the client issue's own state
		// (PON-209), so move the client issue first and let that path do it.
		await this.moveIssueToCompletedState(issueId, record.workspaceId);
		return true;
	}

	/**
	 * Someone picked this mirror up with no instruction (PON-211).
	 *
	 * The most natural way to take a piece of work in Linear is to delegate it
	 * to the agent — and that carried no comment, so it classified as nothing
	 * and we said nothing back. Silence in answer to "I'm taking this" is the
	 * single thing that made the cockpit feel broken.
	 *
	 * So: record the claim (Linear's own delegate field), and answer with what
	 * this actually is. No model session — there is no work to do yet, and an
	 * orientation should not cost a turn.
	 */
	private async orientOnMirror(
		action: {
			organizationId: string;
			mirrorSessionId: string;
			actorId?: string;
			actorName?: string;
		},
		clientIssueId: string,
	): Promise<void> {
		const reply = async (text: string) => {
			const tracker = this.getIssueTrackerForWorkspace(action.organizationId);
			try {
				await tracker?.createAgentActivity({
					agentSessionId: action.mirrorSessionId,
					content: { type: "response", body: text },
				});
			} catch (error) {
				this.logger.error("Failed to orient on mirror thread:", error);
			}
		};
		const record = this.verificationGate.get(clientIssueId);
		if (!record) {
			// PON-224: parked work gets an honest orientation — approved,
			// queued, waiting to be started. (Delegation-as-start is the next
			// increment; this text is replaced when that path exists.)
			if (this.scopeApprovals.isImplementationDeferred(clientIssueId)) {
				await reply(
					"**Queued — not started.** The client approved the scope and this work is waiting in the queue; implementation has not begun and nothing has gone to the client. Starting work directly from this mirror is not wired up yet — it ships in the next increment.",
				);
				return;
			}
			await reply(
				"Nothing is held for review on this issue yet — there's nothing for me to pick up here.",
			);
			return;
		}
		const held = this.operatorSessions.forClientIssue(clientIssueId);
		const session = this.agentSessionManager.getSession(record.sessionId);
		const branch = session?.workspace?.path
			? basename(session.workspace.path)
			: undefined;
		this.logger.event("operator_oriented", {
			clientIssueId,
			issueIdentifier: record.issueIdentifier,
			actorId: action.actorId,
		});
		const lines = [
			`I've got the first pass on **${record.issueIdentifier ?? "this issue"}** ready for you.`,
			"",
			branch ? `Branch \`${branch}\`` : "",
			record.prUrls.length ? `PR ${record.prUrls.join(" · ")}` : "",
			held?.operatorHoldsBranch
				? "\nYou currently hold the branch — say **back to you: <what you changed>** when you want me to pick it up again."
				: "",
			"",
			"Tell me what to change and I'll do it on the same branch and PR — the client sees nothing until you release it. Plain instructions are fine, no keyword needed.",
			"",
			"`approve: <notes>` delivers it · `reject: <feedback>` sends it back · `mine` hands me off the branch · `ask client: <question>` is the only thing that reaches them.",
		];
		await reply(lines.filter((l) => l !== "").join("\n"));
	}

	/**
	 * What the operator needs to work on this themselves (PON-208, R7).
	 *
	 * Linear has no copyable-text element — the docs are explicit that a code
	 * block in the body is the only option — so this is a fenced block by
	 * necessity rather than preference.
	 *
	 * The access check is the honest part. The GitHub App can push to the
	 * client's repo; the operator's PERSONAL account very often cannot, because
	 * a real client's repo lives in the client's own org. We cannot test that
	 * from the App's token (different identity), so it is recorded per client
	 * at onboarding — and when it was never granted we say so instead of
	 * printing a command that will fail on its first line.
	 */
	private async buildCheckoutInstructions(
		clientIssueId: string,
	): Promise<string> {
		const record = this.verificationGate.get(clientIssueId);
		if (!record) return "";
		const origin = await this.sessionRepoOriginRef(record.sessionId);
		const session = this.agentSessionManager.getSession(record.sessionId);
		const branch = session?.workspace?.path
			? basename(session.workspace.path)
			: record.issueIdentifier;
		const client = new ClientRegistry(this.config.clients).resolveFor(
			record.workspaceId,
			teamKeyOf(record.issueIdentifier),
		);
		const lines: string[] = [];
		if (origin) {
			lines.push(`Repo    https://github.com/${origin.owner}/${origin.repo}`);
		}
		if (branch) lines.push(`Branch  ${branch}`);
		for (const url of record.prUrls) lines.push(`PR      ${url}`);

		if (client.operatorRepoAccess === false) {
			return `${lines.join("\n")}\n\nYou don't have access to this repository — it belongs to the client's GitHub organisation and only the app was granted push. Ask them to add you as a collaborator with write access before you can check it out.`;
		}
		const cmd =
			origin && branch
				? `\n\n\`\`\`bash\ngit clone https://github.com/${origin.owner}/${origin.repo}.git\ncd ${origin.repo}\ngit fetch origin ${branch}\ngit checkout ${branch}\n\`\`\``
				: "";
		const caveat =
			client.operatorRepoAccess === true
				? ""
				: "\n\nIf the clone is refused, your account was never added to this repository — ask the client for write access.";
		return `${lines.join("\n")}${cmd}${caveat}`;
	}

	/**
	 * "I'll do this part myself" / "back to you" (PON-208, R6).
	 *
	 * A flag, not a lock: nothing here can stop the operator editing files,
	 * and nothing needs to. What it changes is whether the AGENT will touch
	 * the branch — while the operator holds it, an iteration request is
	 * refused rather than raced, and the handback tells the resumed session
	 * to rebase onto their commits before doing anything.
	 */
	private async setOperatorHoldsBranch(
		clientIssueId: string,
		holds: boolean,
	): Promise<string> {
		const record = this.verificationGate.get(clientIssueId);
		if (!record) {
			return "Nothing is awaiting review on this issue, so there is no branch to hand over.";
		}
		const existing = this.operatorSessions.forClientIssue(clientIssueId);
		if (existing) {
			this.operatorSessions.register({
				...existing,
				operatorHoldsBranch: holds,
			});
		} else if (holds) {
			// No session has run on this mirror yet — remember the hold so the
			// first iteration request still respects it.
			this.operatorSessions.register({
				mirrorSessionId: `hold:${clientIssueId}`,
				mirrorIssueId:
					this.cockpitMirror.mirrorIssueIdFor(clientIssueId) ?? clientIssueId,
				clientSessionId: record.sessionId,
				clientIssueId,
				clientIssueIdentifier: record.issueIdentifier,
				clientWorkspaceId: record.workspaceId,
				cockpitWorkspaceId: this.config.cockpit?.linearWorkspaceId ?? "",
				repositoryId: this.sessionRepositories.get(record.sessionId) ?? "",
				startedAt: new Date().toISOString(),
				operatorHoldsBranch: true,
			});
		}
		this.logger.event("operator_branch_hold", {
			clientIssueId,
			issueIdentifier: record.issueIdentifier,
			holds,
		});
		void this.savePersistedState();
		if (!holds) return "";
		const checkout = await this.buildCheckoutInstructions(clientIssueId);
		return `The branch is yours — I won't touch it until you say "back to you".\n\n${checkout}`;
	}

	/**
	 * Ask the CLIENT something, mid-review, on the operator's explicit
	 * instruction (PON-208, R4).
	 *
	 * This is the one thing during review that the client can see, and it is
	 * deliberately not something the agent can decide to do: an operator has
	 * to type it. It reuses PON-172's needs-info machinery so the ask looks
	 * exactly like any other, and the answer returns into the same
	 * conversation rather than a new one.
	 */
	/**
	 * `cancel: <reason>` from the mirror (v3.1, Harold's ruling): never
	 * silent toward the client. The reason is the note they receive, in
	 * their own thread; their issue goes to Canceled (delegating it again
	 * reopens it from the scope); the terminal path then closes the mirror
	 * as Canceled, stops any run, and advances that company's queue.
	 */
	private async cancelWorkFromMirror(
		action: { actorId?: string; actorName?: string },
		clientIssueId: string,
		reason: string,
	): Promise<string> {
		const violations = findClientContentViolations(reason);
		if (violations.length > 0) {
			return `That reason would put internal wording on the client's thread (${violations.join(", ")}). Rephrase it for them and send it again — nothing was cancelled.`;
		}
		const scope = this.scopeApprovals.get(clientIssueId);
		const link = this.operatorSessions.forClientIssue(clientIssueId);
		const record = this.verificationGate.get(clientIssueId);
		const workspaceId =
			scope?.workspaceId ?? link?.clientWorkspaceId ?? record?.workspaceId;
		if (!workspaceId) {
			return "I can't tell which workspace this issue belongs to, so I won't cancel anything on a client's side. Nothing was cancelled.";
		}
		const clientSessionId =
			link?.clientSessionId ??
			record?.sessionId ??
			this.agentSessionManager
				.getSessionsByIssueId(clientIssueId)
				.find((s) => !this.operatorSessions.isOperatorSession(s.id))?.id;
		const issueIdentifier =
			scope?.issueIdentifier ??
			link?.clientIssueIdentifier ??
			record?.issueIdentifier;
		// Their note first, then their issue: the state change fires the
		// terminal path, which tears the session down.
		let told = false;
		if (clientSessionId) {
			try {
				await this.issueTrackers.get(workspaceId)?.createAgentActivity({
					agentSessionId: clientSessionId,
					content: {
						type: "response",
						body: this.agentSessionManager.sanitizeClientSurfaceText(
							clientSessionId,
							"response",
							`We've stopped work on this, at our reviewer's decision: ${reason}\n\nNothing in your project has changed. If you'd like to pick it up again, delegate it to us and we'll start again from the scope.`,
						),
					},
				});
				told = true;
			} catch (error) {
				this.logger.error("Could not post the cancellation note:", error);
			}
		}
		if (!told) {
			return "The client could not be told (no reachable thread on their issue), so nothing was cancelled — a cancel they never hear about is the one thing this must not do.";
		}
		this.logger.event("mirror_canceled_by_reviewer", {
			clientIssueId,
			issueIdentifier,
			workspaceId,
			actorId: action.actorId,
			reasonLength: reason.length,
		});
		await this.moveIssueToTerminalState(clientIssueId, workspaceId, "canceled");
		return `Cancelled. The client has been told, in their words: "${reason}". Their issue is Canceled; delegating it again reopens it from the scope. This mirror closes with it, and the queue moves on.`;
	}

	private async askClientFromMirror(
		clientIssueId: string,
		question: string,
	): Promise<string> {
		// The client's thread is reachable two ways: through a held record
		// (finished work awaiting review) or through the operator link (work
		// in progress on the mirror). Before v3.1 only the first counted, so
		// a reviewer could not reach the client until the run had ended —
		// the opposite of when a question is usually needed.
		const record = this.verificationGate.get(clientIssueId);
		const link = this.operatorSessions.forClientIssue(clientIssueId);
		const target = record
			? {
					workspaceId: record.workspaceId,
					sessionId: record.sessionId,
					issueIdentifier: record.issueIdentifier,
				}
			: link
				? {
						workspaceId: link.clientWorkspaceId,
						sessionId: link.clientSessionId,
						issueIdentifier: link.clientIssueIdentifier,
					}
				: undefined;
		if (!target) {
			return "Nothing is in progress or awaiting review on this issue — nothing to ask about.";
		}
		const violations = findClientContentViolations(question);
		if (violations.length > 0) {
			return `That question would put internal wording on the client's thread (${violations.join(", ")}). Rephrase it and send it again.`;
		}
		const tracker = this.issueTrackers.get(target.workspaceId);
		if (!tracker) {
			return "The client's workspace is not reachable right now — nothing was sent.";
		}
		try {
			await tracker.createAgentActivity({
				agentSessionId: target.sessionId,
				content: {
					type: "elicitation",
					body: `${NEEDS_INFO_HEADER}\n\n${question}`,
				},
			});
		} catch (error) {
			this.logger.error("Failed to ask the client from the mirror:", error);
			return "The question could not be posted to the client's thread — nothing was sent.";
		}
		this.needsInfo.recordAsked(clientIssueId, {
			workspaceId: target.workspaceId,
			issueIdentifier: target.issueIdentifier,
			sessionId: target.sessionId,
			question,
			// The answer comes back to the mirror, not to the client thread.
			...(link
				? {
						relaySessionId: link.mirrorSessionId,
						relayWorkspaceId: link.cockpitWorkspaceId,
					}
				: {}),
		});
		void this.cockpitMirror.upsert(
			{ issueId: clientIssueId, issueIdentifier: target.issueIdentifier },
			target.workspaceId,
			"needs-info",
		);
		this.logger.event("operator_asked_client", {
			clientIssueId,
			issueIdentifier: target.issueIdentifier,
		});
		void this.savePersistedState();
		return "Asked the client on their thread. Their answer comes back into this work; the delivery is still held.";
	}

	/**
	 * Reviewer-triggered needs-info, mirror side (v3.1 P2).
	 *
	 * The mirror session asks with the canonical header; the question is
	 * posted on the CLIENT's own thread as an elicitation, the promise is
	 * parked under the MIRROR session so the runner waits where it is, and
	 * the client's answer comes back verbatim through
	 * relayClientAnswerToMirror. The trigger is the canonical form, never
	 * prose — PON-228 is the record of what a classifier costs on a surface
	 * where a wrong read is a message to a client.
	 */
	private async relayQuestionToClient(
		link: OperatorSessionLink,
		mirrorSessionId: string,
		input: Parameters<NonNullable<AgentRunnerConfig["onAskUserQuestion"]>>[0],
		signal: AbortSignal,
	): Promise<
		Awaited<ReturnType<NonNullable<AgentRunnerConfig["onAskUserQuestion"]>>>
	> {
		const question = input.questions?.[0];
		const clientFacing = [
			question?.question ?? "",
			...(question?.options ?? []).map(
				(opt) => `${opt.label} ${opt.description ?? ""}`,
			),
		].join("\n");
		const violations = findClientContentViolations(clientFacing);
		if (violations.length > 0) {
			this.logger.event("needs_info_relay_refused", {
				clientIssueId: link.clientIssueId,
				issueIdentifier: link.clientIssueIdentifier,
				violations: violations.map((v) => String(v)).join(", "),
			});
			return {
				answered: false,
				message: `Not asked: that question would put internal wording on the client's thread (${violations.join(", ")}). Rephrase it for the client — what you need and what it is needed for, no file names or mechanics — and ask again.`,
			};
		}
		const issueIdentifier =
			link.clientIssueIdentifier ??
			this.scopeApprovals.get(link.clientIssueId)?.issueIdentifier;
		this.needsInfo.recordAsked(link.clientIssueId, {
			question: question?.question ?? "",
			sessionId: link.clientSessionId,
			workspaceId: link.clientWorkspaceId,
			issueIdentifier,
			relaySessionId: mirrorSessionId,
			relayWorkspaceId: link.cockpitWorkspaceId,
		});
		this.logger.event("needs_info_relayed_to_client", {
			clientIssueId: link.clientIssueId,
			issueIdentifier,
			mirrorSessionId,
		});
		await this.persistScopeApprovals("needs_info_relayed_to_client");
		void this.cockpitMirror.upsert(
			{ issueId: link.clientIssueId, issueIdentifier },
			link.clientWorkspaceId,
			"needs-info",
		);
		const result = await this.askUserQuestionHandler.handleAskUserQuestion(
			input,
			mirrorSessionId,
			link.clientWorkspaceId,
			signal,
			{
				sessionId: link.clientSessionId,
				organizationId: link.clientWorkspaceId,
			},
		);
		// A failed post must not leave a phantom wait; an aborted runner must
		// (the answer is relayed after the restart through the same door a
		// re-delegation uses).
		if (!result.answered && !signal.aborted) {
			const wait = this.needsInfo.get(link.clientIssueId);
			if (
				wait?.state === "awaiting" &&
				wait.relaySessionId === mirrorSessionId
			) {
				this.needsInfo.remove(link.clientIssueId);
				await this.persistScopeApprovals("needs_info_relay_failed");
				void this.cockpitMirror.upsert(
					{ issueId: link.clientIssueId, issueIdentifier },
					link.clientWorkspaceId,
					"active",
				);
			}
		}
		return result;
	}

	/**
	 * A client message on their own thread while the mirror owns the run
	 * (v3.1 finding G). Nothing runs on the client's thread: they get one
	 * acknowledgement in their language, and their words go to the reviewer
	 * unchanged — on the mirror thread and in the inbox. Whether and how to
	 * answer is the reviewer's call (`ask client:`, or the delivery).
	 */
	private async relayClientMessageToMirror(
		webhook: AgentSessionPromptedWebhook,
		clientIssueId: string,
		link: OperatorSessionLink,
	): Promise<void> {
		const clientSessionId = webhook.agentSession.id;
		const clientWorkspaceId = webhook.organizationId;
		const issueIdentifier =
			webhook.agentSession.issue?.identifier ?? link.clientIssueIdentifier;
		const body = webhook.agentActivity?.content?.body?.trim() ?? "";
		const author = resolveMirrorActor(webhook).name;
		this.logger.event("client_message_relayed_to_mirror", {
			clientIssueId,
			issueIdentifier,
			mirrorSessionId: link.mirrorSessionId,
			length: body.length,
		});
		try {
			await this.issueTrackers
				.get(link.cockpitWorkspaceId)
				?.createAgentActivity({
					agentSessionId: link.mirrorSessionId,
					content: {
						type: "thought",
						body: `**The client wrote on their thread${author ? ` (${author})` : ""}.** Their words, unchanged:\n\n${body || "(no text)"}\n\nNothing went back to them beyond an acknowledgement. If they need an answer before delivery, \`ask client:\` here or say so.`,
					},
				});
		} catch (error) {
			this.logger.debug(
				`Could not relay the client's message to the mirror thread: ${String(error)}`,
			);
		}
		void this.cockpitMirror.commentOnMirror(
			clientIssueId,
			`**The client wrote mid-work** on ${issueIdentifier ?? "their issue"} — their words are in the session thread. They have been told we are on it and nothing else.`,
		);
		try {
			await this.issueTrackers.get(clientWorkspaceId)?.createAgentActivity({
				agentSessionId: clientSessionId,
				content: {
					type: "response",
					body: this.agentSessionManager.sanitizeClientSurfaceText(
						clientSessionId,
						"response",
						"Thanks — noted. We're working on this now and will come back to you here as soon as it's ready to look at.",
					),
				},
			});
		} catch (error) {
			this.logger.warn(
				`Could not acknowledge the client's mid-work message: ${String(error)}`,
			);
		}
	}

	/**
	 * Reviewer-triggered needs-info, client side (v3.1 P2).
	 *
	 * The client's words go to the mirror session unchanged — into the parked
	 * question if the runner is still waiting, else through the same door a
	 * re-delegation uses — with any files they attached, and the reviewer
	 * sees them on the thread and in their inbox. The client gets one plain
	 * acknowledgement and nothing else; their own thread never runs work.
	 */
	private async relayClientAnswerToMirror(
		webhook: AgentSessionPromptedWebhook,
		clientIssueId: string,
		wait: {
			relaySessionId?: string;
			relayWorkspaceId?: string;
			issueIdentifier?: string;
		},
	): Promise<void> {
		const clientSessionId = webhook.agentSession.id;
		const clientWorkspaceId = webhook.organizationId;
		const issueIdentifier =
			webhook.agentSession.issue?.identifier ?? wait.issueIdentifier;
		const body = webhook.agentActivity?.content?.body?.trim() ?? "";
		const mirrorSessionId = wait.relaySessionId as string;
		const cockpitWorkspaceId =
			wait.relayWorkspaceId ?? this.config.cockpit?.linearWorkspaceId;

		// Attachments travel with the words: same download path as a normal
		// prompt, into the issue's attachments directory, which the mirror
		// session's worktree shares.
		let manifest = "";
		let author: string | undefined;
		try {
			const commentId = webhook.agentActivity?.sourceCommentId;
			const tracker = this.issueTrackers.get(clientWorkspaceId);
			const comment =
				commentId && tracker ? await tracker.fetchComment(commentId) : null;
			if (comment) {
				const user = await comment.user;
				author = user?.displayName || user?.name || undefined;
				const workspacePath =
					this.agentSessionManager.getSession(mirrorSessionId)?.workspace
						.path ??
					this.agentSessionManager.getSession(clientSessionId)?.workspace.path;
				if (workspacePath) {
					const dir = getAttachmentsDir(
						this.cyrusHome,
						basename(workspacePath),
						clientWorkspaceId,
					);
					await mkdir(dir, { recursive: true });
					const existing = (await readdir(dir).catch(() => [])).filter(
						(file) =>
							file.startsWith("attachment_") || file.startsWith("image_"),
					).length;
					const downloaded = await this.downloadCommentAttachments(
						comment.body,
						dir,
						this.getLinearTokenForWorkspace(clientWorkspaceId),
						existing,
					);
					if (downloaded.totalNewAttachments > 0) {
						manifest = this.generateNewAttachmentManifest(downloaded);
					}
				}
			}
		} catch (error) {
			this.logger.warn(
				`Could not fetch the client's attachments for the relay: ${String(error)}`,
			);
		}

		const verbatim = body || "(no text)";
		const answerForRun = manifest ? `${verbatim}\n\n${manifest}` : verbatim;
		this.logger.event("needs_info_answer_relayed", {
			clientIssueId,
			issueIdentifier,
			mirrorSessionId,
			hasAttachments: manifest.length > 0,
			length: body.length,
		});
		this.markNeedsInfoAnswered(
			clientIssueId,
			clientWorkspaceId,
			issueIdentifier,
		);

		// Reviewer register, on the mirror: the answer word for word, on the
		// thread and in the inbox.
		const cockpitTracker = cockpitWorkspaceId
			? this.issueTrackers.get(cockpitWorkspaceId)
			: undefined;
		try {
			await cockpitTracker?.createAgentActivity({
				agentSessionId: mirrorSessionId,
				content: {
					type: "thought",
					body: `**The client answered${author ? ` (${author})` : ""}.** Their words, unchanged:\n\n${answerForRun}`,
				},
			});
		} catch (error) {
			this.logger.debug(
				`Could not post the relayed answer on the mirror thread: ${String(error)}`,
			);
		}
		void this.cockpitMirror.commentOnMirror(
			clientIssueId,
			`**The client answered** — ${issueIdentifier ?? "this issue"} is back in progress. Their answer is in the session thread, word for word.`,
		);

		// The client's turn closes with one plain acknowledgement, in their
		// language. Nothing else reaches them until delivery.
		try {
			await this.issueTrackers.get(clientWorkspaceId)?.createAgentActivity({
				agentSessionId: clientSessionId,
				content: {
					type: "response",
					body: this.agentSessionManager.sanitizeClientSurfaceText(
						clientSessionId,
						"response",
						"Thanks — that's what we needed. We're back on it and will let you know when it's ready.",
					),
				},
			});
		} catch (error) {
			this.logger.warn(
				`Could not acknowledge the client's answer: ${String(error)}`,
			);
		}

		// Resume where the work stopped.
		const resolved = this.askUserQuestionHandler.handleUserResponse(
			mirrorSessionId,
			answerForRun,
		);
		if (resolved) return;
		if (!cockpitWorkspaceId) {
			this.logger.warn(
				"Cannot resume the mirror session with the client's answer: no cockpit workspace",
			);
			return;
		}
		const instruction = [
			`The client answered the question you asked them${author ? ` (${author})` : ""}. Their words, unchanged:`,
			"",
			answerForRun,
		].join("\n");
		const action = { organizationId: cockpitWorkspaceId, mirrorSessionId };
		if (this.verificationGate.get(clientIssueId)) {
			await this.runOperatorIteration(action, clientIssueId, {
				instruction,
				resumedAfterOperatorEdits: false,
			});
		} else {
			await this.startWorkFromMirror(action, clientIssueId, { instruction });
		}
	}

	/**
	 * May this action start the parked work? (PON-225)
	 *
	 * Not the same question as "who is acting", because on this path that is
	 * usually nobody: delegating an issue reaches us as a notification, and
	 * the agent session it needs is then created by our own recovery — so the
	 * created webhook's creator is the app, not the person. Machinery opens
	 * sessions on a mirror for its own reasons too (the narration thread at
	 * birth). Authorising on the actor alone would therefore both refuse the
	 * real gesture and, worse, let a session the machinery opened at approval
	 * time start the work — which is precisely the auto-start PON-224 removed.
	 *
	 * The claim is the honest signal. The mirror never writes `assigneeId`
	 * (PON-211), so an assignee is always a human act, and §8.3's gesture is
	 * exactly that: assign yourself, then delegate. A known reviewer acting
	 * directly (a comment) is accepted too.
	 *
	 * Silence is deliberate when the actor is unknown: that is machinery, and
	 * a refusal posted on every mirror birth is noise on the one surface that
	 * has to stay readable.
	 */
	private async mayStartParkedWork(
		action: { actorId?: string },
		clientIssueId: string,
	): Promise<{ ok: boolean; say?: string }> {
		const reviewers = this.cockpitReviewers();
		if (reviewers.length === 0) {
			return {
				ok: false,
				say: action.actorId
					? "Starting work needs a configured reviewer (`cockpit.reviewers` or `cockpit.assigneeId`) — nobody is declared, so nothing can be started."
					: undefined,
			};
		}
		// PON-234: one piece of work per company, across the whole lifecycle.
		// Checked here because this is the single admission point in front of
		// starting work, and because refusing at the gesture is legible — the
		// reviewer learns what holds the slot instead of watching a second
		// build appear for a client who bought one lane.
		//
		// Deliberately NOT the lane. A lane holds a SESSION and is released
		// the moment a human becomes the blocker, so it cannot express a hold
		// that spans start to merge. The lane stays underneath as the
		// execution guard; this is strictly stricter and fires earlier.
		const wip = this.cockpitMirror.clientWorkInFlight(clientIssueId);
		if (wip.inFlight.length >= wip.limit) {
			const held = wip.inFlight
				.map((i) => `${i.issueIdentifier ?? "another issue"} (${i.state})`)
				.join(", ");
			this.logger.event("wip_limit_reached", {
				clientIssueId,
				limit: wip.limit,
				inFlight: wip.inFlight.length,
			});
			return {
				ok: false,
				// Same rule as the other two refusals: an unattributed
				// delegation is machinery, and a refusal on every mirror
				// birth is noise on the one surface that must stay readable.
				say: action.actorId
					? `This client already has work in flight — ${held} — and they have ${wip.limit === 1 ? "one lane" : `${wip.limit} lanes`}. Nothing has been started here; it stays queued until that reaches Done or is cancelled.`
					: undefined,
			};
		}

		// The claim is the only authority (Harold's ruling, 2026-09-02): a
		// delegation is not attributed, so the assignee — always a human act,
		// the mirror never writes it — is who started this. There is no
		// "known reviewer typed it" shortcut any more: comments do not start
		// work, and a colleague takes over by claiming.

		const assignee = await this.cockpitMirror.assigneeIdFor(clientIssueId);
		if (assignee && reviewers.includes(assignee)) return { ok: true };

		this.logger.event("mirror_start_refused", {
			clientIssueId,
			actorId: action.actorId,
			hasAssignee: Boolean(assignee),
		});
		return {
			ok: false,
			say: action.actorId
				? "Assign yourself to this first and I'll pick it up — starting work on a client's repository needs a reviewer of record, and the assignee is who that is."
				: undefined,
		};
	}

	/**
	 * Start the client's implementation run from a queued mirror (PON-225).
	 *
	 * The fresh-start twin of `runOperatorIteration`. Same subject/surface
	 * split — the client's repository and credentials, the cockpit's thread —
	 * and the same registration, so every operator exemption applies. Two
	 * things differ, and both follow from there being no prior run:
	 *
	 *   - there is nothing to adopt, so this starts a new conversation with
	 *     the full issue prompt rather than continuing one;
	 *   - the link carries `ownsDelivery`, which keeps the verification gate
	 *     armed for this session. This run's closing summary is the client's
	 *     deliverable, not a report to the reviewer, and the gate is the whole
	 *     reason it does not reach them unread.
	 */
	private async startWorkFromMirror(
		action: {
			organizationId: string;
			mirrorSessionId: string;
			actorId?: string;
			actorName?: string;
		},
		clientIssueId: string,
		opts: { instruction: string },
	): Promise<void> {
		const { mirrorSessionId } = action;
		const reply = async (text: string) => {
			const tracker = this.getIssueTrackerForWorkspace(action.organizationId);
			try {
				await tracker?.createAgentActivity({
					agentSessionId: mirrorSessionId,
					content: { type: "response", body: text },
				});
			} catch (error) {
				this.logger.error("Failed to reply on mirror thread:", error);
			}
		};

		// The scope record is the authority on the client side of a parked
		// issue: it carries the workspace, the identifier, and the text the
		// client actually approved. It exists by construction — the parked
		// flag lives on that same record.
		const scope = this.scopeApprovals.get(clientIssueId);
		const clientWorkspaceId = scope?.workspaceId;
		if (!clientWorkspaceId) {
			await reply(
				"I can't tell which workspace this issue belongs to any more, so I won't start work against a repository I can't confirm. Nothing has been started.",
			);
			return;
		}

		// The scoping conversation is what binds this issue to a repository
		// and a worktree. Reusing its workspace is what keeps the same-branch
		// invariant: the branch the client's issue named is the branch the
		// reviewer reviews and the client eventually merges.
		const clientSession = this.agentSessionManager
			.getSessionsByIssueId(clientIssueId)
			.find((session) => this.sessionRepositories.get(session.id));
		const repoId = clientSession
			? this.sessionRepositories.get(clientSession.id)
			: undefined;
		const repository = repoId ? this.repositories.get(repoId) : undefined;
		if (!clientSession || !repository || !clientSession.issue) {
			await reply(
				"I can't reach the original conversation for this issue or its repository any more, so I can't start the work here. Nothing has been started.",
			);
			return;
		}

		const sink = this.activitySinks.get(action.organizationId);
		if (!sink) {
			await reply(
				"I can't post into this thread (no activity sink for the cockpit workspace), so I won't start work I can't report on.",
			);
			return;
		}

		// One active build per client (PON-112). This run is the client's
		// actual implementation, which is exactly what the lane serializes —
		// unlike an operator review turn, which deliberately takes no lane.
		// A busy lane refuses rather than queues: the reviewer chose this
		// moment, so the honest answer is what is in the way, not a silent
		// wait they cannot see.
		let laneHeld = false;
		if (this.laneManager.isEnabled(clientWorkspaceId)) {
			laneHeld = this.laneManager.acquire(clientWorkspaceId, mirrorSessionId);
			if (!laneHeld) {
				const holder = this.laneManager.activeSessionOf(clientWorkspaceId);
				const holderIssue = holder
					? (this.agentSessionManager.getSession(holder)?.issueContext
							?.issueIdentifier ?? "another issue")
					: "another issue";
				await reply(
					`This client already has work in progress on ${holderIssue}, and they get one build at a time. Nothing has been started here — pick this up once that one is released.`,
				);
				return;
			}
		}

		try {
			// The mirror-side session record. Its issue is the CLIENT's issue —
			// the work is about that issue, the worktree and branch are named
			// from it, and every issue-keyed lookup downstream expects it.
			const operatorSession =
				this.agentSessionManager.getSession(mirrorSessionId) ??
				this.agentSessionManager.createCyrusAgentSession(
					mirrorSessionId,
					clientIssueId,
					clientSession.issue,
					clientSession.workspace,
					"linear",
					clientSession.repositories ?? [],
				);

			// Subject before the runner: auth, git credentials and content
			// policy all resolve through this mapping.
			this.sessionRepositories.set(mirrorSessionId, repository.id);
			// Surface: the cockpit's sink. Set after the session exists — the
			// link tracker it builds reads the session's issue identifier, and
			// without it no preview link is ever emitted.
			this.agentSessionManager.setActivitySink(mirrorSessionId, sink);

			// Registered BEFORE the resume: every exemption keys on this and
			// they are consulted while the runner is being built.
			const previous = this.operatorSessions.forClientIssue(clientIssueId);
			this.operatorSessions.register({
				mirrorSessionId,
				mirrorIssueId:
					this.cockpitMirror.mirrorIssueIdFor(clientIssueId) ?? clientIssueId,
				clientSessionId: clientSession.id,
				clientIssueId,
				clientIssueIdentifier:
					scope.issueIdentifier ?? clientSession.issueContext?.issueIdentifier,
				clientWorkspaceId,
				cockpitWorkspaceId: action.organizationId,
				repositoryId: repository.id,
				startedAt: new Date().toISOString(),
				...(action.actorId ? { reviewerId: action.actorId } : {}),
				operatorHoldsBranch: false,
				ownsDelivery: true,
			});
			if (previous && previous.mirrorSessionId !== mirrorSessionId) {
				this.operatorSessions.release(previous.mirrorSessionId);
			}

			// The park is over. Client-thread sessions stop carrying the
			// "implementation has not started" block from here on.
			if (this.scopeApprovals.markImplementationStarted(clientIssueId)) {
				await this.persistScopeApprovals("implementation_started");
			}
			void this.cockpitMirror.upsert(
				{
					issueId: clientIssueId,
					issueIdentifier: scope.issueIdentifier,
				},
				clientWorkspaceId,
				"active",
			);

			// PON-228: the narration thread and the implementation thread are
			// two threads on one mirror, and the reviewer cannot tell which is
			// live. Worse, the parked sign-off ("nothing is running here")
			// stays standing on the narration thread and becomes false the
			// moment this starts — Harold read exactly that and reported the
			// run as stuck while it was sixteen minutes into working. Point it
			// at the live one rather than leaving it insisting otherwise.
			this.logger.event("mirror_work_started", {
				clientIssueId,
				issueIdentifier: scope.issueIdentifier,
				mirrorSessionId,
				clientSessionId: clientSession.id,
				clientWorkspaceId,
				cockpitWorkspaceId: action.organizationId,
				repositoryId: repository.id,
				reviewerId: action.actorId,
				laneHeld,
				hasInstruction: opts.instruction.length > 0,
			});
			void this.savePersistedState();
			// v3.1: client lifecycle advances to "in development". Published on
			// the CLIENT session — the mirror session keeps the detailed model
			// plan for the reviewer.
			void this.publishClientLifecyclePlan(clientSession.id, "building");

			const prompt =
				`Implement ${scope.issueIdentifier ?? "this issue"}.` +
				buildMirrorImplementationBlock({
					issueIdentifier: scope.issueIdentifier,
					branchName: clientSession.workspace?.path
						? basename(clientSession.workspace.path)
						: undefined,
					clientScope: scope.clientScope,
					instruction: opts.instruction,
				});

			await this.resumeAgentSession(
				operatorSession,
				repository,
				mirrorSessionId,
				this.agentSessionManager,
				prompt,
				"",
				// A new conversation: there is no earlier implementation run to
				// continue, so the model gets the full issue prompt.
				true,
				[],
				// The CLIENT's workspace — this selects the tracker that fetches
				// their issue. The Anthropic credential is resolved separately,
				// from the cockpit link (PON-225/D7).
				clientWorkspaceId,
			);
		} catch (error) {
			this.logger.error("Could not start work from the mirror:", error);
			if (laneHeld) {
				this.releaseLaneAndContinue(
					clientWorkspaceId,
					mirrorSessionId,
					"mirror_start_failed",
				);
			}
			await reply(
				"I couldn't start the work. Nothing has been sent to the client — say the word and I'll try again.",
			);
		}
	}

	/**
	 * Run one turn of operator iteration on the mirror (PON-208).
	 *
	 * This is the whole feature. The session it starts has two different
	 * workspaces, and that split is the design:
	 *
	 *   SUBJECT  = the client's repository → the client's GitHub App token,
	 *              the client's content policy. (The Anthropic credential
	 *              follows the COCKPIT — see `buildAgentRunnerConfig`.)
	 *   SURFACE  = the cockpit's activity sink → every thought, action and
	 *              response lands on the mirror thread.
	 *
	 * The client's silence therefore needs no policing: their tracker is not
	 * reachable from this session's posting path.
	 */
	private async runOperatorIteration(
		action: {
			organizationId: string;
			mirrorSessionId: string;
			actorId?: string;
			actorName?: string;
		},
		clientIssueId: string,
		opts: { instruction: string; resumedAfterOperatorEdits: boolean },
	): Promise<void> {
		const { mirrorSessionId } = action;
		const reply = async (text: string) => {
			const tracker = this.getIssueTrackerForWorkspace(action.organizationId);
			try {
				await tracker?.createAgentActivity({
					agentSessionId: mirrorSessionId,
					content: { type: "response", body: text },
				});
			} catch (error) {
				this.logger.error("Failed to reply on mirror thread:", error);
			}
		};

		const record = this.verificationGate.get(clientIssueId);
		if (!record) {
			// PON-221: the mirror is created the moment the client approves
			// the scope, so its FIRST message used to be "there is nothing to
			// iterate on" — stated a beat before the work started, and read
			// as "this is dead" rather than "this is beginning". The gate is
			// empty in both cases; only the mirror's own state tells them
			// apart.
			const state = this.cockpitMirror.stateFor?.(clientIssueId) ?? "";
			// PON-224: a parked issue is NOT underway — the client approved the
			// scope and the work is waiting to be started. Claiming "my move"
			// here would be false a beat after the parking change ships; the
			// honest reply names what starting it takes today. (Delegation as
			// the start trigger is the next increment; this text is its
			// placeholder and is replaced when that path exists.)
			if (this.scopeApprovals.isImplementationDeferred(clientIssueId)) {
				await reply(
					"**Queued — not started.** The client approved the scope and the work is waiting in the queue; implementation has not begun and nothing has gone to the client. Starting work directly from this mirror is not wired up yet — it ships in the next increment.",
				);
				return;
			}
			// A reviewer talking to a RUNNING mirror run is the point of the
			// working surface — the implementation block tells the model to
			// talk to them while it works. This branch used to answer every
			// such message with the canned "underway" line and drop the
			// words; the model never heard a thing. Stream them in.
			const liveRunner =
				this.agentSessionManager.getSession(mirrorSessionId)?.agentRunner;
			if (
				opts.instruction.trim() &&
				liveRunner?.isRunning?.() &&
				liveRunner.supportsStreamingInput &&
				liveRunner.addStreamMessage
			) {
				try {
					liveRunner.addStreamMessage(opts.instruction);
					this.logger.event("mirror_instruction_streamed", {
						clientIssueId,
						mirrorSessionId,
						length: opts.instruction.length,
					});
					return;
				} catch (error) {
					this.logger.warn(
						`Could not stream the reviewer's message into the running mirror session: ${String(error)}`,
					);
				}
			}
			const underway = /^(active|queued|needs-info)/i.test(state);
			await reply(
				underway
					? "**Work is underway — my move.** Nothing is held for review yet; I'll post the summary, the changed files and a preview link here the moment it is. Nothing has gone to the client, and nothing will until you release it. Say what you want changed at any point and I'll pick it up."
					: "There is no completed work held on this issue yet, so there is nothing to iterate on. Nothing was sent to the client.",
			);
			return;
		}

		const existing = this.operatorSessions.forClientIssue(clientIssueId);
		if (existing?.operatorHoldsBranch && !opts.resumedAfterOperatorEdits) {
			await reply(
				'You have the branch. Say "back to you: <what you changed>" and I\'ll pick it up from your commits.',
			);
			return;
		}

		const clientSession = this.agentSessionManager.getSession(record.sessionId);
		const repoId = this.sessionRepositories.get(record.sessionId);
		const repository = repoId ? this.repositories.get(repoId) : undefined;
		if (!clientSession || !repository || !clientSession.issue) {
			await reply(
				"I can't reach the original session or its repository any more, so I can't continue that work here. Nothing was sent to the client.",
			);
			return;
		}
		const clientIssue = clientSession.issue;

		// The mirror-side session record. It is the SURFACE identity: activities
		// address it, so it must exist before anything posts. Its issue is the
		// CLIENT's issue — that is what the work is about, and what every
		// issue-keyed lookup downstream expects.
		let operatorSession =
			this.agentSessionManager.getSession(mirrorSessionId) ??
			this.agentSessionManager.createCyrusAgentSession(
				mirrorSessionId,
				clientIssueId,
				clientIssue,
				clientSession.workspace,
				"linear",
				clientSession.repositories ?? [],
			);

		// Subject: register against the CLIENT's repository BEFORE the runner
		// is built. Auth, git credentials and content policy all resolve
		// through this mapping, so a late registration is a credential bug.
		this.sessionRepositories.set(mirrorSessionId, repository.id);

		// Surface: the cockpit's sink, so output lands on the mirror thread.
		const sink = this.activitySinks.get(action.organizationId);
		if (!sink) {
			await reply(
				"I can't post into this thread (no activity sink for the cockpit workspace), so I won't start work I can't report on.",
			);
			return;
		}
		this.agentSessionManager.setActivitySink(mirrorSessionId, sink);

		const link: OperatorSessionLink = {
			mirrorSessionId,
			mirrorIssueId:
				this.cockpitMirror.mirrorIssueIdFor(clientIssueId) ?? clientIssueId,
			clientSessionId: record.sessionId,
			clientIssueId,
			clientIssueIdentifier: record.issueIdentifier,
			clientWorkspaceId: record.workspaceId,
			cockpitWorkspaceId: action.organizationId,
			repositoryId: repository.id,
			startedAt: existing?.startedAt ?? new Date().toISOString(),
			...(action.actorId ? { reviewerId: action.actorId } : {}),
			operatorHoldsBranch: false,
			// A plain instruction on a mirror-started run must not turn it
			// back into a client-thread delivery: this literal used to drop
			// the flag, so after one "make the header bigger" the next
			// `reject:` regenerated on the CLIENT's thread.
			...(existing?.ownsDelivery ? { ownsDelivery: true } : {}),
		};
		// Registered BEFORE the resume: every exemption (quietness, the scope
		// gate, the verification gate) keys on this, and they are consulted
		// while the runner is being built.
		this.operatorSessions.register(link);
		if (existing && existing.mirrorSessionId !== mirrorSessionId) {
			this.operatorSessions.release(existing.mirrorSessionId);
		}

		// Continuity: same conversation, same worktree. Without this the
		// operator would be talking to a model that has never seen the work.
		//
		// Adopt ONCE. By the second turn this session has its own, newer
		// conversation id, and re-adopting from the client record would drag
		// it backwards — silently discarding the first turn if the end-of-turn
		// sync had not landed (a runner that died before its end event, say).
		// Whoever is further ahead wins, and after the first turn that is us.
		const alreadyContinuing = Boolean(
			this.agentSessionManager.getSession(mirrorSessionId)?.claudeSessionId,
		);
		const adopted =
			alreadyContinuing ||
			this.agentSessionManager.adoptRunnerSession(
				record.sessionId,
				mirrorSessionId,
			);
		operatorSession =
			this.agentSessionManager.getSession(mirrorSessionId) ?? operatorSession;

		this.logger.event("operator_session_started", {
			clientIssueId,
			issueIdentifier: record.issueIdentifier,
			mirrorSessionId,
			clientSessionId: record.sessionId,
			clientWorkspaceId: record.workspaceId,
			repositoryId: repository.id,
			adoptedConversation: adopted,
			afterOperatorEdits: opts.resumedAfterOperatorEdits,
			// PON-211: who drove this turn. One agent identity serves every
			// mirror, so Linear attributes all of it to the app — this is the
			// only place the human is recorded.
			reviewerId: action.actorId,
		});
		void this.savePersistedState();

		if (!adopted) {
			await reply(
				"I couldn't pick up the earlier conversation, so I'm starting fresh on the same branch — I may re-read things I already knew.",
			);
		}

		const prompt =
			opts.instruction +
			// PON-229: the reviewer's message reaches this path whatever it
			// was — the catch-all intent is `iterate`, so a question arrives
			// wrapped in "carry on working". Ask what it actually is first.
			// Not on a handback: "back to you: <what I changed>" is already a
			// directive by construction, and offering the model a way to read
			// it as a question is how a handback stalls.
			(opts.resumedAfterOperatorEdits ? "" : buildReviewerRequestBlock()) +
			buildOperatorSessionBlock({
				issueIdentifier: record.issueIdentifier,
				branchName: clientSession.workspace?.path
					? basename(clientSession.workspace.path)
					: undefined,
				resumedAfterOperatorEdits: opts.resumedAfterOperatorEdits,
			});

		void this.resumeAgentSession(
			operatorSession,
			repository,
			mirrorSessionId,
			this.agentSessionManager,
			prompt,
			"",
			false,
			[],
			// The CLIENT's workspace — this is what bills the client's lane
			// rather than the cockpit's own (metered) credential.
			record.workspaceId,
		).catch(async (error) => {
			this.logger.error("Operator iteration failed to start:", error);
			await reply(
				"I couldn't start work on that. Nothing was sent to the client.",
			);
		});
	}

	/**
	 * An operator action on a cockpit mirror (PON-152): approve delivers,
	 * reject sends the work back. One action, answered on the mirror thread.
	 * Reached from BOTH webhook shapes — the first @mention (created) and
	 * every reply in the resulting thread (prompted) — so "approve again to
	 * retry" works where the operator naturally types it.
	 */
	private async handleMirrorAction(
		action: {
			organizationId: string;
			mirrorSessionId: string;
			actorId?: string;
			actorName?: string;
			rawBody: string;
		},
		clientIssueId: string,
	): Promise<void> {
		const { mirrorSessionId } = action;
		// PON-225: a body carrying Linear's own thread boilerplate IS the
		// delegation — the whole sentence is theirs, not something a person
		// typed, and a human's actual words arrive later as their own prompt.
		// Read as text it classifies as `iterate` and the boilerplate becomes
		// the work to do; read as bare, it is the gesture it actually is.
		const body = action.rawBody.includes(AGENT_SESSION_THREAD_MARKER)
			? ""
			: action.rawBody
					.replace(/@\S+/g, " ") // strip the mention handle
					.trim();
		const reply = async (text: string) => {
			const tracker = this.getIssueTrackerForWorkspace(action.organizationId);
			if (!tracker) return;
			try {
				await tracker.createAgentActivity({
					agentSessionId: mirrorSessionId,
					content: { type: "response", body: text },
				});
			} catch (error) {
				this.logger.error("Failed to reply on mirror thread:", error);
			}
		};

		// The single most consequential action in the system — releasing
		// unverified work to a client — gets the strictest checks anywhere
		// (review finding, 2026-08-24): the webhook must come from the
		// cockpit workspace, and the actor must be the configured approver.
		if (action.organizationId !== this.config.cockpit?.linearWorkspaceId) {
			this.logger.warn(
				`Mirror action from non-cockpit workspace ${action.organizationId} — refused`,
			);
			return;
		}

		const intent = classifyMirrorIntent(body);

		// Who may do what on a mirror (PON-212).
		//
		// PON-208 guarded delivery; PON-211 widened that to EVERY action,
		// which was too far. Harold's ruling: a colleague talking to the agent
		// about work in progress is help, not a threat — what needs guarding
		// is anything the CLIENT experiences.
		//
		//   approve / reject   release work to a client, irreversible here
		//   ask client         the one action that reaches them
		//   everything else    any member of the cockpit workspace
		//
		// Stated cost, accepted: any member can spend the client's model
		// credential by talking to the agent. Nothing they can do reaches the
		// client or ships anything, which is the line that matters.
		const clientFacing =
			intent.kind === "approve" ||
			intent.kind === "reject" ||
			intent.kind === "ask-client" ||
			intent.kind === "cancel";
		if (clientFacing) {
			const reviewers = this.cockpitReviewers();
			if (reviewers.length === 0) {
				await reply(
					"Delivering needs a configured reviewer (`cockpit.reviewers` or `cockpit.assigneeId`) — nobody is declared, so nothing can be released.",
				);
				return;
			}
			if (!action.actorId || !reviewers.includes(action.actorId)) {
				// PON-237: two different failures, and telling them apart is
				// the whole point. "You are not a reviewer" said to the actual
				// reviewer — because attribution was missing, not because they
				// lacked standing — sends them looking for a permissions
				// problem that does not exist. Say which one happened.
				const unattributed = !action.actorId;
				this.logger.event("verification_action_refused", {
					clientIssueId,
					actorId: action.actorId,
					actorName: action.actorName,
					intent: intent.kind,
					reason: unattributed ? "no_actor" : "not_a_reviewer",
				});
				await reply(
					unattributed
						? "I couldn't verify who sent that, so I haven't released anything — this is about attribution, not about you. Send it again from the mirror's own thread; if it keeps happening, say so and I'll look at why the actor is missing."
						: "Only a configured reviewer can release work to the client. You can still work on it here — say what you want changed.",
				);
				return;
			}
		}

		// PON-225: on parked work, picking the mirror up IS the start gesture.
		// Both shapes arrive here — a bare delegation (`orient`) and a comment
		// (`iterate`) — and both start, with the comment carried in as extra
		// instruction. Placed before the intent dispatch below so neither the
		// orient reply nor runOperatorIteration's "nothing held" branch can
		// answer for parked work any more.
		if (intent.kind === "cancel-unclear") {
			await reply(
				"`cancel` needs a reason the client will read: `cancel: <reason>`. Nothing was cancelled.",
			);
			return;
		}
		if (intent.kind === "cancel") {
			await reply(
				await this.cancelWorkFromMirror(action, clientIssueId, intent.reason),
			);
			return;
		}
		// Harold's ruling (2026-09-02): comments are conversation. Only the
		// claimant's delegation starts parked work; a colleague takes over by
		// claiming (reassigning), which is auditable. A comment on a parked
		// mirror used to start the build with the comment as the instruction.
		if (
			this.scopeApprovals.isImplementationDeferred(clientIssueId) &&
			intent.kind === "iterate"
		) {
			await reply(
				"This is queued, not started — comments here are conversation. Delegate it to me to start the work; a colleague takes it over by assigning themselves first.",
			);
			return;
		}
		if (
			this.scopeApprovals.isImplementationDeferred(clientIssueId) &&
			intent.kind === "orient"
		) {
			const permitted = await this.mayStartParkedWork(action, clientIssueId);
			if (!permitted.ok) {
				if (permitted.say) {
					await reply(permitted.say);
				} else if (!this.parkedBirthClosed.has(mirrorSessionId)) {
					// The mirror's birth: Linear opened this session when the
					// mirror was created and nothing is running on it (parked,
					// nobody has delegated). A refusal with no `say` is the
					// nobody-asked case — left silent, the session sits as
					// "Agent didn't start — Retry", a failure shape on work
					// that is only waiting. Close the turn once, honestly, as a
					// response so the turn completes. The reviewer's delegation
					// reuses this same session.
					this.parkedBirthClosed.add(mirrorSessionId);
					await reply("Parked — nothing running here; delegate to start.");
				}
				return;
			}
			await this.startWorkFromMirror(action, clientIssueId, {
				instruction: "",
			});
			return;
		}
		if (
			this.scopeApprovals.isImplementationDeferred(clientIssueId) &&
			(intent.kind === "mine" || intent.kind === "handback")
		) {
			// Nothing has been built, so there is no branch to take or hand
			// back. Say that rather than minting a hold on work that does not
			// exist.
			await reply(
				"Nothing has been built on this issue yet — the client's scope is approved and it is waiting in the queue. Delegate this mirror to me and I'll start it.",
			);
			return;
		}

		if (intent.kind === "orient") {
			// A bare delegation. No model session, no cost — just claim it and
			// say plainly what this is and what can be said next.
			await this.orientOnMirror(action, clientIssueId);
			return;
		}
		if (intent.kind === "mine") {
			const report = await this.setOperatorHoldsBranch(clientIssueId, true);
			await reply(report);
			return;
		}
		if (intent.kind === "handback") {
			await this.setOperatorHoldsBranch(clientIssueId, false);
			await this.runOperatorIteration(action, clientIssueId, {
				instruction: intent.notes,
				resumedAfterOperatorEdits: true,
			});
			return;
		}
		if (intent.kind === "ask-client-unclear") {
			// PON-221: recognised as an ask, but not in words the client can
			// receive. Answered here rather than passed to the agent, so a
			// near-miss costs a sentence instead of a model turn — and never
			// a fragment on the client's thread.
			await reply(
				intent.draft
					? `I can ask them — but "${intent.draft}" would go across verbatim, and it reads as a fragment about them rather than a question to them. Write it as you want them to read it: \`ask client: ${intent.draft.endsWith("?") ? intent.draft : "<the question>"}\`, or just end it with a question mark.`
					: 'Say what to ask: "ask client: <question>". It goes on their thread verbatim.',
			);
			return;
		}
		if (intent.kind === "ask-client") {
			if (!intent.question) {
				await reply(
					'Say what to ask: "ask client: <question>". It goes on their thread verbatim.',
				);
				return;
			}
			const report = await this.askClientFromMirror(
				clientIssueId,
				intent.question,
			);
			await reply(report);
			return;
		}
		if (intent.kind === "iterate") {
			await this.runOperatorIteration(action, clientIssueId, {
				instruction: intent.instruction,
				resumedAfterOperatorEdits: false,
			});
			return;
		}

		const isApprove = intent.kind === "approve";
		if (isApprove) {
			// PON-171: everything after the keyword is the operator's notes,
			// woven into the client summary. Bare approve still works.
			const notes = intent.notes || undefined;
			this.logger.event("verification_approve_action", {
				clientIssueId,
				actorId: action.actorId,
				hasNotes: notes !== undefined,
			});
			const report = await this.deliverVerifiedWork(clientIssueId, notes);
			await reply(report);
			return;
		}
		if (intent.kind === "reject") {
			const feedback = intent.feedback;
			if (!feedback) {
				await reply(
					'Rejection needs feedback for the agent: "reject: <what needs to change>".',
				);
				return;
			}
			this.logger.event("verification_reject_action", {
				clientIssueId,
				actorId: action.actorId,
			});
			const report = await this.rejectVerifiedWork(clientIssueId, feedback);
			await reply(report);
			return;
		}
	}

	/**
	 * The PON-152 escalation ladder. Runs every 10 minutes; only ever gets
	 * LOUDER — a second notification, then one honest delay note on the
	 * client's issue. It never delivers anything.
	 */
	/**
	 * Workspace token liveness (PON-136). Four live incidents proved the
	 * thesis: refresh is traffic-driven, so an idle workspace's token dies
	 * silently (they expire ~daily by design), and by the time anything
	 * looks the refresh token may have aged out too — turning a silent
	 * expiry into a full re-auth ceremony.
	 *
	 * The ping is deliberately just a new CLOCK for existing behaviour:
	 * it routes through `tenantStillHasAccess`, whose tracker client
	 * auto-refreshes on 401 (rotated pair persisted via onTokenRefresh) —
	 * so the ping DRIVES the refresh, it does not merely detect death. At
	 * this cadence a refresh token is never more than ~a day old, so the
	 * case-2 shape (refresh token aged out with the access token) cannot
	 * recur on a running box. A conclusive failure routes through the
	 * PON-115 path (`handleTenantAccessLost` → deactivate); recovery after
	 * re-auth arrives via config hot-reload, no restart. A passing ping is
	 * silent (debug only).
	 */
	private armWorkspaceLiveness(): void {
		if (this.workspaceLivenessTimer) return;
		const raw = Number(process.env.CYRUS_LIVENESS_INTERVAL_MS);
		const intervalMs =
			Number.isFinite(raw) && raw > 0 ? Math.max(60_000, raw) : 10 * 60 * 1000;
		this.workspaceLivenessTimer = setInterval(() => {
			this.runWorkspaceLivenessTick().catch((error) => {
				this.logger.error("Workspace liveness tick failed:", error);
			});
		}, intervalMs);
		this.workspaceLivenessTimer.unref?.();
		// First tick shortly after boot: a box that restarts onto a dead
		// token should discover (and heal) it in seconds, not one interval.
		const bootProbe = setTimeout(() => {
			this.runWorkspaceLivenessTick().catch((error) => {
				this.logger.error("Workspace liveness boot tick failed:", error);
			});
		}, 45_000);
		bootProbe.unref?.();
		this.logger.info(
			`✅ Workspace token liveness armed (every ${Math.round(intervalMs / 60_000)}m)`,
		);
	}

	private async runWorkspaceLivenessTick(): Promise<void> {
		// Serialize: a slow tick (network trouble is exactly when pings are
		// slow) must not stack behind itself.
		if (this.workspaceLivenessTickRunning) return;
		this.workspaceLivenessTickRunning = true;
		try {
			for (const [workspaceId, wsConfig] of Object.entries(
				this.config.linearWorkspaces ?? {},
			)) {
				if (wsConfig.active === false) continue; // recovery is hot-reload's job
				if (!this.issueTrackers.get(workspaceId)) continue;
				const alive = await this.tenantStillHasAccess(workspaceId);
				if (alive) {
					this.logger.debug(`[liveness] workspace ${workspaceId} ping ok`);
					continue;
				}
				// Conclusive failure — the probe's own 401 already triggered
				// the transport's refresh attempt, and it could not repair.
				await this.handleTenantAccessLost(
					workspaceId,
					new Error(
						"liveness ping failed conclusively (auth failure a token refresh could not repair)",
					),
				);
			}
		} finally {
			this.workspaceLivenessTickRunning = false;
		}
	}

	private armVerificationLadder(): void {
		if (this.verificationLadderTimer) return;
		this.verificationLadderTimer = setInterval(
			() => {
				this.runVerificationLadder().catch((error) => {
					this.logger.error("Verification ladder failed:", error);
				});
			},
			10 * 60 * 1000,
		);
		this.verificationLadderTimer.unref?.();
	}

	private async runVerificationLadder(): Promise<void> {
		// PON-219: ages change with the clock, not with an event, so the
		// waiting room needs a tick. Reusing this one rather than arming a
		// second timer — same cadence, same "has this been quiet too long"
		// question.
		this.syncScopeWaitingRoom();
		const remindMs =
			(this.config.verificationEscalation?.remindAfterHours ?? 4) * 3600_000;
		const delayNoteMs =
			(this.config.verificationEscalation?.delayNoteAfterHours ?? 24) *
			3600_000;
		const now = Date.now();
		for (const entry of this.verificationGate.listPending()) {
			const age = now - Date.parse(entry.completedAt);
			if (age > remindMs && !entry.escalatedAt) {
				if (this.verificationGate.markEscalated(entry.issueId)) {
					this.logger.event("verification_escalated", {
						issueId: entry.issueId,
						issueIdentifier: entry.issueIdentifier,
						ageHours: Math.round(age / 3600_000),
					});
					await this.cockpitMirror.commentOnMirror(
						entry.issueId,
						`Still awaiting verification after ${Math.round(age / 3600_000)}h. The client has not been told anything. Mention me with "approve" or "reject: <feedback>".`,
					);
					void this.persistScopeApprovals("verification_escalated");
				}
			}
			if (age > delayNoteMs && !entry.delayNotedAt) {
				if (this.verificationGate.markDelayNoted(entry.issueId)) {
					this.logger.event("verification_delay_note", {
						issueId: entry.issueId,
						issueIdentifier: entry.issueIdentifier,
						ageHours: Math.round(age / 3600_000),
					});
					const tracker = this.getIssueTrackerForWorkspace(entry.workspaceId);
					if (tracker) {
						try {
							await tracker.createComment(entry.issueId, {
								body: CLIENT_MESSAGES.verificationDelayNote(),
							});
						} catch (error) {
							this.logger.error(
								"Failed to post delay note on client issue:",
								error,
							);
						}
					}
					void this.persistScopeApprovals("verification_delay_note");
				}
			}
		}
	}

	/**
	 * Startup retry state (PON-138). Captured for every initializeAgentRunner
	 * call; consulted when a session ends in error having produced almost no
	 * entries — the 529/rate-limit startup-death signature (8 of 10 sessions
	 * dead at 4 activities in the measured incident).
	 */
	private startupRetryState = new Map<
		string,
		{
			args: Parameters<EdgeWorker["initializeAgentRunner"]>;
			attempts: number;
			firstFailureAt?: number;
			timer?: NodeJS.Timeout;
		}
	>();

	private static readonly STARTUP_RETRY_MAX_ATTEMPTS = 4;
	private static readonly STARTUP_RETRY_BASE_DELAY_MS = 30_000;
	private static readonly STARTUP_RETRY_MAX_ENTRIES = 8;
	private static readonly STARTUP_RETRY_DEADLINE_MS = 30 * 60 * 1000;

	/**
	 * Transient vs permanent (PON-138). Only ENUMERATED transients retry:
	 * 529/429/5xx/connection failures are normal operating weather for a
	 * busy API. Auth and billing fail fast — retrying an invalid credential
	 * just delays the truth, and billing errors are never retried (standing
	 * rule). Unknown errors do not retry: looping a real bug helps nobody.
	 */
	private classifyStartupError(text: string): "transient" | "permanent" {
		if (
			/credit balance|billing|invalid.*api.?key|authentication|401|403/i.test(
				text,
			)
		) {
			return "permanent";
		}
		if (
			/529|overloaded|rate.?limit|429|too many requests|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|\b50[0234]\b|internal server error/i.test(
				text,
			)
		) {
			return "transient";
		}
		return "permanent";
	}

	/**
	 * Decide whether this session end is a retryable startup death, and if
	 * so schedule the replay with exponential backoff and jitter. Returns
	 * true when a retry (or the exhausted-path client message) took over —
	 * the caller then skips the mirror end-of-work transitions.
	 */
	private maybeScheduleStartupRetry(sessionId: string): boolean {
		const state = this.startupRetryState.get(sessionId);
		if (!state) return false;

		const errorText = this.agentSessionManager.getLastResultError(sessionId);
		if (errorText === null) {
			// Clean result — startup survived; stop tracking.
			this.startupRetryState.delete(sessionId);
			return false;
		}
		const entryCount = this.agentSessionManager.getEntryCount(sessionId);
		if (entryCount > EdgeWorker.STARTUP_RETRY_MAX_ENTRIES) {
			// Died mid-work, not at startup — a retry would replay a session
			// that already did real (possibly repo-mutating) work.
			this.startupRetryState.delete(sessionId);
			return false;
		}
		if (this.classifyStartupError(errorText) !== "transient") {
			this.startupRetryState.delete(sessionId);
			this.logger.event("startup_error_permanent", {
				sessionId,
				error: errorText.slice(0, 160),
			});
			return false;
		}

		const issueId = this.sessionIssueId(sessionId);
		// The failed attempt's raw API error must never become the held
		// "completion summary" (gated workspaces hold error results too).
		if (issueId && this.verificationGate.isPending(issueId)) {
			this.verificationGate.reject(issueId);
		}

		state.firstFailureAt ??= Date.now();
		if (state.attempts >= EdgeWorker.STARTUP_RETRY_MAX_ATTEMPTS) {
			this.startupRetryState.delete(sessionId);
			this.logger.event("startup_retries_exhausted", {
				sessionId,
				issueId,
				attempts: state.attempts,
				error: errorText.slice(0, 160),
			});
			// Silence is the specific failure being fixed: the client hears
			// it as an error activity (policy-swept template; error activities
			// post on quiet workspaces too).
			void this.agentSessionManager.createErrorActivity(
				sessionId,
				CLIENT_MESSAGES.sessionStartFailed(),
			);
			return false;
		}

		state.attempts++;
		const backoff =
			EdgeWorker.STARTUP_RETRY_BASE_DELAY_MS * 2 ** (state.attempts - 1);
		const delayMs = Math.round(backoff * (1 + Math.random() * 0.25));
		this.logger.event("startup_retry_scheduled", {
			sessionId,
			issueId,
			attempt: state.attempts,
			delayMs,
			error: errorText.slice(0, 160),
		});
		state.timer = setTimeout(() => {
			state.timer = undefined;
			this.runStartupRetry(sessionId).catch((error) => {
				this.logger.error(
					`Startup retry for session ${sessionId} failed to launch:`,
					error,
				);
			});
		}, delayMs);
		state.timer.unref?.();
		return true;
	}

	private async runStartupRetry(sessionId: string): Promise<void> {
		const state = this.startupRetryState.get(sessionId);
		if (!state) return;
		// The session may have been cleaned up while we waited (issue went
		// terminal, unassigned, stop signal) — a removed session never
		// restarts itself (the PON-135 lesson).
		if (!this.agentSessionManager.getSession(sessionId)) {
			this.startupRetryState.delete(sessionId);
			return;
		}
		const workspaceId = state.args[2];
		// Re-acquire the lane: it was released with the failed attempt, and a
		// queued session may hold it now. Lane-busy is not an API failure —
		// wait another minute without consuming an attempt, up to a deadline.
		if (
			this.laneManager.isEnabled(workspaceId) &&
			!this.laneManager.acquire(workspaceId, sessionId)
		) {
			if (
				Date.now() - (state.firstFailureAt ?? Date.now()) >
				EdgeWorker.STARTUP_RETRY_DEADLINE_MS
			) {
				this.startupRetryState.delete(sessionId);
				this.logger.event("startup_retries_exhausted", {
					sessionId,
					reason: "lane_busy_past_deadline",
				});
				void this.agentSessionManager.createErrorActivity(
					sessionId,
					CLIENT_MESSAGES.sessionStartFailed(),
				);
				return;
			}
			state.timer = setTimeout(() => {
				state.timer = undefined;
				this.runStartupRetry(sessionId).catch(() => {});
			}, 60_000);
			state.timer.unref?.();
			return;
		}
		this.logger.event("startup_retry_launched", {
			sessionId,
			attempt: state.attempts,
		});
		await this.initializeAgentRunner(...state.args);
	}

	private handleLaneSessionEnded(sessionId: string, reason: string): void {
		// A new turn may post a fresh delivered-change confirm.
		this.deliveredConfirmPosted.delete(sessionId);
		// PON-138: a transient startup death schedules its own replay — the
		// mirror stays as it was (the work is not over, it is retrying) and
		// only the lane release below still applies.
		if (
			(reason === "result" || reason === "runner_error") &&
			this.maybeScheduleStartupRetry(sessionId)
		) {
			const retryWorkspaceId = this.laneManager.workspaceOf(sessionId);
			if (retryWorkspaceId && this.laneManager.isActive(sessionId)) {
				this.releaseLaneAndContinue(
					retryWorkspaceId,
					sessionId,
					"startup_retry",
				);
			}
			return;
		}
		// Cockpit (PON-151): every reason reaching here is a real session end
		// (result, runner_complete, runner_error, not_started) — but a
		// session end is not always the END OF THE ISSUE'S WORK: a mention
		// conversation finishing, or one session of several, must not close
		// the mirror while the delegation is still live (review finding).
		// PON-208: an operator turn advances the model conversation, and the
		// client's record must follow it. Left unsynced the two fork silently
		// — the client's next resume (a needs-info answer, say) would continue
		// a conversation that never saw the reviewer's work, and nothing would
		// report an error.
		const operatorLink = this.operatorSessions.get(sessionId);
		if (operatorLink) {
			this.agentSessionManager.syncRunnerSessionTo(
				sessionId,
				operatorLink.clientSessionId,
			);
			void this.savePersistedState();
		}
		const endedIssueId = this.sessionIssueId(sessionId);
		// PON-211: an operator turn ending does not change the mirror's state
		// — it was in verification before the turn and it still is. Recomposing
		// anyway re-rendered the entire description (two GitHub round trips)
		// underneath the reviewer while they were mid-conversation. The
		// conversation-id sync above is the part that matters here.
		//
		// PON-225: a session that OWNS the delivery is the exception. Its end
		// is the end of the client's implementation run, so the mirror has to
		// move to in-verification and pick up its review block — the reasoning
		// above applies to review turns on work that already exists, not to
		// the run that produced it. It falls through to the same transitions
		// and the same lane release a client session gets.
		if (operatorLink && !operatorLink.ownsDelivery) {
			const opWorkspaceId = this.laneManager.workspaceOf(sessionId);
			if (opWorkspaceId && this.laneManager.isActive(sessionId)) {
				this.releaseLaneAndContinue(opWorkspaceId, sessionId, reason);
			}
			return;
		}
		// PON-226: a parked mirror must never look like it is working.
		//
		// The mirror's narration thread is a real Linear agent session, and
		// client-session narration is shadowed onto it (PON-212). Between
		// approval and the reviewer starting the work, that leaves a thread
		// carrying the client conversation's thoughts and — because a turn is
		// only closed by a `response` — sitting in Linear's `active` state
		// with a running timer. Found live on CKP-22: the cockpit showed an
		// agent apparently mid-task on work nobody had claimed, quoting a
		// stale plan item from the client's scoping session. Nothing was
		// running; the surface said otherwise, which on a board whose whole
		// job is to report state is the same as being wrong.
		//
		// The client session ending is the honest moment to close it: the
		// shadow has finished writing, and the true state is "queued, nobody
		// has picked this up". It self-corrects — a later client turn reopens
		// the thread and its own end closes it again.
		// v3.1 (requirement A): a parked mirror has no thread to sign off. Its
		// description says "next up" or its place in the order; that is the
		// whole surface until the reviewer delegates.
		if (endedIssueId && this.verificationGate.isPending(endedIssueId)) {
			// PON-152: completed work awaiting approval — the mirror shows
			// in-verification instead of closing. Idempotent with the
			// interceptor-side transition (runner-already-stopped ordering).
			this.mirrorInVerification(endedIssueId);
		} else if (endedIssueId && operatorLink?.ownsDelivery) {
			this.reparkInterruptedMirrorRun(endedIssueId, operatorLink, reason);
		} else if (
			endedIssueId &&
			this.shouldCloseCockpitMirror(sessionId, endedIssueId)
		) {
			void this.cockpitMirror.close(endedIssueId, reason);
		}
		// The mention marker is NOT cleared here: in the runner-already-
		// stopped ordering this runs BEFORE the final-response interceptor,
		// which needs it (a mention conversation's answer must never be
		// held). Markers are cleared when the issue's sessions are removed
		// (terminal state / unassign) and are persisted across restarts.
		const workspaceId = this.laneManager.workspaceOf(sessionId);
		if (!workspaceId || !this.laneManager.isActive(sessionId)) return;
		this.releaseLaneAndContinue(workspaceId, sessionId, reason);
	}

	/**
	 * A mirror-owned run ended without handing anything over (v3.1).
	 *
	 * Stopped by the reviewer, crashed, or killed with the process: that is
	 * neither finished work nor abandoned work. It used to fall through to
	 * shouldCloseCockpitMirror, which had no reason to say no, and the
	 * mirror closed as Done — "stop_signal" is not a discard reason — with
	 * the client's approved work half-built on a branch nobody was pointed
	 * at, and the reviewer's next delegation landing on a closed issue.
	 *
	 * Park it again instead. The same door a re-delegation uses
	 * (startWorkFromMirror) picks it up on the same worktree and branch.
	 */
	private reparkInterruptedMirrorRun(
		issueId: string,
		link: OperatorSessionLink,
		reason: string,
	): void {
		const reparked = this.scopeApprovals.markImplementationInterrupted(issueId);
		this.logger.event("mirror_run_interrupted", {
			clientIssueId: issueId,
			issueIdentifier: link.clientIssueIdentifier,
			mirrorSessionId: link.mirrorSessionId,
			reason,
			reparked,
		});
		if (reparked) void this.persistScopeApprovals("mirror_run_interrupted");
		void this.cockpitMirror.upsert(
			{ issueId, issueIdentifier: link.clientIssueIdentifier },
			link.clientWorkspaceId,
			"queued",
		);
		const why =
			reason === "stop_signal"
				? "it was stopped"
				: reason === "runner_error"
					? "the runner failed"
					: reason === "service_restart"
						? "the service restarted underneath it"
						: "it ended without handing anything over";
		void this.cockpitMirror.commentOnMirror(
			issueId,
			`**Stopped before it was finished — your move.** The run ended (${why}). Whatever it pushed is still on the branch; delegate this mirror to me again and I'll pick it up from there. Nothing has gone to the client.`,
		);
	}

	/**
	 * Runner-level "error" event. Only release the lane when the runner is
	 * actually dead — non-fatal errors can be emitted while a session keeps
	 * running, and releasing then would start a second concurrent session.
	 */
	private handleLaneRunnerError(sessionId: string): void {
		const session = this.agentSessionManager.getSession(sessionId);
		if (session?.agentRunner?.isRunning?.()) return;
		this.handleLaneSessionEnded(sessionId, "runner_error");
	}

	/**
	 * Idempotently release a lane and kick off the next queued session.
	 * Synchronous callers (result handling, error events) must not await the
	 * next session's start, so the continuation is fire-and-forget with its
	 * own error logging.
	 */
	private releaseLaneAndContinue(
		workspaceId: string,
		sessionId: string,
		reason: string,
	): void {
		if (!this.laneManager.release(workspaceId, sessionId)) return;
		this.clearLaneGrace(workspaceId);
		this.logger.event("lane_released", { workspaceId, sessionId, reason });
		void this.startNextInLane(workspaceId).catch((error) => {
			this.logger.error(
				`Failed to start next queued session in workspace ${workspaceId}:`,
				error,
			);
		});
	}

	/**
	 * Dequeue the head of the lane queue, persist, notify shifted positions,
	 * and start the session by replaying its stored created-webhook through
	 * the normal start flow (with a normal start acknowledgment).
	 */
	private async startNextInLane(workspaceId: string): Promise<void> {
		const next = this.laneManager.takeNext(workspaceId);
		await this.savePersistedState();
		if (!next) return;

		this.logger.event("lane_start_next", {
			workspaceId,
			sessionId: next.sessionId,
			queuedRemaining: this.laneManager.queueLength(workspaceId),
		});

		// Every remaining entry moved up one position.
		const snapshot = this.laneManager.snapshot()[workspaceId];
		for (const entry of snapshot?.queue ?? []) {
			await this.activityPoster.postQueuePositionUpdate(
				entry.sessionId,
				workspaceId,
				entry.position,
			);
		}
		this.syncCockpitQueue(workspaceId);

		try {
			if (next.kind === "resume") {
				// Resume entry: replay the stored prompted webhook. It re-enters
				// handleUserPromptedAgentActivity, where the lane check sees this
				// session as the holder and proceeds; that path's own backstop
				// releases if the resume never starts a runner.
				const resumeWebhook = structuredClone(
					next.webhook,
				) as AgentSessionPromptedWebhook;
				if (
					next.contextPrompts.length > 0 &&
					resumeWebhook.agentActivity?.content
				) {
					resumeWebhook.agentActivity.content.body = `${resumeWebhook.agentActivity.content.body}\n\nAdditional context added while queued:\n${next.contextPrompts
						.map((p) => `- ${p}`)
						.join("\n")}`;
				}
				await this.handleUserPromptedAgentActivity(resumeWebhook);
			} else {
				const repos = Array.from(this.repositories.values());
				await this.handleAgentSessionCreatedWebhook(
					next.webhook as AgentSessionCreatedWebhook,
					repos,
					{ laneAssigned: true, queuedContextPrompts: next.contextPrompts },
				);
			}
		} catch (error) {
			this.logger.error(
				`Failed to start queued session ${next.sessionId} in workspace ${workspaceId}:`,
				error,
			);
			// The replay's own backstop releases and continues; this is a
			// second, idempotent safety in case the throw happened before it.
			this.releaseLaneAndContinue(workspaceId, next.sessionId, "start_failed");
		}
	}

	/**
	 * Remove sessions from lane bookkeeping when their issue goes away
	 * (unassign, cancel, delete). Active holders release the lane; queued
	 * entries are removed and shifted positions are notified.
	 */
	private async cleanupLaneForSession(sessionId: string): Promise<void> {
		const workspaceId = this.laneManager.workspaceOf(sessionId);
		if (!workspaceId) return;
		if (this.laneManager.isActive(sessionId)) {
			this.releaseLaneAndContinue(workspaceId, sessionId, "issue_removed");
			return;
		}
		const result = this.laneManager.removeQueued(sessionId);
		if (!result) return;
		await this.savePersistedState();
		for (const change of result.changes) {
			await this.activityPoster.postQueuePositionUpdate(
				change.sessionId,
				workspaceId,
				change.position,
			);
		}
		this.syncCockpitQueue(workspaceId);
	}

	/**
	 * Stop signal on a queued session: it has no runner — remove it from the
	 * queue and confirm.
	 */
	private async handleQueuedSessionStop(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const sessionId = webhook.agentSession.id;
		const workspaceId = this.laneManager.workspaceOf(sessionId);
		if (!workspaceId) return;
		const result = this.laneManager.removeQueued(sessionId);
		await this.savePersistedState();
		// Cockpit (PON-151): a stopped queued delegation is no longer live
		// work — without this its mirror shows "queued (#N)" forever.
		const stoppedIssueId = webhook.agentSession.issue?.id;
		if (
			stoppedIssueId &&
			this.shouldCloseCockpitMirror(sessionId, stoppedIssueId)
		) {
			void this.cockpitMirror.close(stoppedIssueId, "stopped_while_queued");
		}
		await this.activityPoster.postQueueRemovedNotice(sessionId, workspaceId);
		for (const change of result?.changes ?? []) {
			await this.activityPoster.postQueuePositionUpdate(
				change.sessionId,
				workspaceId,
				change.position,
			);
		}
		this.syncCockpitQueue(workspaceId);
		this.logger.event("lane_queue_removed", {
			workspaceId,
			sessionId,
			reason: "stop_signal",
		});
	}

	/**
	 * Prompt on a queued session (PON-112): a short next/prioritize intent
	 * moves it to the front; anything else is stored as context for when the
	 * session starts. Everything here is local except the activity posts, so
	 * the response is immediate.
	 */
	private async handleQueuedSessionPrompt(
		webhook: AgentSessionPromptedWebhook,
		receivedAt: number,
	): Promise<void> {
		const sessionId = webhook.agentSession.id;
		const workspaceId = this.laneManager.workspaceOf(sessionId);
		if (!workspaceId) return;
		const body = webhook.agentActivity?.content?.body ?? "";

		// PON-150: a canonical gate reply can land while the session is
		// lane-queued (its answer webhook already enqueued as a resume
		// entry). This branch runs before branch 2.5, so interpret here too —
		// otherwise "Approve scope" sent to a queued session records nothing
		// until replay, and the SLA clock drifts to whenever the lane frees.
		await this.interpretScopeConfirmReply(webhook);

		if (isQueueReorderIntent(body)) {
			const result = this.laneManager.moveToFront(sessionId);
			if (!result) return;
			await this.savePersistedState();
			await this.activityPoster.postQueueReorderConfirmation(
				sessionId,
				workspaceId,
				result.alreadyFirst,
			);
			for (const change of result.changes) {
				await this.activityPoster.postQueuePositionUpdate(
					change.sessionId,
					workspaceId,
					change.position,
				);
			}
			this.syncCockpitQueue(workspaceId);
			this.logger.event("lane_reordered", {
				workspaceId,
				sessionId,
				elapsedMs: Date.now() - receivedAt,
			});
			return;
		}

		this.laneManager.addContextPrompt(sessionId, body);
		await this.savePersistedState();
		const position = this.laneManager.positionOf(sessionId);
		if (position !== null) {
			await this.activityPoster.postQueueContextAcknowledgment(
				sessionId,
				workspaceId,
				position,
			);
		}
		this.logger.event("session_ack_posted", {
			kind: "prompted",
			queued: true,
			position,
			sessionId,
			elapsedMs: Date.now() - receivedAt,
		});
	}

	/**
	 * Boot recovery (PON-112): arm a bounded grace window for a restored
	 * active session with no live runner, and drain lanes left free with a
	 * non-empty queue (crash between release and start). A paying client must
	 * never sit behind a dead session.
	 */
	private armLaneBootRecovery(): void {
		for (const workspaceId of this.laneManager.workspaceIds()) {
			const activeSessionIds = this.laneManager.activeSessionsOf(workspaceId);
			const activeSessionId = activeSessionIds.find(
				(held) => !this.agentSessionManager.getSession(held)?.agentRunner,
			);
			if (activeSessionIds.length > 0) {
				// Arm the window if ANY holder came back without a runner; expiry
				// sweeps all of them.
				if (!activeSessionId) {
					continue;
				}
				const deadline = new Date(
					Date.now() + EdgeWorker.LANE_BOOT_GRACE_MS,
				).toISOString();
				this.laneManager.setGraceDeadline(workspaceId, deadline);
				this.logger.event("lane_grace_armed", {
					workspaceId,
					sessionId: activeSessionId,
					deadline,
				});
				const timer = setTimeout(() => {
					void this.fireLaneGrace(workspaceId).catch((error) => {
						this.logger.error(
							`Lane grace handling failed for workspace ${workspaceId}:`,
							error,
						);
					});
				}, EdgeWorker.LANE_BOOT_GRACE_MS);
				timer.unref?.();
				this.laneGraceTimers.set(workspaceId, timer);
			} else if (this.laneManager.queueLength(workspaceId) > 0) {
				void this.startNextInLane(workspaceId).catch((error) => {
					this.logger.error(
						`Failed to drain lane queue for workspace ${workspaceId} on boot:`,
						error,
					);
				});
			}
		}
	}

	/**
	 * Grace window expired: release every stalled holder and move on.
	 *
	 * Takes only the workspace. The session the timer was armed for is no longer
	 * special — with a lane admitting N, any restored holder whose runner never
	 * came back is stalled, and releasing one while leaving the others would
	 * leak slots that nothing else ever frees.
	 */
	private async fireLaneGrace(workspaceId: string): Promise<void> {
		this.laneGraceTimers.delete(workspaceId);

		// Sweep every holder without a live runner, not only the one the timer
		// was armed for. A lane may admit N (PON-139); releasing a single session
		// would leave the other restored-but-dead holders occupying slots
		// permanently, which is the leak this grace window exists to prevent.
		const stalled = this.laneManager
			.activeSessionsOf(workspaceId)
			.filter(
				(held) =>
					!this.agentSessionManager
						.getSession(held)
						?.agentRunner?.isRunning?.(),
			);

		if (stalled.length === 0) {
			this.laneManager.setGraceDeadline(workspaceId, null);
			return;
		}

		for (const held of stalled) {
			this.logger.event("lane_grace_released", {
				workspaceId,
				sessionId: held,
			});
			await this.activityPoster.postLaneGraceReleaseNotice(held, workspaceId);
			this.releaseLaneAndContinue(workspaceId, held, "boot_grace_expired");
		}
	}

	private clearLaneGrace(workspaceId: string): void {
		const timer = this.laneGraceTimers.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
			this.laneGraceTimers.delete(workspaceId);
		}
		this.laneManager.setGraceDeadline(workspaceId, null);
	}

	/** Clear a pending grace window when the holding session's runner starts. */
	private clearLaneGraceForSession(sessionId: string): void {
		const workspaceId = this.laneManager.workspaceOf(sessionId);
		if (workspaceId && this.laneManager.isActive(sessionId)) {
			this.clearLaneGrace(workspaceId);
		}
	}

	/**
	 * Initialize and start agent runner for an agent session
	 * This method contains the shared logic for creating an agent runner that both
	 * handleAgentSessionCreatedWebhook and handleUserPromptedAgentActivity use.
	 *
	 * @param agentSession The Linear agent session
	 * @param repositories Repository configurations (primary repo is repositories[0])
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 * @param guidance Optional guidance rules from Linear
	 * @param commentBody Optional comment body (for mentions)
	 * @param baseBranchOverrides Per-repo base branch overrides from [repo=name#branch] syntax
	 */
	private async initializeAgentRunner(
		agentSession: AgentSessionCreatedWebhook["agentSession"],
		repositories: RepositoryConfig[],
		linearWorkspaceId: string,
		guidance?: AgentSessionCreatedWebhook["guidance"],
		commentBody?: string | null,
		baseBranchOverrides?: Map<string, string>,
		routingMethod?: string,
	): Promise<void> {
		const sessionId = agentSession.id;
		const { issue } = agentSession;

		if (!issue) {
			this.logger.warn("Cannot initialize Claude runner without issue");
			return;
		}

		// PON-138: capture the replay arguments. A retry re-enters here, so
		// the attempt counter is preserved across replays.
		const existingRetry = this.startupRetryState.get(sessionId);
		this.startupRetryState.set(sessionId, {
			args: [
				agentSession,
				repositories,
				linearWorkspaceId,
				guidance,
				commentBody,
				baseBranchOverrides,
				routingMethod,
			],
			attempts: existingRetry?.attempts ?? 0,
			firstFailureAt: existingRetry?.firstFailureAt,
		});

		const primaryRepo = repositories[0]!;

		const log = this.logger.withContext({
			sessionId,
			issueIdentifier: issue.identifier,
			workspaceId: linearWorkspaceId,
		});

		// Log guidance if present
		if (guidance && guidance.length > 0) {
			log.debug(`Agent guidance received: ${guidance.length} rule(s)`);
			for (const rule of guidance) {
				let origin = "Unknown";
				if (rule.origin) {
					if (rule.origin.__typename === "TeamOriginWebhookPayload") {
						origin = `Team: ${rule.origin.team.displayName}`;
					} else {
						origin = "Organization";
					}
				}
				log.info(`- ${origin}: ${rule.body.substring(0, 100)}...`);
			}
		}

		// HACK: This is required since the comment body is always populated, thus there is no other way to differentiate between the two trigger events
		const isMentionTriggered =
			commentBody && !commentBody.includes(AGENT_SESSION_THREAD_MARKER);
		// Check if the comment contains the /label-based-prompt command
		const isLabelBasedPromptRequested = commentBody?.includes(
			"/label-based-prompt",
		);

		// Operator cockpit (PON-151): a starting delegated session mirrors as
		// `active`. Mentions are conversations, not delegations — not
		// mirrored, and remembered so their end never closes the mirror.
		if (isMentionTriggered) {
			this.mentionSessionIds.add(sessionId);
		}
		if (!isMentionTriggered) {
			void this.cockpitMirror.upsert(
				{
					issueId: issue.id,
					issueIdentifier: issue.identifier,
					title: issue.title,
					url: (issue as { url?: string }).url,
				},
				linearWorkspaceId,
				// PON-224: a runner on a parked issue is conversation (the
				// approval confirmation, a follow-up question) — the work has
				// not started, and the mirror stays in the Queued column.
				this.scopeApprovals.isImplementationDeferred(issue.id)
					? "queued"
					: "active",
			);
		}

		const agentSessionManager = this.agentSessionManager;

		// NOTE: The instant acknowledgment is NOT posted here. Every caller has
		// already posted its first activity by this point (created webhook ack,
		// repository selection ack, or parked-session wake thought), so posting
		// here would double-ack.

		// Create the session using the shared method (pass full repositories array)
		const sessionData = await this.createCyrusAgentSession(
			sessionId,
			issue,
			repositories,
			agentSessionManager,
			linearWorkspaceId,
			baseBranchOverrides,
			routingMethod,
		);

		// Destructure the session data (excluding allowedTools which we'll build with promptType)
		const {
			session,
			fullIssue,
			workspace: _workspace,
			attachmentResult,
			attachmentsDir: _attachmentsDir,
			allowedDirectories,
		} = sessionData;

		// Fetch labels early (needed for system prompt and runner selection)
		const labels = await this.fetchIssueLabels(fullIssue);

		log.info(`Starting agent session for issue ${fullIssue.identifier}`);

		// Build and start Claude with initial prompt using full issue (streaming mode)
		log.info(`Building initial prompt for issue ${fullIssue.identifier}`);
		try {
			// Create input for unified prompt assembly
			const input: PromptAssemblyInput = {
				session,
				fullIssue,
				repositories,
				repository: primaryRepo,
				userComment: commentBody || "", // Empty for delegation, present for mentions
				attachmentManifest: attachmentResult.manifest,
				guidance: guidance || undefined,
				agentSession,
				labels,
				isNewSession: true,
				isStreaming: false, // Not yet streaming
				isMentionTriggered: isMentionTriggered || false,
				isLabelBasedPromptRequested: isLabelBasedPromptRequested || false,
				resolvedBaseBranches: sessionData.workspace.resolvedBaseBranches,
				linearWorkspaceId,
			};

			// Use unified prompt assembly
			const assembly = await this.assemblePrompt(input);

			// Get systemPromptVersion for tracking (TODO: add to PromptAssembly metadata)
			let systemPromptVersion: string | undefined;
			let promptType:
				| "debugger"
				| "builder"
				| "scoper"
				| "orchestrator"
				| "graphite-orchestrator"
				| undefined;

			if (!isMentionTriggered || isLabelBasedPromptRequested) {
				const systemPromptResult = await this.determineSystemPromptFromLabels(
					labels,
					primaryRepo,
				);
				systemPromptVersion = systemPromptResult?.version;
				promptType = systemPromptResult?.type;

				// Post thought about system prompt selection
				if (assembly.systemPrompt) {
					await this.postSystemPromptSelectionThought(
						sessionId,
						labels,
						linearWorkspaceId,
						primaryRepo.id,
					);
				}
			}

			// Build allowed tools list with Linear MCP tools (now with prompt type context)
			const allowedTools = this.buildAllowedTools(repositories, promptType);
			const disallowedTools = this.buildDisallowedTools(
				repositories,
				promptType,
			);

			log.debug(
				`Configured allowed tools for ${fullIssue.identifier}:`,
				allowedTools,
			);
			if (disallowedTools.length > 0) {
				log.debug(
					`Configured disallowed tools for ${fullIssue.identifier}:`,
					disallowedTools,
				);
			}

			// Create agent runner with system prompt from assembly
			// buildAgentRunnerConfig now determines runner type from labels internally
			const { config: runnerConfig, runnerType } =
				await this.buildAgentRunnerConfig(
					session,
					primaryRepo,
					sessionId,
					assembly.systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					labels, // Pass labels for runner selection and model override
					fullIssue.description || undefined, // Description tags can override label selectors
					undefined, // maxTurns
					linearWorkspaceId,
					this.buildSkillSessionContext(primaryRepo, fullIssue, session),
				);

			log.debug(
				`Label-based runner selection for new session: ${runnerType} (session ${sessionId})`,
			);

			const runner = this.createRunnerForType(runnerType, runnerConfig);

			// Store runner by comment ID
			agentSessionManager.addAgentRunner(sessionId, runner);

			// Save state after mapping changes
			await this.savePersistedState();

			// Emit events using full issue (core Issue type)
			this.emit("session:started", fullIssue.id, fullIssue, primaryRepo.id);
			this.config.handlers?.onSessionStart?.(
				fullIssue.id,
				fullIssue,
				primaryRepo.id,
			);

			// Update runner with version information (if available)
			// Note: updatePromptVersions is specific to ClaudeRunner
			if (
				systemPromptVersion &&
				"updatePromptVersions" in runner &&
				typeof runner.updatePromptVersions === "function"
			) {
				runner.updatePromptVersions({
					systemPromptVersion,
				});
			}

			// Log metadata for debugging
			log.debug(
				`Initial prompt built successfully - components: ${assembly.metadata.components.join(", ")}, type: ${assembly.metadata.promptType}, length: ${assembly.userPrompt.length} characters`,
			);

			// Start session - use streaming mode if supported for ability to add messages later
			if (runner.supportsStreamingInput && runner.startStreaming) {
				log.debug(`Starting streaming session`);
				const sessionInfo = await runner.startStreaming(assembly.userPrompt);
				log.debug(`Streaming session started: ${sessionInfo.sessionId}`);
			} else {
				log.debug(`Starting non-streaming session`);
				const sessionInfo = await runner.start(assembly.userPrompt);
				log.debug(`Non-streaming session started: ${sessionInfo.sessionId}`);
			}
			// Note: AgentSessionManager will be initialized automatically when the first system message
			// is received via handleClaudeMessage() callback
		} catch (error) {
			log.error(`Error in prompt building/starting:`, error);
			throw error;
		}
	}

	/**
	 * Handle stop signal from prompted webhook
	 * Branch 1 of agentSessionPrompted (see packages/CLAUDE.md)
	 *
	 * IMPORTANT: Stop signals do NOT require repository lookup.
	 * The session must already exist (per CLAUDE.md), so we search
	 * all agent session managers to find it.
	 */
	private async handleStopSignal(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const agentSessionId = webhook.agentSession.id;
		const { issue } = webhook.agentSession;
		const log = this.logger.withContext({ sessionId: agentSessionId });

		log.info(
			`Received stop signal for agent activity session ${agentSessionId}`,
		);

		// Find the session in the single session manager
		const foundSession = this.agentSessionManager.getSession(agentSessionId);

		if (!foundSession) {
			// Legacy recovery: session lost after restart/migration
			// Post acknowledgment so the user doesn't see a hanging state
			log.info(
				`No session found for stop signal ${agentSessionId} (likely a legacy session after restart)`,
			);

			const issueTitle = issue?.title || "this issue";
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				`Stop signal received for ${issueTitle}. No active session was found (the session may have ended or the system was restarted). No further action is needed.`,
			);
			return;
		}

		// Double-stop detection: two stop signals within 10s → full abort
		const now = Date.now();
		const lastStop = this.lastStopTimeBySession.get(agentSessionId);
		const isDoubleStop = lastStop !== undefined && now - lastStop < 10_000;
		this.lastStopTimeBySession.set(agentSessionId, now);

		const existingRunner = foundSession.agentRunner;
		const issueTitle = issue?.title || "this issue";
		// Same attribution lesson as the release check: on a mirror thread the
		// session's `creator` is unset, so the confirmation used to thank
		// "user" for stopping a run they had just rescued.
		const senderName =
			resolveMirrorActor(webhook).name ||
			webhook.agentSession.creator?.name ||
			"user";

		// Only warm sessions can be safely interrupted without killing the
		// underlying request. Non-warm sessions get a single-shot full stop —
		// calling interrupt() on them surfaces a "Request was aborted" error
		// from the SDK (see CYPACK-1145).
		const supportsInterrupt = Boolean(
			existingRunner?.interrupt && existingRunner?.isWarm?.(),
		);

		if (isDoubleStop || !supportsInterrupt) {
			// Either a second stop within window, or a non-warm runner — full kill
			this.agentSessionManager.requestSessionStop(agentSessionId);
			if (existingRunner) {
				existingRunner.stop();
				log.info(
					isDoubleStop
						? `Double-stop: fully aborted session ${agentSessionId}`
						: `Stopped session ${agentSessionId} (interrupt not supported)`,
				);
			}
			this.lastStopTimeBySession.delete(agentSessionId);
			// PON-112: an aborted runner emits neither a result message nor an
			// "error" event (ClaudeRunner swallows user aborts and SIGTERM as
			// normal stops), so the lane must release here explicitly. The
			// soft-interrupt branch below deliberately does NOT release — the
			// session stays warm and in progress.
			this.handleLaneSessionEnded(agentSessionId, "stop_signal");
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				isDoubleStop
					? `I've fully stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName} (second stop)\n**Action Taken:** Session terminated`
					: `I've stopped working on ${issueTitle}.\n\n**Stop Signal:** Received from ${senderName}\n**Action Taken:** Session terminated`,
			);
		} else {
			// First stop on a warm session — interrupt current turn, keep session warm
			await existingRunner!.interrupt!();
			log.info(
				`Interrupted current turn for session ${agentSessionId} (send stop again within 10s to fully terminate)`,
			);
			await this.agentSessionManager.createResponseActivity(
				agentSessionId,
				`Interrupted by ${senderName}\n**Tip:** Type and send "stop" within 10 seconds to fully terminate the session.`,
			);
		}
	}

	/**
	 * Handle repository selection response from prompted webhook
	 * Branch 2 of agentSessionPrompted (see packages/CLAUDE.md)
	 *
	 * This method extracts the user's repository selection from their response,
	 * or uses the fallback repository if their message doesn't match any option.
	 * In both cases, the selected repository is cached for future use.
	 */
	private async handleRepositorySelectionResponse(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const { agentSession, agentActivity, guidance } = webhook;
		const commentBody = agentSession.comment?.body;
		const agentSessionId = agentSession.id;
		const log = this.logger.withContext({ sessionId: agentSessionId });

		if (!agentActivity) {
			log.warn("Cannot handle repository selection without agentActivity");
			return;
		}

		if (!agentSession.issue) {
			log.warn("Cannot handle repository selection without issue");
			return;
		}

		const userMessage = agentActivity.content.body;

		log.debug(`Processing repository selection response: "${userMessage}"`);

		// Acknowledge the selection response before initializing the runner —
		// initializeAgentRunner no longer posts an acknowledgment itself, and
		// runner startup involves repo work that must not delay first activity.
		await this.postInstantPromptedAcknowledgment(
			agentSessionId,
			webhook.organizationId,
			false,
		);
		this.logger.event("session_ack_posted", {
			kind: "repository_selection",
			sessionId: agentSessionId,
		});

		// Get the selected repository (or fallback)
		const repository = await this.repositoryRouter.selectRepositoryFromResponse(
			agentSessionId,
			userMessage,
		);

		if (!repository) {
			// Ambiguous-route reply that matched no candidate. The router kept
			// the pending selection alive rather than guessing one; re-post the
			// Select so a click still resolves it. If there is no pending
			// selection (a stale reply), this is a no-op.
			log.warn(
				`Repository selection unresolved for ${agentSessionId} — re-asking, not guessing`,
			);
			await this.repositoryRouter.repostPendingSelection(
				agentSessionId,
				webhook.organizationId,
			);
			return;
		}

		// Cache the selected repository for this issue as string[]
		const issueId = agentSession.issue.id;
		this.repositoryRouter
			.getIssueRepositoryCache()
			.set(issueId, [repository.id]);

		log.debug(
			`Initializing agent runner after repository selection: ${agentSession.issue.identifier} -> ${repository.name}`,
		);

		// Initialize agent runner with the selected repository (wrapped in array)
		// routingMethod="user-selected" will be included in the combined routing activity
		// Use organizationId from webhook as the Linear-native workspace ID source
		await this.initializeAgentRunner(
			agentSession,
			[repository],
			webhook.organizationId,
			guidance,
			commentBody,
			undefined,
			"user-selected",
		);
	}

	/**
	 * Handle AskUserQuestion response from prompted webhook
	 * Branch 2.5: User response to a question posed via AskUserQuestion tool
	 *
	 * @param webhook The prompted webhook containing user's response
	 */
	private async handleAskUserQuestionResponse(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const { agentSession, agentActivity } = webhook;
		const agentSessionId = agentSession.id;

		if (!agentActivity) {
			this.logger.warn(
				"Cannot handle AskUserQuestion response without agentActivity",
			);
			// Resolve with a denial to unblock the waiting promise
			this.askUserQuestionHandler.cancelPendingQuestion(
				agentSessionId,
				"No agent activity in webhook",
			);
			return;
		}

		// Extract the user's response from the activity body
		const userResponse = agentActivity.content?.body || "";

		this.logger.debug(
			`Processing AskUserQuestion response for session ${agentSessionId}: "${userResponse}"`,
		);

		// PON-172: any client reply on an issue with an open needs-info wait
		// IS the answer — mark it before the session resumes.
		this.markNeedsInfoAnswered(
			agentSession.issue?.id ?? this.sessionIssueId(agentSessionId),
			webhook.organizationId,
			agentSession.issue?.identifier,
		);

		// Pass the response to the handler to resolve the waiting promise
		const handled = this.askUserQuestionHandler.handleUserResponse(
			agentSessionId,
			userResponse,
		);

		if (!handled) {
			this.logger.warn(
				`AskUserQuestion response not handled for session ${agentSessionId} (no pending question)`,
			);
		} else {
			this.logger.debug(
				`AskUserQuestion response handled for session ${agentSessionId}`,
			);
		}
	}

	/**
	 * Mark an open needs-info wait answered (PON-172). Idempotent: only the
	 * real awaiting→answered transition logs, persists, and updates the
	 * mirror — replayed webhooks change nothing. Called from BOTH answer
	 * paths: the pending-question resolution and (post-restart, when the
	 * pending question is gone from memory) the normal prompted path whose
	 * resume carries the answer as context.
	 */
	private markNeedsInfoAnswered(
		issueId: string | undefined,
		workspaceId: string,
		issueIdentifier?: string,
	): void {
		if (!issueId) return;
		if (!this.needsInfo.recordAnswered(issueId)) return;
		this.logger.event("needs_info_answered", {
			issueId,
			issueIdentifier:
				issueIdentifier ?? this.needsInfo.get(issueId)?.issueIdentifier,
			workspaceId,
			askedAt: this.needsInfo.get(issueId)?.askedAt,
			answeredAt: this.needsInfo.get(issueId)?.answeredAt,
		});
		void this.persistScopeApprovals("needs_info_answered");
		// A needs-info answer that lands on ALREADY-HELD work re-opens the
		// review turn (the reviewer asked the client from the held state; the
		// mirror session resumes and will re-hold). The FIRST hold's two
		// once-guards must be cleared, or the re-hold is broken two ways:
		//  1. `verificationSignedOff` blocks signOffIntoVerification, so no
		//     closing hand-off is posted — the resumed turn never closes and
		//     the session shows as "working" forever (seen live on FRO-65).
		//  2. when the work is unchanged, composeVerificationMirror's
		//     "note unchanged" early-return (keyed on `lastReviewBlock`) skips
		//     the state upsert, so the mirror stays `active` instead of
		//     returning to `in-verification`.
		// Same rationale as reject (PON-221): the next hold is a genuinely new
		// turn and must say so again. Only fires when the issue was actually
		// held, so scope-conversation needs-info is unaffected.
		if (this.verificationGate.get(issueId)) {
			this.verificationSignedOff.delete(issueId);
			this.lastReviewBlock.delete(issueId);
			this.logger.event("verification_reopened_for_answer", {
				issueId,
				issueIdentifier:
					issueIdentifier ?? this.needsInfo.get(issueId)?.issueIdentifier,
			});
		}
		void this.cockpitMirror.upsert(
			{
				issueId,
				issueIdentifier:
					issueIdentifier ?? this.needsInfo.get(issueId)?.issueIdentifier,
			},
			workspaceId,
			// PON-224: an answer on a parked issue does not start the work.
			this.scopeApprovals.isImplementationDeferred(issueId)
				? "queued"
				: "active",
		);
	}

	/**
	 * Handle normal prompted activity (existing session continuation)
	 * Branch 3 of agentSessionPrompted (see packages/CLAUDE.md)
	 */
	private async handleNormalPromptedActivity(
		webhook: AgentSessionPromptedWebhook,
		repositories: RepositoryConfig[],
	): Promise<void> {
		const repository = repositories[0]!;
		const { agentSession } = webhook;
		const sessionId = agentSession.id;
		const { issue } = agentSession;
		// Use organizationId from webhook as the Linear-native workspace ID source
		const linearWorkspaceId = webhook.organizationId;

		if (!issue) {
			this.logger.warn("Cannot handle prompted activity without issue");
			return;
		}

		if (!webhook.agentActivity) {
			this.logger.warn("Cannot handle prompted activity without agentActivity");
			return;
		}

		// PON-172: after a restart the pending question is gone from memory,
		// so the client's answer arrives here as a normal prompt — the resume
		// carries it as context. The open wait is answered either way.
		this.markNeedsInfoAnswered(issue.id, linearWorkspaceId, issue.identifier);

		const commentId = webhook.agentActivity.sourceCommentId;

		const agentSessionManager = this.agentSessionManager;

		let session = agentSessionManager.getSession(sessionId);
		let isNewSession = false;
		let fullIssue: Issue | null = null;

		if (!session) {
			this.logger.debug(
				`No existing session found for agent activity session ${sessionId}, creating new session`,
			);
			isNewSession = true;

			// Acknowledgment already posted in handleUserPromptedAgentActivity

			// Create the session using the shared method with all repositories
			const sessionData = await this.createCyrusAgentSession(
				sessionId,
				issue,
				repositories,
				agentSessionManager,
				linearWorkspaceId,
			);

			// Destructure session data for new session
			fullIssue = sessionData.fullIssue;
			session = sessionData.session;

			this.logger.debug(`Created new session ${sessionId} (prompted webhook)`);

			// Save state and emit events for new session
			await this.savePersistedState();
			// Emit events using full issue (core Issue type)
			this.emit("session:started", fullIssue.id, fullIssue, repository.id);
			this.config.handlers?.onSessionStart?.(
				fullIssue.id,
				fullIssue,
				repository.id,
			);
		} else {
			this.logger.debug(
				`Found existing session ${sessionId} for new user prompt`,
			);

			// Acknowledgment already posted in handleUserPromptedAgentActivity

			// Need to fetch full issue for routing context
			const issueTracker = this.issueTrackers.get(linearWorkspaceId);
			if (issueTracker) {
				try {
					fullIssue = await issueTracker.fetchIssue(issue.id);
				} catch (error) {
					this.logger.warn(
						`Failed to fetch full issue for routing: ${issue.id}`,
						error,
					);
					// Continue with degraded routing context
				}
			}
		}

		// Note: Streaming check happens later in handlePromptWithStreamingCheck
		// after attachments are processed

		// Ensure session is not null after creation/retrieval
		if (!session) {
			throw new Error(
				`Failed to get or create session for agent activity session ${sessionId}`,
			);
		}

		// Acknowledgment already posted in handleUserPromptedAgentActivity
		// (before repository resolution, to ensure instant user feedback)

		// Get issue tracker using workspace ID from webhook context
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			this.logger.error(
				"Unexpected: There was no IssueTrackerService for workspace",
				linearWorkspaceId,
			);
			return;
		}

		// Always set up attachments directory, even if no attachments in current comment
		const workspaceFolderName = basename(session.workspace.path);
		const attachmentsDir = getAttachmentsDir(
			this.cyrusHome,
			workspaceFolderName,
			linearWorkspaceId,
		);
		// Ensure directory exists
		await mkdir(attachmentsDir, { recursive: true });

		let attachmentManifest = "";
		let commentAuthor: string | undefined;
		let commentTimestamp: string | undefined;

		if (!commentId) {
			this.logger.warn("No comment ID provided for attachment handling");
		}

		try {
			const comment = commentId
				? await issueTracker.fetchComment(commentId)
				: null;

			// Extract comment metadata for multi-player context
			if (comment) {
				const user = await comment.user;
				commentAuthor =
					user?.displayName || user?.name || user?.email || "Unknown";
				commentTimestamp = comment.createdAt
					? comment.createdAt.toISOString()
					: new Date().toISOString();
			}

			// Count existing attachments
			const existingFiles = await readdir(attachmentsDir).catch(() => []);
			const existingAttachmentCount = existingFiles.filter(
				(file) => file.startsWith("attachment_") || file.startsWith("image_"),
			).length;

			// Download new attachments from the comment
			const linearTokenForAttachments =
				this.getLinearTokenForWorkspace(linearWorkspaceId);
			const downloadResult = comment
				? await this.downloadCommentAttachments(
						comment.body,
						attachmentsDir,
						linearTokenForAttachments,
						existingAttachmentCount,
					)
				: {
						totalNewAttachments: 0,
						newAttachmentMap: {},
						newImageMap: {},
						failedCount: 0,
					};

			if (downloadResult.totalNewAttachments > 0) {
				attachmentManifest = this.generateNewAttachmentManifest(downloadResult);
			}
		} catch (error) {
			this.logger.error("Failed to fetch comments for attachments:", error);
		}

		const promptBody = webhook.agentActivity.content.body;

		// Use centralized streaming check and routing logic
		try {
			await this.handlePromptWithStreamingCheck(
				session,
				repository,
				sessionId,
				agentSessionManager,
				promptBody,
				attachmentManifest,
				isNewSession,
				[], // No additional allowed directories for regular continuation
				`prompted webhook (${isNewSession ? "new" : "existing"} session)`,
				linearWorkspaceId,
				commentAuthor,
				commentTimestamp,
			);
		} catch (error) {
			this.logger.error("Failed to handle prompted webhook:", error);
		}
	}

	/**
	 * Handle user-prompted agent activity webhook
	 * Implements three-branch architecture from packages/CLAUDE.md:
	 *   1. Stop signal - terminate existing runner
	 *   2. Repository selection response - initialize Claude runner for first time
	 *   3. Normal prompted activity - continue existing session or create new one
	 *
	 * @param webhook The prompted webhook containing user's message
	 */
	private async handleUserPromptedAgentActivity(
		webhook: AgentSessionPromptedWebhook,
	): Promise<void> {
		const receivedAt = Date.now();
		const agentSessionId = webhook.agentSession.id;
		const activityBody = webhook.agentActivity?.content?.body || "";
		const signal = (webhook.agentActivity as any)?.signal;

		const isTextStopRequestEarly =
			/^\s*stop(\s+session|\s+working)?[\s.!?]*$/i.test(activityBody);

		// A STOP outranks the mirror intercept (PON-229 punch list).
		//
		// The intercept below used to come first and return unconditionally,
		// so on a mirror thread the stop never reached its handler — and
		// Linear's own Stop button sends an empty body, which
		// `classifyMirrorIntent` reads as `orient`, a CLAIM. Pressing Stop on
		// a runaway mirror session therefore announced "I am taking this" and
		// let it keep running; typing "stop" was sent in as work. The one
		// control a reviewer needs against a session burning budget on the
		// client's repository was the one control that did nothing.
		//
		// Ordered here rather than handled inside `handleMirrorAction`: a stop
		// is not an operator *action* on the work, it is a control on the
		// runner, and the existing handler already resolves mirror sessions
		// (they are registered in the same session manager) and closes the
		// turn with a confirmation.
		if (signal === "stop" || isTextStopRequestEarly) {
			if (this.laneManager.isQueued(agentSessionId)) {
				await this.handleQueuedSessionStop(webhook);
				return;
			}
			await this.handleStopSignal(webhook);
			return;
		}

		// PON-152: replies in a mirror issue's thread are operator actions
		// too — the failure report says "approve again to retry", and the
		// natural place to type that is the same thread. Without this, a
		// mirror reply would fall to normal routing and start a model
		// session on a derived-view issue.
		const mirrorIssueIdForPrompt = webhook.agentSession?.issue?.id;
		if (mirrorIssueIdForPrompt) {
			const mirrorClientIssueId = this.cockpitMirror.clientIssueIdFor(
				mirrorIssueIdForPrompt,
			);
			if (mirrorClientIssueId) {
				// PON-237: the ACTIVITY carries who typed it; the session's
				// `creator` is unset by design on the very threads a reviewer
				// works in. See resolveMirrorActor.
				const actor = resolveMirrorActor(webhook);
				await this.handleMirrorAction(
					{
						organizationId: webhook.organizationId,
						mirrorSessionId: agentSessionId,
						actorId: actor.id,
						actorName: actor.name,
						rawBody: activityBody,
					},
					mirrorClientIssueId,
				);
				return;
			}
		}
		// (A second stop branch used to sit here. It became unreachable when
		// the stop moved above the mirror intercept in #99 — same locals, same
		// regex — and is gone.)

		// Branch 1.5: Handle re-prompt for parked (blocked-by) sessions
		// When a user re-prompts and the session is parked, re-check blocking status.
		// If blockers are resolved, wake the session immediately.
		const issueIdForParkedCheck = webhook.agentSession?.issue?.id;
		if (
			issueIdForParkedCheck &&
			this.parkedSessions.has(issueIdForParkedCheck)
		) {
			await this.handleParkedSessionReprompt(webhook, issueIdForParkedCheck);
			return;
		}

		// Branch 1.7: Prompts on lane-queued sessions (PON-112) — reorder
		// intent moves the session to the front; anything else is stored as
		// context. Must come before the generic prompted flow: a queued
		// session has no runner to stream into.
		if (this.laneManager.isQueued(agentSessionId)) {
			await this.handleQueuedSessionPrompt(webhook, receivedAt);
			return;
		}

		// Branch 2: Handle repository selection response
		// This is the first Claude runner initialization after user selects a repository.
		// The selection handler extracts the choice from the response (or uses fallback)
		// and caches the repository for future use.
		if (this.repositoryRouter.hasPendingSelection(agentSessionId)) {
			await this.handleRepositorySelectionResponse(webhook);
			return;
		}

		// v3.1 P2: the client's answer to a question the MIRROR asked. The
		// question is parked under the mirror session, so this thread has no
		// pending question of its own — and the old fallthrough resumed the
		// CLIENT session with the answer: a second runner on the same branch,
		// talking on the one thread that must stay quiet until delivery.
		const relayIssueId = webhook.agentSession?.issue?.id;
		const relayWait = relayIssueId
			? this.needsInfo.get(relayIssueId)
			: undefined;
		if (
			relayIssueId &&
			relayWait?.state === "awaiting" &&
			relayWait.relaySessionId &&
			!this.askUserQuestionHandler.hasPendingQuestion(agentSessionId)
		) {
			await this.relayClientAnswerToMirror(webhook, relayIssueId, relayWait);
			return;
		}

		// Branch 2.5: Handle AskUserQuestion response
		// This handles responses to questions posed via the AskUserQuestion tool.
		// The response is passed to the pending promise resolver.
		if (this.askUserQuestionHandler.hasPendingQuestion(agentSessionId)) {
			// PON-150: interpret the reply against the posted options BEFORE
			// lane admission, so approvedAt — the SLA clock start — is the
			// answer's arrival, not whenever a queued resume replays.
			await this.interpretScopeConfirmReply(webhook);
			// PON-236: and a client confirming a change to work they have
			// already been given, which reopens it rather than starting
			// anything new.
			await this.interpretReworkReply(webhook);
			// PON-113: the session gave up its lane when it asked, so another
			// issue may be running now. Re-enter the lane before resuming;
			// when it is busy this enqueues and replays on dequeue, so two
			// sessions never work at once.
			const admitted = await this.admitAnsweredSessionToLane(
				webhook,
				receivedAt,
			);
			if (!admitted) return;
			await this.handleAskUserQuestionResponse(webhook);
			return;
		}

		// PON-150 restart fallback: a pending elicitation does not survive a
		// restart in memory, so a canonical "Approve scope" / "Revise scope"
		// reply arriving with no pending question is still recorded — a
		// confirmed issue must never re-ask just because the box restarted
		// mid-elicitation. The reply then flows on as a normal prompt.
		await this.interpretScopeConfirmReply(webhook);
		// Same fallback for a rework confirmation (v3.1): the canonical
		// "Yes, make this change" arriving with no pending ask still reopens
		// the work instead of flowing on as a plain prompt.
		await this.interpretReworkReply(webhook);

		// Branch 3: Handle normal prompted activity (existing session continuation)
		// Per CLAUDE.md: "an agentSession MUST exist and a repository MUST already
		// be associated with the Linear issue. The repository will be retrieved from
		// the issue-to-repository cache - no new routing logic is performed."
		const issueId = webhook.agentSession?.issue?.id;
		if (!issueId) {
			this.logger.error(
				`No issue ID found in prompted webhook ${agentSessionId}`,
			);
			return;
		}

		// v3.1 finding G: while the MIRROR owns the run, the client's own
		// thread runs nothing. Before this, "any news?" on the client's thread
		// resumed the client's scoping session as an implementing session in
		// the same worktree — a second runner on the same branch, talking on
		// the one thread that must stay quiet, with no rule telling it the
		// work was happening elsewhere. The words go to the reviewer instead.
		const owningLink = this.operatorSessions.forClientIssue(issueId);
		if (
			owningLink?.ownsDelivery &&
			agentSessionId !== owningLink.mirrorSessionId
		) {
			const held = this.verificationGate.get(issueId);
			if (!held || held.state !== "delivered") {
				await this.relayClientMessageToMirror(webhook, issueId, owningLink);
				return;
			}
		}

		// PON-112: lane admission for resumes. "At most one active session per
		// workspace" applies to resumes too — a prompt that would resume work
		// on a non-running session while a DIFFERENT session holds the lane is
		// enqueued instead (the prompt travels as the resume payload). Lane
		// free → acquire, so quick follow-ups on delivered work still start
		// instantly whenever the queue is empty. Child sessions bypass (the
		// parent blocks on them); a session already running keeps streaming.
		const workspaceId = webhook.organizationId;
		let resumeLaneHeld = false;
		if (
			this.laneManager.isEnabled(workspaceId) &&
			!this.globalSessionRegistry.getParentSessionId(agentSessionId)
		) {
			const holder = this.laneManager.activeSessionOf(workspaceId);
			const isSessionRunning =
				this.agentSessionManager
					.getSession(agentSessionId)
					?.agentRunner?.isRunning() === true;
			if (holder === agentSessionId) {
				resumeLaneHeld = true;
			} else if (!isSessionRunning) {
				if (holder !== null) {
					const position = this.laneManager.enqueue(workspaceId, {
						sessionId: agentSessionId,
						issueId,
						issueIdentifier: webhook.agentSession.issue?.identifier,
						enqueuedAt: new Date().toISOString(),
						webhook,
						kind: "resume",
					});
					try {
						await this.savePersistedStateStrict();
					} catch (error) {
						this.laneManager.removeQueued(agentSessionId);
						this.logger.event("lane_enqueue_persist_failed", {
							workspaceId,
							sessionId: agentSessionId,
						});
						throw error;
					}
					await this.activityPoster.postQueuedAcknowledgment(
						agentSessionId,
						workspaceId,
						position,
					);
					this.logger.event("session_ack_posted", {
						kind: "prompted",
						queued: true,
						position,
						sessionId: agentSessionId,
						elapsedMs: Date.now() - receivedAt,
					});
					return;
				}
				this.laneManager.acquire(workspaceId, agentSessionId);
				resumeLaneHeld = true;
			}
			// holder !== session && session running: legacy overlap — the
			// session is already working outside the lane; deliver the prompt
			// to the running stream rather than queueing it out from under it.
		}

		try {
			await this.runNormalPromptedFlow(webhook, receivedAt, issueId);
		} finally {
			// Backstop (PON-112): if this resume took (or held) the lane but no
			// runner ended up running — repository recovery failed, blocked
			// user, thrown error — free the lane so queued work continues.
			if (
				resumeLaneHeld &&
				!this.agentSessionManager
					.getSession(agentSessionId)
					?.agentRunner?.isRunning()
			) {
				this.releaseLaneAndContinue(
					workspaceId,
					agentSessionId,
					"resume_not_started",
				);
			}
		}
	}

	/**
	 * The pre-PON-112 tail of handleUserPromptedAgentActivity: prompted ack,
	 * repository resolution, access check, and the normal prompted flow.
	 * Split out so the lane admission above can wrap it with a release
	 * backstop.
	 */
	private async runNormalPromptedFlow(
		webhook: AgentSessionPromptedWebhook,
		receivedAt: number,
		issueId: string,
	): Promise<void> {
		const agentSessionId = webhook.agentSession.id;

		// Acknowledge before repository resolution — the cache-miss fallback
		// below can hit the Linear API, and session creation later does repo
		// work. Same 10-second responsiveness contract as session creation.
		const isCurrentlyStreaming =
			this.agentSessionManager
				.getSession(agentSessionId)
				?.agentRunner?.isRunning() || false;
		await this.postInstantPromptedAcknowledgment(
			agentSessionId,
			webhook.organizationId,
			isCurrentlyStreaming,
		);
		this.logger.event("session_ack_posted", {
			kind: "prompted",
			sessionId: agentSessionId,
			streaming: isCurrentlyStreaming,
			elapsedMs: Date.now() - receivedAt,
		});

		// Resolve ALL cached repositories for this issue (not just the first).
		// Multi-repo sessions need the full set for workspace recreation.
		let repositories = this.getCachedRepositories(issueId);
		if (!repositories || repositories.length === 0) {
			// Fallback: attempt to recover repository for legacy/restarted sessions
			this.logger.info(
				`No cached repository for prompted webhook ${agentSessionId}, attempting fallback resolution`,
			);

			// First, check if the session manager already has this session
			const session = this.agentSessionManager.getSession(agentSessionId);
			if (session) {
				const repoId = this.sessionRepositories.get(agentSessionId);
				if (repoId) {
					const repo = this.repositories.get(repoId) ?? null;
					if (repo) {
						repositories = [repo];
						this.repositoryRouter
							.getIssueRepositoryCache()
							.set(issueId, [repoId]);
						this.logger.info(
							`Recovered repository ${repoId} for issue ${issueId} from session manager`,
						);
					}
				}
			}

			// Second fallback: re-route via repository router
			if (!repositories || repositories.length === 0) {
				try {
					const repos = Array.from(this.repositories.values());
					const routingResult =
						await this.repositoryRouter.determineRepositoryForWebhook(
							webhook,
							repos,
						);

					if (routingResult.type === "selected") {
						repositories = routingResult.repositories;
						this.repositoryRouter.getIssueRepositoryCache().set(
							issueId,
							routingResult.repositories.map((r) => r.id),
						);
						this.logger.info(
							`Recovered repositories [${repositories.map((r) => r.name).join(", ")}] for issue ${issueId} via fallback routing (${routingResult.routingMethod})`,
						);
					}
				} catch (error) {
					this.logger.warn(
						`Fallback repository routing failed for prompted webhook ${agentSessionId}`,
						error,
					);
				}
			}

			if (!repositories || repositories.length === 0) {
				// All recovery attempts failed - post visible feedback
				await this.agentSessionManager.createResponseActivity(
					agentSessionId,
					"I couldn't process your message because the session configuration was lost. Please create a new session by mentioning me (@cyrus) in a new comment with your prompt.",
				);
				this.logger.warn(
					`Failed to recover repository for prompted webhook ${agentSessionId} - all fallback methods exhausted`,
				);
				return;
			}
		}

		// User access control check for mid-session prompts (use primary repo)
		const primaryRepo = repositories[0]!;
		const accessResult = this.checkUserAccess(webhook, primaryRepo);
		if (!accessResult.allowed) {
			this.logger.info(
				`User ${accessResult.userName} blocked from prompting: ${accessResult.reason}`,
			);
			await this.handleBlockedUser(webhook, primaryRepo, accessResult.reason);
			return;
		}

		await this.handleNormalPromptedActivity(webhook, repositories);
	}

	/**
	 * Handle issue unassignment
	 * @param issue Linear issue object from webhook data
	 * @param linearWorkspaceId Linear workspace ID (from webhook.organizationId)
	 */
	private async handleIssueUnassigned(
		issue: WebhookIssue,
		// Retained for the call signature; the farewell moved from a comment
		// (which needed the workspace) to a per-session response (PON-196).
		_linearWorkspaceId: string,
	): Promise<void> {
		const sessions = this.agentSessionManager.getSessionsByIssueId(issue.id);
		const activeThreadCount = sessions.length;

		// Stop all agent runners for this issue
		for (const session of sessions) {
			this.logger.info(`Stopping agent runner for issue ${issue.identifier}`);
			this.agentSessionManager.requestSessionStop(session.id);
			session.agentRunner?.stop();
		}

		// Post ONE farewell comment on the issue (not in any thread) if there were active sessions
		if (activeThreadCount > 0) {
			// PON-196: zero comments on a client thread. This used to be one
			// comment on the issue; it is now a response on each session that
			// was actually stopped, which is where the client is looking and
			// leaves no comment trail behind.
			//
			// PON-200: only sessions that were actually RUNNING. Posting to
			// every tracked session put a second farewell on an already-closed
			// one each time the assignee was flipped — ACM-10 collected two
			// apiece.
			for (const session of sessions.filter(
				(s) => s.status !== AgentSessionStatus.Complete,
			)) {
				await this.agentSessionManager.createResponseActivity(
					session.id,
					"I've been unassigned and am stopping work now.",
				);
			}
		}

		// Cockpit (PON-151): an unassigned issue is no longer delegated work —
		// unless completed work is still awaiting verification (PON-152):
		// closing then would strand the held summary with no notification
		// surface and no interceptable approve action.
		if (this.verificationGate.isPending(issue.id)) {
			void this.cockpitMirror.commentOnMirror(
				issue.id,
				"The client unassigned the agent while this work awaits verification. The held summary is still deliverable — approve or reject here.",
			);
		} else {
			void this.cockpitMirror.close(issue.id, "unassigned");
		}
		for (const session of sessions) {
			this.mentionSessionIds.delete(session.id);
		}

		// Lane cleanup (PON-112): release the lane if a stopped session held
		// it, and drop queued sessions of this issue from their lane queue.
		for (const session of sessions) {
			await this.cleanupLaneForSession(session.id);
		}
		for (const queuedSessionId of this.laneManager.queuedSessionIdsForIssue(
			issue.id,
		)) {
			await this.cleanupLaneForSession(queuedSessionId);
		}

		// Emit events
		this.logger.info(
			`Stopped ${activeThreadCount} sessions for unassigned issue ${issue.identifier}`,
		);
	}

	/**
	 * Handle Claude messages
	 */
	private async handleClaudeMessage(
		sessionId: string,
		message: SDKMessage,
		_repositoryId: string,
	): Promise<void> {
		await this.agentSessionManager.handleClaudeMessage(sessionId, message);
	}

	/**
	 * Handle Claude session error
	 * Silently ignores AbortError (user-initiated stop), logs other errors
	 */
	private async handleClaudeError(error: Error): Promise<void> {
		// AbortError is expected when user stops Claude process, don't log it
		// Check by name since the SDK's AbortError class may not match our imported definition
		const isAbortError =
			error.name === "AbortError" || error.message.includes("aborted by user");

		// Also check for SIGTERM (exit code 143), which indicates graceful termination
		const isSigterm = error.message.includes(
			"Claude Code process exited with code 143",
		);

		if (isAbortError || isSigterm) {
			return;
		}
		this.logger.error("Unhandled claude error:", error);
	}

	/**
	 * Fetch issue labels for a given issue
	 */
	private async fetchIssueLabels(issue: Issue): Promise<string[]> {
		return this.promptBuilder.fetchIssueLabels(issue);
	}

	/**
	 * Build the session context used to evaluate per-skill scope restrictions.
	 *
	 * Skill scopes (persisted in `scope.json` sidecars by the config-updater)
	 * match against:
	 * - the active repository's Cyrus config ID,
	 * - the Linear team that owns the issue, and
	 * - the Linear label IDs attached to the issue.
	 *
	 * The session's repo working-tree path(s) are also captured so that
	 * repo-local skills (`<repoPath>/.claude/skills/*`) get unioned into the
	 * resolved whitelist. When a `session` is provided its workspace is used to
	 * resolve those paths (covering multi-repo sessions); otherwise the active
	 * repository's path is used.
	 */
	private buildSkillSessionContext(
		repository: RepositoryConfig,
		fullIssue?: Issue,
		session?: CyrusAgentSession,
	): SkillSessionContext {
		const context: SkillSessionContext = {
			repositoryId: repository.id,
			repoPaths: this.resolveSkillRepoPaths(repository, session),
		};
		if (fullIssue?.teamId) {
			context.linearTeamId = fullIssue.teamId;
		}
		if (
			Array.isArray(fullIssue?.labelIds) &&
			(fullIssue?.labelIds?.length ?? 0) > 0
		) {
			context.linearLabelIds = [...(fullIssue?.labelIds ?? [])];
		}
		return context;
	}

	/**
	 * Resolve the repo working-tree path(s) whose `.claude/skills/` directories
	 * should contribute to the skill whitelist for a session.
	 *
	 * - Multi-repo sessions: every sub-worktree in `workspace.repoPaths`.
	 * - Single-repo / GitHub-mention sessions: the active repository's path.
	 */
	private resolveSkillRepoPaths(
		repository: RepositoryConfig,
		session?: CyrusAgentSession,
	): string[] {
		const repoPaths = session?.workspace?.repoPaths;
		if (repoPaths) {
			const paths = Object.values(repoPaths).filter(
				(p): p is string => typeof p === "string" && p.length > 0,
			);
			if (paths.length > 0) {
				return [...new Set(paths)];
			}
		}
		return [repository.repositoryPath];
	}

	/**
	 * Resolve default model for a given runner from config with sensible built-in defaults.
	 * Supports legacy config keys for backwards compatibility.
	 */
	private getDefaultModelForRunner(runnerType: RunnerType): string {
		return this.runnerSelectionService.getDefaultModelForRunner(runnerType);
	}

	/**
	 * Resolve default fallback model for a given runner from config with sensible built-in defaults.
	 * Supports legacy Claude fallback key for backwards compatibility.
	 */
	private getDefaultFallbackModelForRunner(runnerType: RunnerType): string {
		return this.runnerSelectionService.getDefaultFallbackModelForRunner(
			runnerType,
		);
	}

	/**
	 * Instantiate the appropriate runner for the given type.
	 */
	private createRunnerForType(
		runnerType: "claude" | "gemini" | "codex" | "cursor",
		config: AgentRunnerConfig,
	): IAgentRunner {
		switch (runnerType) {
			case "claude": {
				// Inject the hosted SessionStore at the last moment so it only
				// attaches to Claude runners (the field is Claude-specific).
				const claudeConfig = this.claudeSessionStore
					? { ...config, sessionStore: this.claudeSessionStore }
					: config;
				return new ClaudeRunner(claudeConfig, this.isWarmSessionsEnabled());
			}
			case "gemini":
				return new GeminiRunner(config);
			case "codex":
				return new CodexRunner(config);
			case "cursor":
				return new CursorRunner(config);
			default:
				throw new Error(`Unknown runner type: ${runnerType satisfies never}`);
		}
	}

	/**
	 * Determine system prompt based on issue labels and repository configuration
	 */
	private async determineSystemPromptFromLabels(
		labels: string[],
		repository: RepositoryConfig,
	): Promise<
		| {
				prompt: string;
				version?: string;
				type?:
					| "debugger"
					| "builder"
					| "scoper"
					| "orchestrator"
					| "graphite-orchestrator";
		  }
		| undefined
	> {
		return this.promptBuilder.determineSystemPromptFromLabels(labels, [
			repository,
		]);
	}

	/**
	 * Build prompt for mention-triggered sessions
	 * @param issue Full Linear issue object
	 * @param repository Repository configuration
	 * @param agentSession The agent session containing the mention
	 * @param attachmentManifest Optional attachment manifest to append
	 * @param guidance Optional agent guidance rules from Linear
	 * @returns The constructed prompt and optional version tag
	 */
	private async buildMentionPrompt(
		issue: Issue,
		agentSession: WebhookAgentSession,
		attachmentManifest: string = "",
		guidance?: GuidanceRule[],
	): Promise<{ prompt: string; version?: string }> {
		return this.promptBuilder.buildMentionPrompt(
			issue,
			agentSession,
			attachmentManifest,
			guidance,
		);
	}

	/**
	 * Convert full Linear SDK issue to CoreIssue interface for Session creation
	 */
	private convertLinearIssueToCore(issue: Issue): IssueMinimal {
		return this.promptBuilder.convertLinearIssueToCore(issue);
	}

	/**
	 * Get connection status by repository ID
	 */
	getConnectionStatus(): Map<string, boolean> {
		const status = new Map<string, boolean>();
		// Single event transport is "connected" if it exists
		if (this.linearEventTransport) {
			// Mark all repositories as connected since they share the single transport
			for (const repoId of this.repositories.keys()) {
				status.set(repoId, true);
			}
		}
		return status;
	}

	/**
	 * Get event transport (for testing purposes)
	 * @internal
	 */
	_getClientByToken(_token: string): any {
		// Return the single shared event transport
		return this.linearEventTransport;
	}

	/**
	 * Start OAuth flow using the shared application server
	 */
	async startOAuthFlow(proxyUrl?: string): Promise<{
		linearToken: string;
		linearWorkspaceId: string;
		linearWorkspaceName: string;
	}> {
		const oauthProxyUrl = proxyUrl || this.config.proxyUrl || DEFAULT_PROXY_URL;
		return this.sharedApplicationServer.startOAuthFlow(oauthProxyUrl);
	}

	/**
	 * Get the server port
	 */
	getServerPort(): number {
		return this.config.serverPort || this.config.webhookPort || 3456;
	}

	/**
	 * Get the OAuth callback URL
	 */
	getOAuthCallbackUrl(): string {
		return this.sharedApplicationServer.getOAuthCallbackUrl();
	}

	/**
	 * Move issue to started state when assigned
	 * @param issue Full Linear issue object from Linear SDK
	 * @param linearWorkspaceId Workspace ID for issue tracker lookup
	 */

	/**
	 * The client merged, so their issue is finished (PON-233).
	 *
	 * Deliberately the LAST step of the close-out: this write fires the
	 * terminal-state path, which removes the verification record, closes the
	 * mirror and deletes the worktree. Everything that needs those must have
	 * happened already.
	 */
	private moveIssueToCompletedState(
		issueId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		return this.moveIssueToTerminalState(
			issueId,
			linearWorkspaceId,
			"completed",
		);
	}

	/**
	 * Move the client's issue to a terminal state of the given type — Done
	 * after their merge, Canceled after a reviewer's `cancel:` (v3.1). The
	 * webhook this causes runs the terminal path, which stops every session
	 * on the issue, closes the mirror against the issue's own state, removes
	 * the records and the worktree, and advances that company's queue.
	 */
	private async moveIssueToTerminalState(
		issueId: string,
		linearWorkspaceId: string,
		target: "completed" | "canceled",
	): Promise<void> {
		try {
			const tracker = this.issueTrackers.get(linearWorkspaceId);
			if (!tracker) return;
			const issue = await tracker.fetchIssue(issueId);
			if (!issue) return;
			const current = await issue.state;
			if (current?.type === "completed" || current?.type === "canceled") return;
			const team = await issue.team;
			if (!team) return;
			const states = await tracker.fetchWorkflowStates(team.id);
			const done = states.nodes
				.filter((state) => state.type === target)
				.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
			if (!done) {
				this.logger.warn(
					`No ${target} state on team ${team.id} — leaving ${issue.identifier} open`,
				);
				return;
			}
			this.selfCompletedIssues.add(issueId);
			await tracker.updateIssue(issueId, { stateId: done.id });
			this.logger.event(
				target === "completed"
					? "client_issue_completed"
					: "client_issue_canceled",
				{
					issueId,
					issueIdentifier: issue.identifier,
					state: done.name,
				},
			);
		} catch (error) {
			this.logger.error(
				"Could not complete the client's issue after merge:",
				error,
			);
		}
	}

	private async moveIssueToStartedState(
		issue: Issue,
		linearWorkspaceId: string,
	): Promise<void> {
		try {
			const issueTracker = this.issueTrackers.get(linearWorkspaceId);
			if (!issueTracker) {
				this.logger.warn(
					`No issue tracker found for workspace ${linearWorkspaceId}, skipping state update`,
				);
				return;
			}

			// Check if issue is already in a started state
			const currentState = await issue.state;
			if (currentState?.type === "started") {
				this.logger.debug(
					`Issue ${issue.identifier} is already in started state (${currentState.name})`,
				);
				return;
			}

			// Get team for the issue
			const team = await issue.team;
			if (!team) {
				this.logger.warn(
					`No team found for issue ${issue.identifier}, skipping state update`,
				);
				return;
			}

			// Get available workflow states for the issue's team
			const teamStates = await issueTracker.fetchWorkflowStates(team.id);

			const states = teamStates;

			// Find all states with type "started" and pick the one with lowest position
			// This ensures we pick "In Progress" over "In Review" when both have type "started"
			// Linear uses standardized state types: triage, backlog, unstarted, started, completed, canceled
			const startedStates = states.nodes.filter(
				(state) => state.type === "started",
			);
			const startedState = startedStates.sort(
				(a, b) => a.position - b.position,
			)[0];

			if (!startedState) {
				throw new Error(
					'Could not find a state with type "started" for this team',
				);
			}

			// Update the issue state
			this.logger.debug(
				`Moving issue ${issue.identifier} to started state: ${startedState.name}`,
			);
			if (!issue.id) {
				this.logger.warn(
					`Issue ${issue.identifier} has no ID, skipping state update`,
				);
				return;
			}

			await issueTracker.updateIssue(issue.id, {
				stateId: startedState.id,
			});

			this.logger.debug(
				`✅ Successfully moved issue ${issue.identifier} to ${startedState.name} state`,
			);
		} catch (error) {
			this.logger.error(
				`Failed to move issue ${issue.identifier} to started state:`,
				error,
			);
			// Don't throw - we don't want to fail the entire assignment process due to state update failure
		}
	}

	/**
	 * Post initial comment when assigned to issue
	 */
	// private async postInitialComment(issueId: string, repositoryId: string): Promise<void> {
	//   const body = "I'm getting started right away."
	//   // Get the issue tracker for this repository
	//   const issueTracker = this.issueTrackers.get(repositoryId)
	//   if (!issueTracker) {
	//     throw new Error(`No issue tracker found for repository ${repositoryId}`)
	//   }
	//   const commentData = {

	//     body
	//   }
	//   await issueTracker.createComment(commentData)
	// }

	/**
	 * Format todos as Linear checklist markdown
	 */
	// private formatTodosAsChecklist(todos: Array<{id: string, content: string, status: string, priority: string}>): string {
	//   return todos.map(todo => {
	//     const checkbox = todo.status === 'completed' ? '[x]' : '[ ]'
	//     const statusEmoji = todo.status === 'in_progress' ? ' 🔄' : ''
	//     return `- ${checkbox} ${todo.content}${statusEmoji}`
	//   }).join('\n')
	// }

	/**
	 * Download attachments from Linear issue
	 * @param issue Linear issue object from webhook data
	 * @param repository Repository configuration
	 * @param workspacePath Path to workspace directory
	 */
	private async downloadIssueAttachments(
		issue: Issue,
		linearWorkspaceId: string,
		workspacePath: string,
	): Promise<{ manifest: string; attachmentsDir: string | null }> {
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		return this.attachmentService.downloadIssueAttachments(
			issue,
			linearWorkspaceId,
			workspacePath,
			issueTracker,
		);
	}

	/**
	 * Download attachments from a specific comment
	 * @param commentBody The body text of the comment
	 * @param attachmentsDir Directory where attachments should be saved
	 * @param linearToken Linear API token
	 * @param existingAttachmentCount Current number of attachments already downloaded
	 */
	private async downloadCommentAttachments(
		commentBody: string,
		attachmentsDir: string,
		linearToken: string | null,
		existingAttachmentCount: number,
	): Promise<{
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}> {
		return this.attachmentService.downloadCommentAttachments(
			commentBody,
			attachmentsDir,
			linearToken,
			existingAttachmentCount,
		);
	}

	/**
	 * Generate attachment manifest for new comment attachments
	 */
	private generateNewAttachmentManifest(result: {
		newAttachmentMap: Record<string, string>;
		newImageMap: Record<string, string>;
		totalNewAttachments: number;
		failedCount: number;
	}): string {
		return this.attachmentService.generateNewAttachmentManifest(result);
	}

	private async registerCyrusToolsMcpEndpoint(): Promise<void> {
		if (this.cyrusToolsMcpRegistered) {
			return;
		}

		const fastify = this.sharedApplicationServer.getFastifyInstance() as any;
		if (
			typeof fastify.register !== "function" ||
			typeof fastify.addHook !== "function"
		) {
			console.warn(
				"[EdgeWorker] Skipping cyrus-tools MCP endpoint registration: Fastify instance does not support register/addHook",
			);
			return;
		}

		fastify.addHook("onRequest", (request: any, _reply: any, done: any) => {
			const rawUrl =
				typeof request?.raw?.url === "string"
					? request.raw.url
					: typeof request?.url === "string"
						? request.url
						: "";
			const requestPath = rawUrl.split("?")[0];

			if (requestPath !== this.cyrusToolsMcpEndpoint) {
				done();
				return;
			}

			if (
				!this.mcpConfigService.isAuthorizationValid(
					request.headers?.authorization,
				)
			) {
				_reply.code(401).send({
					error: "Unauthorized cyrus-tools MCP request",
				});
				done();
				return;
			}

			const rawContextHeader = request.headers?.["x-cyrus-mcp-context-id"];
			const contextId = Array.isArray(rawContextHeader)
				? rawContextHeader[0]
				: rawContextHeader;

			this.cyrusToolsMcpRequestContext.run({ contextId }, () => {
				done();
			});
		});

		this.cyrusToolsMcpSessions.on("connected", (sessionId) => {
			console.log(
				`[EdgeWorker] cyrus-tools MCP session connected: ${sessionId}`,
			);
		});

		this.cyrusToolsMcpSessions.on("terminated", (sessionId) => {
			console.log(
				`[EdgeWorker] cyrus-tools MCP session terminated: ${sessionId}`,
			);
		});

		this.cyrusToolsMcpSessions.on("error", (error) => {
			console.error("[EdgeWorker] cyrus-tools MCP session error:", error);
		});

		await fastify.register(streamableHttp, {
			stateful: true,
			mcpEndpoint: this.cyrusToolsMcpEndpoint,
			sessions: this.cyrusToolsMcpSessions,
			createServer: async () => {
				const contextId =
					this.cyrusToolsMcpRequestContext.getStore()?.contextId;
				if (!contextId) {
					throw new Error(
						"Missing x-cyrus-mcp-context-id header for cyrus-tools MCP request",
					);
				}

				const context = this.mcpConfigService.getContext(contextId);
				if (!context) {
					throw new Error(
						`Unknown cyrus-tools MCP context '${contextId}'. Build MCP config before connecting.`,
					);
				}

				const sdkServer =
					context.prebuiltServer ||
					createCyrusToolsServer(
						context.linearClient,
						this.createCyrusToolsOptions(context.parentSessionId),
					);
				this.mcpConfigService.clearPrebuiltServer(contextId);

				return sdkServer.server;
			},
		});

		this.cyrusToolsMcpRegistered = true;
		console.log(
			`✅ Cyrus tools MCP endpoint registered at ${this.cyrusToolsMcpEndpoint}`,
		);
	}

	private failureModesClient: FailureModesHttpClient | null = null;

	/**
	 * Lazily build the HTTP client used by `log_failure_mode` to POST to
	 * cyrus-hosted. Uses `CYRUS_APP_URL` (the same env var the remote
	 * session-store client reads, see top of this file) so preview
	 * environments and prod share a single way to point at a control
	 * plane. Returns null when either the URL or the `CYRUS_API_KEY` are
	 * missing — in that mode the tool is simply not registered, so
	 * customer-mode CLI users without a control plane don't see a broken
	 * tool.
	 */
	private getFailureModesClient(): FailureModesHttpClient | null {
		if (this.failureModesClient) return this.failureModesClient;
		const apiKey = process.env.CYRUS_API_KEY?.trim();
		if (!apiKey) return null;
		const baseUrl = getCyrusAppUrl();
		this.failureModesClient = createFetchFailureModesClient({
			baseUrl,
			apiKey,
		});
		return this.failureModesClient;
	}

	/**
	 * Resolve a working-directory string to the agent session id that owns
	 * that workspace. The `log_failure_mode` MCP tool calls this with the
	 * agent's reported `cwd`. We normalize and compare against each known
	 * session's `workspace.path` (and any sub-repo paths the session opens).
	 */
	/**
	 * Resolve a working-directory string to the rich session bundle a
	 * Cyrus team member needs to triage a failure-mode report: the
	 * internal session id (for dedup), the runner session id + runner
	 * type (so triage can pull the Claude/Gemini/Codex/Cursor transcript),
	 * the Linear AgentSession + source-issue identifiers (so triage can
	 * jump to the customer thread), and the workspace path (for repro).
	 *
	 * Returns null only when no session matches. We prefer an exact
	 * workspace-path or sub-repo-path match; if neither hits, we fall
	 * back to a prefix match for nested cwds (e.g. shells in a subdir).
	 */
	/**
	 * Aggregator over every place active sessions live in this process.
	 * Today: the primary AgentSessionManager (issue sessions) and the
	 * ChatSessionHandler's private one (Slack / GitHub-PR-chat / future
	 * chat platforms). New session origins should be added here so
	 * downstream consumers (currently just resolveSessionFromCwd) keep
	 * working without modification — single open extension point (OCP),
	 * single responsibility (SRP: this method's only job is "where do
	 * sessions live?", separate from "how do we match one by cwd?").
	 */
	private getAllKnownSessions(): CyrusAgentSession[] {
		return [
			...this.agentSessionManager.getAllSessions(),
			...(this.chatSessionHandler?.getAllChatSessions() ?? []),
		];
	}

	/**
	 * Find the live session whose workspace contains `cwd` — exact worktree
	 * or repo path first, then path-prefix. Shared by the cwd-keyed MCP
	 * tools (`log_failure_mode`, `record_operator_note`).
	 */
	private sessionForCwd(cwd: string): CyrusAgentSession | null {
		if (!cwd) return null;
		const normalize = (p: string) => p.replace(/\/+$/, "");
		const target = normalize(cwd);

		const sessions = this.getAllKnownSessions();

		const exact = sessions.find((session) => {
			if (normalize(session.workspace?.path ?? "") === target) return true;
			const repoPaths = session.workspace?.repoPaths;
			if (repoPaths) {
				for (const p of Object.values(repoPaths)) {
					if (typeof p === "string" && normalize(p) === target) return true;
				}
			}
			return false;
		});

		const prefix = exact
			? undefined
			: sessions.find((session) => {
					const root = normalize(session.workspace?.path ?? "");
					return root && target.startsWith(`${root}/`);
				});

		return exact ?? prefix ?? null;
	}

	private resolveSessionFromCwd(cwd: string): ResolvedSession | null {
		const session = this.sessionForCwd(cwd);
		if (!session) return null;

		const runnerType = session.claudeSessionId
			? "claude"
			: session.geminiSessionId
				? "gemini"
				: session.codexSessionId
					? "codex"
					: session.cursorSessionId
						? "cursor"
						: null;
		const runnerSessionId =
			session.claudeSessionId ??
			session.geminiSessionId ??
			session.codexSessionId ??
			session.cursorSessionId ??
			null;

		const sessionSource = session.id.startsWith("github-")
			? "github"
			: session.id.startsWith("gitlab-")
				? "gitlab"
				: session.id.startsWith("slack-")
					? "slack"
					: (session.issueContext?.trackerId ?? "linear");

		// For Linear-source sessions, `session.id` is already the Linear
		// AgentSession id (they're literally the same UUID — the v3 rename
		// from `linearAgentActivitySessionId` to `id` kept the value). So we
		// don't surface a separate `linearAgentSessionId` — the server keys
		// dedup on `session_id` and that *is* the Linear AgentSession id when
		// `session_source === 'linear'`.
		return {
			sessionId: session.id,
			runnerSessionId,
			runnerType,
			sourceIssueIdentifier:
				session.issueContext?.issueIdentifier ??
				session.issue?.identifier ??
				null,
			workspacePath: session.workspace?.path ?? null,
			sessionSource,
		};
	}

	private createCyrusToolsOptions(parentSessionId?: string): CyrusToolsOptions {
		const failureModesClient = this.getFailureModesClient();
		const options: CyrusToolsOptions = {
			parentSessionId,
			onSessionCreated: (childSessionId: string, parentId: string) => {
				this.handleChildSessionMapping(childSessionId, parentId);
			},
			onFeedbackDelivery: async (childSessionId: string, message: string) => {
				return this.handleFeedbackDeliveryToChildSession(
					childSessionId,
					message,
				);
			},
		};
		if (failureModesClient) {
			options.failureModes = {
				resolveSessionFromCwd: (cwd: string) => this.resolveSessionFromCwd(cwd),
				httpClient: failureModesClient,
			};
		}
		// Operator-note channel (PON-169): the internal reading the gate
		// keeps off the client's thread lands on the scope record and the
		// cockpit mirror instead.
		options.operatorNotes = {
			deliver: (
				cwd: string,
				note: string,
				clientScope?: string,
				clientSummary?: string,
			) => this.deliverOperatorNote(cwd, note, clientScope, clientSummary),
		};
		return options;
	}

	/**
	 * Store a session's internal reading operator-side (PON-169): on the
	 * issue's scope-approval record (persisted) and in the cockpit mirror
	 * description (visible). Nothing here touches a tenant surface.
	 */
	private async deliverOperatorNote(
		cwd: string,
		note: string,
		clientScope?: string,
		clientSummary?: string,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			const session = this.sessionForCwd(cwd);
			if (!session) {
				return {
					ok: false,
					error: `no session matches cwd=${cwd} — pass the session's actual working directory`,
				};
			}
			const issueId = session.issueContext?.issueId ?? session.issueId;
			if (!issueId) {
				return { ok: false, error: "the session has no issue to record on" };
			}
			const issueIdentifier = session.issueContext?.issueIdentifier;
			this.scopeApprovals.recordOperatorNote(
				issueId,
				note,
				clientScope,
				clientSummary,
			);
			await this.persistScopeApprovals("operator_note_recorded");
			// The note itself never goes to the journal — length only. It is
			// internal detail, and logs travel further than the cockpit.
			this.logger.event("operator_note_recorded", {
				issueId,
				issueIdentifier,
				sessionId: session.id,
				noteLength: note.length,
				hasClientScope: clientScope !== undefined,
				hasClientSummary: clientSummary !== undefined,
			});
			const workspaceId =
				this.resolveWorkspaceIdForSession(session.id) ??
				this.laneManager.workspaceOf(session.id);
			if (workspaceId) {
				// Best-effort like every other mirror write: a broken cockpit
				// must not fail the recording — the persisted record is the
				// authoritative copy.
				void this.cockpitMirror.setOperatorNote(
					{ issueId, issueIdentifier },
					workspaceId,
					note,
					clientScope,
				);
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private handleChildSessionMapping(
		childSessionId: string,
		parentSessionId: string,
	): void {
		console.log(
			`[EdgeWorker] Agent session created: ${childSessionId}, mapping to parent ${parentSessionId}`,
		);
		this.globalSessionRegistry.setParentSession(
			childSessionId,
			parentSessionId,
		);
		console.log(
			`[EdgeWorker] Parent-child mapping registered in GlobalSessionRegistry`,
		);
	}

	private async handleFeedbackDeliveryToChildSession(
		childSessionId: string,
		message: string,
	): Promise<boolean> {
		console.log(
			`[EdgeWorker] Processing feedback delivery to child session ${childSessionId}`,
		);

		// Find the parent session ID for context
		const parentSessionId =
			this.globalSessionRegistry.getParentSessionId(childSessionId);

		// Find the repository containing the child session
		const childRepoId = this.sessionRepositories.get(childSessionId);
		const childRepo = childRepoId
			? this.repositories.get(childRepoId)
			: undefined;

		if (
			!childRepo ||
			!this.agentSessionManager.hasAgentRunner(childSessionId)
		) {
			console.error(
				`[EdgeWorker] Child session ${childSessionId} not found in any repository`,
			);
			return false;
		}

		// Get the child session
		const childSession = this.agentSessionManager.getSession(childSessionId);
		if (!childSession) {
			console.error(`[EdgeWorker] Child session ${childSessionId} not found`);
			return false;
		}

		console.log(
			`[EdgeWorker] Found child session - Issue: ${childSession.issueId}`,
		);

		// Get parent session info for better context in the thought
		let parentIssueId: string | undefined;
		if (parentSessionId) {
			const parentSession =
				this.agentSessionManager.getSession(parentSessionId);
			if (parentSession) {
				parentIssueId =
					parentSession.issue?.identifier || parentSession.issueId;
			}
		}

		// Extract workspace ID once for all operations
		const childWorkspaceId = requireLinearWorkspaceId(childRepo);

		// Post thought to Linear showing feedback receipt
		const issueTracker = this.issueTrackers.get(childWorkspaceId);
		if (issueTracker) {
			const feedbackThought = parentIssueId
				? `Received feedback from orchestrator (${parentIssueId}):\n\n---\n\n${message}\n\n---`
				: `Received feedback from orchestrator:\n\n---\n\n${message}\n\n---`;

			try {
				// PON-194: the mirror image of the child->parent receipt, which
				// got the floor and this did not. The body is free text the
				// PARENT agent wrote — internal direction, on the child issue's
				// client thread.
				const activityId = await this.postActivityDirect(
					issueTracker,
					{
						agentSessionId: childSessionId,
						content: {
							type: "thought",
							body: feedbackThought,
						},
					},
					"orchestrator feedback receipt",
					"narration",
					childWorkspaceId,
				);
				const result = { success: true, activityId };

				if (result.success) {
					console.log(
						`[EdgeWorker] Posted feedback receipt thought for child session ${childSessionId}`,
					);
				} else {
					console.error(
						`[EdgeWorker] Failed to post feedback receipt thought:`,
						result,
					);
				}
			} catch (error) {
				console.error(
					`[EdgeWorker] Error posting feedback receipt thought:`,
					error,
				);
			}
		}

		const feedbackPrompt = `## Received feedback from orchestrator\n\n---\n\n${message}\n\n---`;

		console.log(
			`[EdgeWorker] Handling feedback delivery to child session ${childSessionId}`,
		);

		this.handlePromptWithStreamingCheck(
			childSession,
			childRepo,
			childSessionId,
			this.agentSessionManager,
			feedbackPrompt,
			"",
			false,
			[],
			"give feedback to child",
			childWorkspaceId,
		)
			.then(() => {
				console.log(
					`[EdgeWorker] Child session ${childSessionId} completed processing feedback`,
				);
			})
			.catch((error) => {
				console.error(
					`[EdgeWorker] Failed to process feedback in child session:`,
					error,
				);
			});

		console.log(
			`[EdgeWorker] Feedback delivered successfully to child session ${childSessionId}`,
		);
		return true;
	}

	private getCyrusToolsMcpUrl(): string {
		const server = this.sharedApplicationServer as {
			getPort?: () => number;
		};
		const port =
			typeof server.getPort === "function"
				? server.getPort()
				: this.config.serverPort || this.config.webhookPort || 3456;
		return `http://127.0.0.1:${port}${this.cyrusToolsMcpEndpoint}`;
	}

	/**
	 * Build the complete prompt for a session - shows full prompt assembly in one place
	 *
	 * New session prompt structure:
	 * 1. Issue context (from buildIssueContextPrompt)
	 * 2. User comment
	 *
	 * Existing session prompt structure:
	 * 1. User comment
	 * 2. Attachment manifest (if present)
	 */
	private async buildSessionPrompt(
		isNewSession: boolean,
		session: CyrusAgentSession,
		fullIssue: Issue,
		repository: RepositoryConfig,
		promptBody: string,
		attachmentManifest?: string,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<string> {
		// Fetch labels for system prompt determination
		const labels = await this.fetchIssueLabels(fullIssue);

		// Create input for unified prompt assembly
		const input: PromptAssemblyInput = {
			session,
			fullIssue,
			repositories: [repository],
			repository,
			userComment: promptBody,
			commentAuthor,
			commentTimestamp,
			attachmentManifest,
			isNewSession,
			isStreaming: false, // This path is only for non-streaming prompts
			labels,
		};

		// Use unified prompt assembly
		const assembly = await this.assemblePrompt(input);

		// Log metadata for debugging
		this.logger.debug(
			`Built prompt - components: ${assembly.metadata.components.join(", ")}, type: ${assembly.metadata.promptType}`,
		);

		return assembly.userPrompt;
	}

	/**
	 * Assemble a complete prompt - unified entry point for all prompt building
	 * This method contains all prompt assembly logic in one place
	 */
	private async assemblePrompt(
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		// If actively streaming, just pass through the comment
		if (input.isStreaming) {
			return this.buildStreamingPrompt(input);
		}

		// If new session, build full prompt with all components
		if (input.isNewSession) {
			return this.buildNewSessionPrompt(input);
		}

		// Existing session continuation - just user comment + attachments
		return this.buildContinuationPrompt(input);
	}

	/**
	 * Build prompt for actively streaming session - pass through user comment as-is
	 */
	private buildStreamingPrompt(input: PromptAssemblyInput): PromptAssembly {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		const parts: string[] = [input.userComment];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: true,
			},
		};
	}

	/**
	 * Build prompt for new session - includes issue context and user comment
	 */
	private async buildNewSessionPrompt(
		input: PromptAssemblyInput,
	): Promise<PromptAssembly> {
		const components: PromptComponent[] = [];
		const parts: string[] = [];

		// 1. Determine system prompt from labels
		// Only for delegation (not mentions) or when /label-based-prompt is requested
		const repositories = input.repositories ?? [input.repository];
		let labelBasedSystemPrompt: string | undefined;
		if (!input.isMentionTriggered || input.isLabelBasedPromptRequested) {
			const result = await this.promptBuilder.determineSystemPromptFromLabels(
				input.labels || [],
				repositories,
			);
			labelBasedSystemPrompt = result?.prompt;
		}

		// 2. Determine system prompt based on prompt type
		// Label-based: Use only the label-based system prompt
		// Fallback: Use scenarios system prompt (shared instructions)
		let systemPrompt: string;
		if (labelBasedSystemPrompt) {
			// Use label-based system prompt as-is (no shared instructions)
			systemPrompt = labelBasedSystemPrompt;
		} else {
			// Use scenarios system prompt for fallback cases
			const sharedInstructions = await this.loadSharedInstructions();
			systemPrompt = sharedInstructions;
		}

		// 3. Append skills guidance — instruct the agent to use skills based on context.
		// Skills hidden by per-skill scope (repo / Linear team / Linear label) are
		// omitted from the guidance so the model doesn't reference skills it
		// cannot invoke.
		const skillsContext = this.buildSkillSessionContext(
			repositories[0]!,
			input.fullIssue,
			input.session,
		);
		systemPrompt += await this.skillsPluginResolver.buildSkillsGuidance(
			undefined,
			skillsContext,
		);

		// 4. Append agent context — dynamic values for skills to reference
		systemPrompt += this.buildAgentContextBlock();

		// 4a. Client-surface rules (PON-168 / R2): every session whose output
		// can reach a tenant surface carries the policy intrinsically.
		systemPrompt += buildClientSurfaceRuleBlock();
		// 4b. Needs-info rules (PON-172): mid-work asks for client-side
		// inputs, deliverable-framed, one ask with everything needed.
		systemPrompt += buildNeedsInfoRuleBlock();

		// 4b. Scope-confirm gate (PON-150) — intrinsic, not enforced: an
		// always-on prompt step for delegated sessions whose issue has no
		// approved scope yet. An approved issue never re-asks; child sessions
		// work inside a scope their parent already carries. Mentions stay
		// conversational EXCEPT when a delegated flow on the issue is already
		// mid-gate (an open record exists): a mention thread must not become
		// the ungated side door that implements while the delegated session
		// waits for approval, so it gets the block too — its side-conversation
		// paragraph keeps it conversational while forbidding implementation.
		const mentionMidGate =
			input.isMentionTriggered === true &&
			this.scopeApprovals.get(input.fullIssue.id) !== undefined;
		if (!input.isMentionTriggered || mentionMidGate) {
			systemPrompt =
				this.appendScopeGateIfPending(
					systemPrompt,
					input.linearWorkspaceId,
					input.fullIssue.id,
					input.agentSession?.id,
				) ?? systemPrompt;
		}

		// 5. Build issue context using appropriate builder
		// Use label-based prompt ONLY if we have a label-based system prompt
		const promptType = this.determinePromptType(
			input,
			!!labelBasedSystemPrompt,
		);
		// Build workspace repo paths map for prompt context.
		// For multi-repo sessions, workspace.repoPaths maps each repo ID to its worktree.
		// For single-repo sessions, use workspace.path as the worktree for the primary repo.
		const workspaceRepoPaths =
			input.session.workspace.repoPaths ??
			(repositories.length === 1
				? { [repositories[0]!.id]: input.session.workspace.path }
				: undefined);
		const issueContext = await this.buildIssueContextForPromptAssembly(
			input.fullIssue,
			repositories,
			promptType,
			input.attachmentManifest,
			input.guidance,
			input.agentSession,
			input.resolvedBaseBranches,
			workspaceRepoPaths,
		);

		parts.push(issueContext.prompt);
		components.push("issue-context");

		// 4. Add user comment (if present)
		// Skip for mention-triggered prompts since the comment is already in the mention block
		if (input.userComment.trim() && !input.isMentionTriggered) {
			// If we have author/timestamp metadata, include it for multi-player context
			if (input.commentAuthor || input.commentTimestamp) {
				const author = input.commentAuthor || "Unknown";
				const timestamp = input.commentTimestamp || new Date().toISOString();
				parts.push(`<user_comment>
  <author>${author}</author>
  <timestamp>${timestamp}</timestamp>
  <content>
${input.userComment}
  </content>
</user_comment>`);
			} else {
				// Legacy format without metadata
				parts.push(`<user_comment>\n${input.userComment}\n</user_comment>`);
			}
			components.push("user-comment");
		}

		// 6. Add guidance rules (if present)
		if (input.guidance && input.guidance.length > 0) {
			components.push("guidance-rules");
		}

		return {
			systemPrompt,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType,
				isNewSession: true,
				isStreaming: false,
			},
		};
	}

	/**
	 * Build an <agent_context> block with dynamic values that skills can reference.
	 *
	 * Provides bot usernames so skills (e.g. verify-and-ship) can refer to the
	 * correct bot account without hardcoding.
	 */
	private buildAgentContextBlock(): string {
		const githubBot = process.env.GITHUB_BOT_USERNAME || "";
		const gitlabBot = process.env.GITLAB_BOT_USERNAME || "";

		if (!githubBot && !gitlabBot) {
			return "";
		}

		const lines: string[] = ["\n\n<agent_context>"];
		if (githubBot) {
			lines.push(`  <github_bot_username>${githubBot}</github_bot_username>`);
		}
		if (gitlabBot) {
			lines.push(`  <gitlab_bot_username>${gitlabBot}</gitlab_bot_username>`);
		}
		lines.push("</agent_context>");

		return lines.join("\n");
	}

	/**
	 * Build prompt for existing session continuation - user comment and attachments only
	 */
	private buildContinuationPrompt(input: PromptAssemblyInput): PromptAssembly {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		// Wrap comment in XML with author and timestamp for multi-player context
		const author = input.commentAuthor || "Unknown";
		const timestamp = input.commentTimestamp || new Date().toISOString();

		const commentXml = `<new_comment>
  <author>${author}</author>
  <timestamp>${timestamp}</timestamp>
  <content>
${input.userComment}
  </content>
</new_comment>`;

		const parts: string[] = [commentXml];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: false,
			},
		};
	}

	/**
	 * Determine the prompt type based on input flags and system prompt availability
	 */
	private determinePromptType(
		input: PromptAssemblyInput,
		hasSystemPrompt: boolean,
	): PromptType {
		if (input.isMentionTriggered && input.isLabelBasedPromptRequested) {
			return "label-based-prompt-command";
		}
		if (input.isMentionTriggered) {
			return "mention";
		}
		if (hasSystemPrompt) {
			return "label-based";
		}
		return "fallback";
	}

	/**
	 * Load shared instructions that get appended to all system prompts
	 */
	private async loadSharedInstructions(): Promise<string> {
		return this.promptBuilder.loadSharedInstructions();
	}

	/**
	 * Adapter method for prompt assembly - routes to appropriate issue context builder
	 */
	private async buildIssueContextForPromptAssembly(
		issue: Issue,
		repositories: RepositoryConfig[],
		promptType: PromptType,
		attachmentManifest?: string,
		guidance?: GuidanceRule[],
		agentSession?: WebhookAgentSession,
		resolvedBaseBranches?: Record<string, BaseBranchResolution>,
		workspaceRepoPaths?: Record<string, string>,
	): Promise<IssueContextResult> {
		// Delegate to appropriate builder based on promptType
		if (promptType === "mention") {
			if (!agentSession) {
				throw new Error(
					"agentSession is required for mention-triggered prompts",
				);
			}
			return this.buildMentionPrompt(
				issue,
				agentSession,
				attachmentManifest,
				guidance,
			);
		}
		if (
			promptType === "label-based" ||
			promptType === "label-based-prompt-command"
		) {
			return this.promptBuilder.buildLabelBasedPrompt(
				issue,
				repositories,
				attachmentManifest,
				guidance,
				resolvedBaseBranches,
			);
		}
		// Fallback to standard issue context
		return this.promptBuilder.buildIssueContextPrompt(
			issue,
			repositories,
			undefined, // No new comment for initial prompt assembly
			attachmentManifest,
			guidance,
			resolvedBaseBranches,
			workspaceRepoPaths,
		);
	}

	/**
	 * Resolve the default runner type for SimpleRunner (classification) use.
	 * Uses config.defaultRunner if set, otherwise auto-detects from API keys,
	 * falling back to "claude".
	 */
	/**
	 * Resolve the Anthropic auth env for a workspace (PON-139) — the ONE place
	 * every Claude-subprocess construction site goes through. Three sites use
	 * it: issue sessions (buildAgentRunnerConfig), warm spawn
	 * (warmupRecentSessions), and chat sessions (the createRunner callback).
	 * A fourth construction site that skips this helper is a credential bug by
	 * definition — the adversarial review of the first wiring attempt found
	 * exactly two such sites, which is why this is a helper and not a block.
	 *
	 * Throws on an undeclared workspace. Returns undefined when there is no
	 * workspace at all (non-Linear platforms): no tenant to attribute to, so
	 * the legacy ambient tier applies, logged.
	 */
	private resolveAuthEnvForWorkspace(
		workspaceId: string | undefined,
		log: { info: (m: string) => void; warn: (m: string) => void },
	): Record<string, string | undefined> | undefined {
		if (!workspaceId) {
			log.warn(
				"Session has no Linear workspace; running on the box's ambient Anthropic credential (legacy tier)",
			);
			return undefined;
		}
		const wsConfig = this.config.linearWorkspaces?.[workspaceId];
		const env = resolveWorkspaceAuthEnv(wsConfig?.anthropicAuth, workspaceId, {
			workspaceName: wsConfig?.linearWorkspaceName,
			subscriptionToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		});
		log.info(
			`[event:workspace_auth_resolved] {"workspaceId":"${workspaceId}","auth":"${describeWorkspaceAuth(wsConfig?.anthropicAuth)}"}`,
		);
		return env;
	}

	/**
	 * Build agent runner configuration with common settings.
	 * Delegates to RunnerConfigBuilder for shared config assembly.
	 * @returns Object containing the runner config and runner type to use
	 */
	private async buildAgentRunnerConfig(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		systemPrompt: string | undefined,
		allowedTools: string[],
		allowedDirectories: string[],
		disallowedTools: string[],
		resumeSessionId?: string,
		labels?: string[],
		issueDescription?: string,
		maxTurns?: number,
		linearWorkspaceId?: string,
		skillContext?: SkillSessionContext,
		/**
		 * Which platform initiated the session — drives which
		 * `EdgeWorkerConfig.<platform>McpConfigs` override list applies.
		 * Defaults to `"linear"` (the pre-platform-aware behavior).
		 */
		sessionPlatform: "linear" | "github" | "gitlab" = "linear",
	): Promise<{ config: AgentRunnerConfig; runnerType: RunnerType }> {
		const log = this.logger.withContext({
			sessionId,
			platform: session.issueContext?.trackerId,
			issueIdentifier: session.issueContext?.issueIdentifier,
			workspaceId: linearWorkspaceId,
		});

		// Resolve plugins once so we can also derive the per-session scoped
		// skill allow-list from the same filesystem snapshot.
		const plugins = await this.skillsPluginResolver.resolve();
		const resolvedSkillContext: SkillSessionContext = skillContext ?? {
			repositoryId: repository.id,
			repoPaths: this.resolveSkillRepoPaths(repository, session),
		};
		const allowedSkillNames =
			await this.skillsPluginResolver.discoverSkillNames(
				plugins,
				resolvedSkillContext,
			);

		const result = this.runnerConfigBuilder.buildIssueConfig({
			session,
			repository,
			sessionId,
			systemPrompt,
			allowedTools,
			allowedDirectories,
			disallowedTools,
			resumeSessionId,
			labels,
			issueDescription,
			maxTurns,
			// Per-platform MCP config paths — GitHub + GitLab share the
			// `githubMcpConfigs` knob (single-repo PR contexts both); Linear
			// gets `linearMcpConfigs`. Not a blanket override: the builder
			// uses `repository.mcpConfigPath` when this repo has its own
			// `allowedTools` override (so the repo's permission rules and
			// MCP server set travel as a unit), and only falls through to
			// this list when the repo inherits the platform allow-list.
			platformMcpConfigOverrides:
				sessionPlatform === "linear"
					? this.config.linearMcpConfigs
					: this.config.githubMcpConfigs,
			linearWorkspaceId,
			cyrusHome: this.cyrusHome,
			logger: log,
			plugins,
			skills: allowedSkillNames,
			sandboxSettings: this.sdkSandboxSettings ?? undefined,
			egressCaCertPath: this.egressCaCertPath ?? undefined,
			onMessage: (message: SDKMessage) => {
				this.handleClaudeMessage(sessionId, message, repository.id);
			},
			onError: (error: Error) => {
				this.handleClaudeError(error);
				// PON-112: a runner that dies without emitting a result message
				// must not wedge the workspace lane.
				this.handleLaneRunnerError(sessionId);
			},
			// PON-154: the lane releases when the runner's stream ACTUALLY ends,
			// not on result messages. A Stop-hook-blocked stop emits a result and
			// keeps streaming; releasing there admitted a second session into a
			// concurrency-1 lane, observed live. completeSession defers its
			// release whenever the runner still reports running; this is the
			// event that then fires. Release is idempotent, so the fallback
			// double-fire for already-stopped runners is a no-op.
			onComplete: () => {
				this.handleLaneSessionEnded(sessionId, "runner_complete");
			},
			createAskUserQuestionCallback: (sid, wid) =>
				this.createAskUserQuestionCallback(sid, wid)!,
			createCapabilityGuard: (sid, wid) => this.createCapabilityGuard(sid, wid),
			requireLinearWorkspaceId,
		});

		// PON-202: the session's own git/gh credentials, resolved per repository
		// from the worktree's OWN origin remote. Every runner pushes, so this
		// sits outside the Claude-only credential block below.
		const sessionGitEnv = await this.buildSessionGitEnv(session.workspace.path);
		if (Object.keys(sessionGitEnv).length > 0) {
			const runnerConfig = result.config as AgentRunnerConfig & {
				additionalEnv?: Record<string, string | undefined>;
			};
			runnerConfig.additionalEnv = {
				...runnerConfig.additionalEnv,
				...sessionGitEnv,
			};
			log.event("session_git_credentials_injected", {
				sessionId,
				worktree: session.workspace.path,
			});
		}

		// PON-139: per-workspace Anthropic credentials. This is the runtime
		// wiring of the three-state declaration — the resolver and schema shipped
		// in PR #15, but nothing called them at session start, so every session
		// still ran on whatever the box environment held and the documented
		// refusal did not actually exist. Found in the pre-verification audit,
		// not by a failing session.
		//
		// Claude sessions only: the declaration is Anthropic-specific, and other
		// runners neither read these variables nor should have them.
		let sessionAuthEnv: Record<string, string | undefined> | undefined;
		if (result.runnerType === "claude") {
			// Throws on an undeclared workspace, naming it — the session start
			// fails loudly rather than borrowing the box credential. Reachable
			// only on a box whose config was never gated through
			// `cyrus check-workspace-auth`.
			try {
				// PON-225/D7: on a cockpit mirror the credential follows the
				// cockpit, exactly as the session surface already does. These
				// are our own implementation and review sessions in our own
				// workspace; the locked split puts them on the subscription and
				// leaves the tenant's metered key paying only for what the
				// client is actually talked to with. Reading it off the operator
				// link rather than threading a parameter keeps it true for every
				// mirror session, including the ones that resume after a restart.
				const cockpitAuthWorkspaceId =
					this.operatorSessions.get(sessionId)?.cockpitWorkspaceId;
				sessionAuthEnv = this.resolveAuthEnvForWorkspace(
					cockpitAuthWorkspaceId ??
						linearWorkspaceId ??
						repository.linearWorkspaceId,
					log,
				);
			} catch (authError) {
				// The refusal must be VISIBLE where the tenant is looking. Every
				// entry path — created, prompted, parked wake, PR-review — has
				// already posted an acknowledgment by the time it reaches here,
				// and every one of them swallows this throw after journaling it.
				// Without this post, the client sees "Got it. Looking at this
				// now." followed by permanent silence; with lane serialization
				// on, the release backstop then replays the next queued session
				// into the same refusal, silently draining their whole backlog.
				// The drain still happens — every queued session of a
				// misconfigured workspace WILL refuse — but each one now says so
				// on the issue, which turns a vanished queue into a list of
				// explicit, re-delegatable failures. (Found by the adversarial
				// review of this wiring, not by a client.)
				await this.agentSessionManager
					.createErrorActivity(
						sessionId,
						CLIENT_MESSAGES.workspaceNotConfigured(),
					)
					.catch((postError) => {
						log.warn(
							`Failed to post workspace-auth refusal activity: ${(postError as Error).message}`,
						);
					});
				throw authError;
			}
			if (sessionAuthEnv) {
				// Spread last so the declared credential replaces — and, where the
				// declaration requires it, unsets — anything inherited from the
				// box. No SDK precedence rule is load-bearing after this line.
				const claudeConfig = result.config as AgentRunnerConfig & {
					additionalEnv?: Record<string, string | undefined>;
				};
				claudeConfig.additionalEnv = {
					...claudeConfig.additionalEnv,
					...sessionAuthEnv,
				};
			}
		}

		// Attach pre-warmed session if available (only for Claude runner).
		// Skipped entirely when warm sessions are not enabled.
		//
		// PON-139: a warm subprocess's environment is fixed at spawn — attaching
		// one cannot change what credential it holds, because the child process
		// already exists (ClaudeRunner bypasses queryOptions entirely on warm
		// attach). So attach is allowed only on PROOF: the auth env resolved for
		// this session must deep-equal the auth env the warm subprocess was
		// spawned with. The first version of this guard assumed subscription
		// mode "matches the ambient credential by construction" — the
		// adversarial review refuted that: nothing enforces the subscription
		// token being the box's only ambient auth var, and on a box carrying a
		// second one the warm child holds both, with SDK precedence deciding
		// which tenant gets billed. Comparison replaces assumption. A mismatch
		// costs a cold start; billing one tenant's work to another is not a
		// latency trade.
		if (result.runnerType === "claude" && this.isWarmSessionsEnabled()) {
			const warmEntry = this.warmInstances.get(sessionId);
			if (warmEntry) {
				const authMatches =
					JSON.stringify(warmEntry.authEnv ?? null) ===
					JSON.stringify(sessionAuthEnv ?? null);
				if (authMatches) {
					this.warmInstances.delete(sessionId);
					(
						result.config as AgentRunnerConfig & { warmSession?: WarmQuery }
					).warmSession = warmEntry.query;
					log.debug("Attaching pre-warmed session to runner config");
				} else {
					// Close and remove it. There is no pool sweep — a refused entry
					// left behind is a live subprocess holding the wrong credential
					// set in a tenant worktree, forever. Never attach it, never
					// keep it.
					this.warmInstances.delete(sessionId);
					try {
						warmEntry.query.close();
					} catch {
						// Best-effort: a subprocess that will not close is a zombie
						// either way; the journal line below is the trail.
					}
					log.warn(
						"[event:warm_attach_refused] pre-warmed session's auth env does not match this session's resolved auth; closed the warm subprocess and cold-starting",
					);
				}
			}
		}

		return result;
	}

	/**
	 * Create an onAskUserQuestion callback for the ClaudeRunner.
	 * This callback delegates to the AskUserQuestionHandler which posts
	 * elicitations to Linear and waits for user responses.
	 *
	 * @param linearAgentSessionId - Linear agent session ID for tracking
	 * @param organizationId - Linear organization/workspace ID
	 */
	/**
	 * Is the deliverable-framed scope readable on the client thread? (PON-188)
	 *
	 * The gate tells the session to post the scope itself, and the session
	 * does — as assistant text, which is narration, which client-quiet
	 * workspaces suppress. That is how ACM-10's client got an elicitation
	 * pointing at "the scope above" with nothing above it.
	 *
	 * So the machinery carries it, from the `client_scope` text the gate
	 * already makes the session record (PON-170) — and it carries it INSIDE
	 * the confirmation question (PON-196). Three surfaces were tried: as
	 * narration it was suppressed and the client approved nothing (PON-188);
	 * as a comment it was readable but left a comment trail on the client's
	 * thread (PON-192). An elicitation is never collapsed, is always visible
	 * in the panel, reads standalone in an email, and leaves nothing behind.
	 *
	 * Returns the composed ask, or null when there is no scope to show —
	 * which the caller turns into a refusal to ask at all. Nothing is posted
	 * here; the ask itself is the delivery.
	 */
	private composeScopeAsk(sessionId: string, issueId: string): string | null {
		const record = this.scopeApprovals.get(issueId);
		const scope = record?.clientScope?.trim();
		if (!scope) return null;

		const session = this.agentSessionManager.getSession(sessionId);
		const body = buildScopeAskBody(scope, {
			identifier: session?.issueContext?.issueIdentifier,
			title: session?.issue?.title,
		});
		return this.agentSessionManager.sanitizeClientSurfaceText(
			sessionId,
			"scope-ask",
			body,
		);
	}

	private createAskUserQuestionCallback(
		linearAgentSessionId: string,
		organizationId: string,
	): AgentRunnerConfig["onAskUserQuestion"] {
		return async (input, _sessionId, signal) => {
			// PON-150: an Approve-labelled option marks this elicitation as the
			// gate's confirmation ask — record the proposal (first one stamps
			// proposedAt) before the lane releases, so the events read
			// scope_confirm_posted → lane_released.
			const gateIssueId = this.sessionIssueId(linearAgentSessionId);
			const gateQuestion = input.questions?.[0];
			// v3.1 P2: a canonical needs-info ask from a MIRROR session is
			// relayed to the client's own thread and parked here. Before this,
			// the elicitation went through the client's tracker addressed to
			// the cockpit session id — a foreign session — and failed; the
			// prompt told the run never to contact the client at all.
			const operatorLink = this.operatorSessions.get(linearAgentSessionId);
			if (operatorLink && gateQuestion && isNeedsInfoQuestion(gateQuestion)) {
				return this.relayQuestionToClient(
					operatorLink,
					linearAgentSessionId,
					input,
					signal,
				);
			}
			if (
				gateQuestion &&
				this.scopeGatePendingForIssue(organizationId, gateIssueId) &&
				isScopeConfirmQuestion(gateQuestion)
			) {
				// PON-188/196: never ask a client to approve a scope they
				// cannot read. The scope IS the ask now — composed here from
				// the recorded client_scope and spliced into the question, so
				// there is no second surface to go missing. No recorded
				// scope, no elicitation: nothing is posted, nothing stamped,
				// and the session is told to record it and ask again.
				const scopeAsk = this.composeScopeAsk(
					linearAgentSessionId,
					gateIssueId as string,
				);
				if (!scopeAsk) {
					this.logger.event("scope_confirm_refused_no_scope", {
						issueId: gateIssueId,
						workspaceId: organizationId,
						sessionId: linearAgentSessionId,
					});
					return {
						answered: false,
						message:
							"Not asked: the deliverable-framed scope has not reached the client, so this question would ask them to approve something they cannot read. Record the exact client-facing scope text with record_operator_note's client_scope input, then ask this question again.",
					};
				}
				// The scope replaces the session's question text: the client
				// reads the scope, then "Proceed?", then the options the session
				// wrote for them.
				gateQuestion.question = scopeAsk;
				const session =
					this.agentSessionManager.getSession(linearAgentSessionId);
				this.scopeApprovals.recordProposed(gateIssueId as string, {
					workspaceId: organizationId,
					issueIdentifier: session?.issueContext?.issueIdentifier,
				});
				// Records the exact text put in front of the client, which is what
				// the operator brief later reads back as "what they approved".
				this.scopeApprovals.markClientScopePosted(
					gateIssueId as string,
					this.scopeApprovals.get(gateIssueId as string)?.clientScope ?? "",
				);
				this.logger.event("client_scope_in_ask", {
					issueId: gateIssueId,
					workspaceId: organizationId,
					sessionId: linearAgentSessionId,
					length: scopeAsk.length,
				});
				this.logger.event("scope_confirm_posted", {
					issueId: gateIssueId,
					issueIdentifier: session?.issueContext?.issueIdentifier,
					workspaceId: organizationId,
					proposedAt: this.scopeApprovals.get(gateIssueId as string)
						?.proposedAt,
				});
				// PON-219: no mirror here any more. Until the client approves,
				// the scope conversation is theirs and the agent's alone, and
				// an unapproved issue in the operator's queue is work he has
				// not been asked to do yet. persistScopeApprovals refreshes the
				// waiting room, which is where a stalled conversation surfaces.
				await this.persistScopeApprovals("scope_confirm_posted");
			} else if (
				gateQuestion &&
				gateIssueId &&
				this.scopeGatePendingForIssue(organizationId, gateIssueId)
			) {
				// An item the operator cannot see is the precise failure the
				// waiting room exists to prevent (FRO-65, live).
				//
				// Both registers recognise by EXACT canonical form — the scope
				// record needs the `Approve scope` option, needs-info needs the
				// `Missing info` header — and needs-info is additionally scoped
				// to gate-closed issues. So a pre-approval question in neither
				// form lands in neither register: the session sits at
				// `awaitingInput`, the lane correctly releases, nothing is
				// blocked, and the conversation is simply invisible.
				//
				// That is not a rare shape. FRO-65 asked a good question —
				// the repository had no tests at all, so it asked what the
				// client actually wanted rather than proposing scope for a
				// false premise. Exactness is right for DECISIONS (an approval
				// must never be inferred from prose); it is wrong as the only
				// route onto a list whose whole job is "somebody is waiting".
				//
				// `recordProposed` is deliberately the mechanism rather than a
				// new store: it already keeps the earliest `proposedAt`, it is
				// idempotent, and the SLA clock is `approvedAt`, which this
				// does not touch. A later real scope proposal on the same
				// issue refines this record rather than replacing it.
				const session =
					this.agentSessionManager.getSession(linearAgentSessionId);
				const already = this.scopeApprovals.get(gateIssueId);
				this.scopeApprovals.recordProposed(gateIssueId, {
					workspaceId: organizationId,
					issueIdentifier: session?.issueContext?.issueIdentifier,
				});
				if (!already) {
					this.logger.event("scope_conversation_registered", {
						issueId: gateIssueId,
						issueIdentifier: session?.issueContext?.issueIdentifier,
						workspaceId: organizationId,
						sessionId: linearAgentSessionId,
					});
				}
				await this.persistScopeApprovals("scope_conversation_registered");
			}
			// PON-172: a needs-info ask gets its own bookkeeping — a distinct
			// release reason, a cockpit state, and a persisted record so the
			// wait survives restarts and stays visible. Recognition by exact
			// canonical header; the scope gate takes precedence (pre-approval,
			// missing info is scope discussion).
			let releaseReason: string | undefined;
			if (
				gateQuestion &&
				gateIssueId &&
				isNeedsInfoQuestion(gateQuestion) &&
				!this.scopeGatePendingForIssue(organizationId, gateIssueId)
			) {
				const session =
					this.agentSessionManager.getSession(linearAgentSessionId);
				this.needsInfo.recordAsked(gateIssueId, {
					question: gateQuestion.question ?? "",
					sessionId: linearAgentSessionId,
					workspaceId: organizationId,
					issueIdentifier: session?.issueContext?.issueIdentifier,
				});
				this.logger.event("needs_info_asked", {
					issueId: gateIssueId,
					issueIdentifier: session?.issueContext?.issueIdentifier,
					workspaceId: organizationId,
					sessionId: linearAgentSessionId,
				});
				await this.persistScopeApprovals("needs_info_asked");
				releaseReason = "awaiting_client_info";
				void this.cockpitMirror.upsert(
					{
						issueId: gateIssueId,
						issueIdentifier: session?.issueContext?.issueIdentifier,
					},
					organizationId,
					"needs-info",
				);
			}
			// PON-113: hand back the lane before blocking on the human. The
			// answer re-enters through lane admission, so this widens nothing
			// — it only stops an unanswered question from freezing the
			// client's whole queue.
			this.releaseLaneWhileAwaitingInput(linearAgentSessionId, releaseReason);
			// Note: We use linearAgentSessionId (from closure) instead of the passed sessionId
			// because the passed sessionId is the Claude session ID, not the Linear agent session ID
			return this.askUserQuestionHandler.handleAskUserQuestion(
				input,
				linearAgentSessionId,
				organizationId,
				signal,
			);
		};
	}

	/**
	 * Build disallowed tools list following the same hierarchy as allowed tools.
	 * Accepts single or multiple repositories (intersection for multi-repo).
	 */
	private buildDisallowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		return this.toolPermissionResolver.buildDisallowedTools(
			repositories,
			promptType,
		);
	}

	/**
	 * Build allowed tools list with Linear MCP tools automatically included.
	 * Accepts single or multiple repositories (union for multi-repo).
	 */
	private buildAllowedTools(
		repositories: RepositoryConfig | RepositoryConfig[],
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		return this.toolPermissionResolver.buildAllowedTools(
			repositories,
			promptType,
		);
	}

	/**
	 * Get Agent Sessions for an issue
	 */
	public getAgentSessionsForIssue(
		issueId: string,
		_repositoryId: string,
	): any[] {
		return this.agentSessionManager.getSessionsByIssueId(issueId);
	}

	// ========================================================================
	// User Access Control
	// ========================================================================

	/**
	 * Check if the user who triggered the webhook is allowed to interact.
	 * @param webhook The webhook containing user information
	 * @param repository The repository configuration
	 * @returns Access check result with allowed status and user name
	 */
	private checkUserAccess(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
	): { allowed: true } | { allowed: false; reason: string; userName: string } {
		const creator = webhook.agentSession.creator;
		const userId = creator?.id;
		const userEmail = creator?.email;
		const userName = creator?.name || userId || "Unknown";

		const result = this.userAccessControl.checkAccess(
			userId,
			userEmail,
			repository.id,
		);

		if (!result.allowed) {
			return { allowed: false, reason: result.reason, userName };
		}
		return { allowed: true };
	}

	/**
	 * Handle blocked user according to configured behavior.
	 * Posts a response activity to end the session.
	 * @param webhook The webhook that triggered the blocked access
	 * @param repository The repository configuration
	 * @param _reason The reason for blocking (for logging)
	 */
	private async handleBlockedUser(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repository: RepositoryConfig,
		_reason: string,
	): Promise<void> {
		// Use organizationId from webhook as the Linear-native workspace ID source
		const issueTracker = this.issueTrackers.get(webhook.organizationId);
		const agentSessionId = webhook.agentSession.id;
		const behavior = this.userAccessControl.getBlockBehavior(repository.id);

		if (!issueTracker) {
			return;
		}

		if (behavior === "comment") {
			// Get user info for templating
			const creator = webhook.agentSession.creator;
			const userName = creator?.name || "User";
			const userId = creator?.id || "";

			// Get the message template and replace variables
			// Supported variables:
			// - {{userName}} - The user's display name
			// - {{userId}} - The user's Linear ID
			let message = this.userAccessControl.getBlockMessage(repository.id);
			message = message
				.replace(/\{\{userName\}\}/g, userName)
				.replace(/\{\{userId\}\}/g, userId);

			await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId,
					content: { type: "response", body: message },
				},
				"blocked user message",
				"sanctioned",
			);
		}
		// For "silent" behavior, we don't post any activity.
		// The session will remain in "Working" state until manually stopped or timed out.
	}

	/**
	 * Load persisted EdgeWorker state for all repositories
	 */
	private async loadPersistedState(): Promise<void> {
		try {
			const state = await this.persistenceManager.loadEdgeWorkerState();
			if (state) {
				this.restoreMappings(state);
				this.logger.debug(
					`✅ Loaded persisted EdgeWorker state with ${Object.keys(state.agentSessions || {}).length} sessions`,
				);
			}
		} catch (error) {
			this.logger.error(`Failed to load persisted EdgeWorker state:`, error);
		}
	}

	/**
	 * Whether the warm-session feature is enabled.
	 *
	 * Warm sessions are an opt-in optimization that pre-spawns Claude Code
	 * subprocesses on startup so the first query after a restart skips the
	 * cold-start cost. Disabled by default; opt in by setting
	 * `CYRUS_ENABLE_WARM_SESSIONS=1` (or `=true`).
	 */
	private isWarmSessionsEnabled(): boolean {
		const raw = process.env.CYRUS_ENABLE_WARM_SESSIONS;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}

	/**
	 * Whether the remote Claude session store is explicitly disabled.
	 *
	 * The remote store mirrors SDK transcripts to the Cyrus hosted control
	 * plane and is on by default whenever `CYRUS_APP_URL`, `CYRUS_API_KEY`,
	 * and `CYRUS_TEAM_ID` are all set. Operators can opt out — without
	 * unsetting those vars (which other features depend on) — by setting
	 * `CYRUS_DISABLE_REMOTE_SESSION_STORE=1` (or `=true`).
	 */
	private isRemoteSessionStoreDisabled(): boolean {
		const raw = process.env.CYRUS_DISABLE_REMOTE_SESSION_STORE;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}

	/**
	 * Pre-warm the N most recently updated Claude sessions so the first query
	 * after a CLI restart has near-zero cold-start latency (~20x faster).
	 *
	 * Uses startup() from @anthropic-ai/claude-agent-sdk with MCP_CONNECTION_NONBLOCKING=true
	 * so the warm instances are ready in ~500ms rather than ~4s.
	 * Warm instances are stored in this.warmInstances keyed by agentSessionId and
	 * consumed by buildAgentRunnerConfig() when the first message arrives.
	 *
	 * Gated by `isWarmSessionsEnabled()` — callers should check before invoking.
	 */
	private async warmupRecentSessions(count = 30): Promise<void> {
		const allSessions = this.agentSessionManager.getAllSessions();

		// Only warm Claude sessions that have a persisted session ID and a workspace path
		const candidates = allSessions
			.filter((s) => s.claudeSessionId && s.workspace?.path)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, count);

		if (candidates.length === 0) {
			this.logger.debug("No Claude sessions to pre-warm");
			return;
		}

		this.logger.info(
			`Pre-warming ${candidates.length} most recent Claude sessions...`,
		);

		const { startup } = await import("@anthropic-ai/claude-agent-sdk");

		await Promise.all(
			candidates.map(async (session) => {
				try {
					const repoId = this.sessionRepositories.get(session.id);
					const repo = repoId ? this.repositories.get(repoId) : undefined;
					if (!repo) {
						this.logger.debug(
							`No repo for session ${session.id}, skipping warmup`,
						);
						return;
					}

					// Build MCP config for this session (same as the live runner would use)
					const linearWorkspaceId = requireLinearWorkspaceId(repo);
					const mcpConfig = this.mcpConfigService.buildMcpConfig(
						repo.id,
						linearWorkspaceId,
						session.id,
					);

					// Merge any file-based MCP configs (reuses shared normalization).
					// Warmup paths reconstruct Linear-triggered issue sessions:
					// if the repo has its own `allowedTools` override its
					// mcpConfigPath stays scoped to that repo, otherwise the
					// team-level `linearMcpConfigs` list applies. Same coupling
					// the live `buildIssueConfig` path uses.
					const mcpConfigPath = resolveIssueMcpConfigPath(
						repo,
						this.config.linearMcpConfigs,
						this.mcpConfigService.buildMergedMcpConfigPath.bind(
							this.mcpConfigService,
						),
					);
					let mcpServers: Record<string, McpServerConfig> = { ...mcpConfig };
					if (mcpConfigPath) {
						const paths = Array.isArray(mcpConfigPath)
							? mcpConfigPath
							: [mcpConfigPath];
						for (const filePath of paths) {
							try {
								if (existsSync(filePath)) {
									const fileContent = JSON.parse(
										readFileSync(filePath, "utf8"),
									);
									const servers = fileContent.mcpServers || {};
									normalizeMcpHttpTransport(servers);
									mcpServers = { ...mcpServers, ...servers };
								}
							} catch {
								// Ignore unreadable MCP config files
							}
						}
					}

					const model = getPinnedModel(); // PON-110

					// Build allowed/disallowed tools — same as what buildAgentRunnerConfig() uses.
					// Without these, startup() inherits the user's defaultMode ("default"),
					// which causes macOS permission prompts for file writes.
					const allowedTools = this.buildAllowedTools(repo);
					const disallowedTools = this.buildDisallowedTools(repo);

					// PON-139: the warm subprocess's env is fixed forever at this
					// spawn, so the workspace credential must be resolved HERE, not
					// at attach. An undeclared workspace is skipped, not warmed —
					// warming it would spawn a child on the ambient credential and
					// dangle it as an attach hazard.
					let warmAuthEnv: Record<string, string | undefined> | undefined;
					try {
						warmAuthEnv = this.resolveAuthEnvForWorkspace(
							linearWorkspaceId,
							this.logger,
						);
					} catch (authError) {
						this.logger.warn(
							`Skipping pre-warm for session ${session.id}: ${(authError as Error).message.split("\n")[0]}`,
						);
						return; // map callback, not a loop body
					}

					const warm = await startup({
						options: {
							resume: session.claudeSessionId,
							model,
							cwd: session.workspace.path,
							...(Object.keys(mcpServers).length > 0 && { mcpServers }),
							...(allowedTools.length > 0 && { allowedTools }),
							...(disallowedTools.length > 0 && { disallowedTools }),
							settingSources: ["user", "project", "local"],
							// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is intentionally not set here;
							// see CYPACK-1108 and ClaudeRunner.start() for context.
							// Declared credential spread last: replaces and, where the
							// declaration requires it, unsets the forwarded auth vars.
							env: { ...buildBaseSessionEnv(), ...warmAuthEnv },
						},
					});

					this.warmInstances.set(session.id, {
						query: warm,
						authEnv: warmAuthEnv,
					});
					this.logger.info(
						`Pre-warmed session ${session.id} (${session.issueContext?.issueIdentifier ?? "unknown"})`,
					);
				} catch (err) {
					this.logger.debug(`Failed to pre-warm session ${session.id}:`, err);
				}
			}),
		);

		this.logger.info(
			`Session pre-warm complete: ${this.warmInstances.size} sessions ready`,
		);
	}

	/**
	 * Save current EdgeWorker state for all repositories
	 */
	private async savePersistedState(): Promise<void> {
		try {
			await this.savePersistedStateStrict();
		} catch (error) {
			this.logger.error(`Failed to save persisted EdgeWorker state:`, error);
		}
	}

	/**
	 * Persist state, PROPAGATING write failures. Used by the lane enqueue
	 * paths (PON-112): the client-visible "Queued — position #N" ack must
	 * never be posted for an entry that failed to reach disk.
	 */
	private async savePersistedStateStrict(): Promise<void> {
		const state = this.serializeMappings();
		await this.persistenceManager.saveEdgeWorkerState(state);
		this.logger.debug(
			`✅ Saved EdgeWorker state for ${Object.keys(state.agentSessions || {}).length} sessions`,
		);
	}

	/**
	 * Serialize EdgeWorker mappings to a serializable format (v4.0 flat format)
	 */
	public serializeMappings(): SerializableEdgeWorkerState {
		// Serialize Agent Session state - flat structure from single ASM
		const serializedState = this.agentSessionManager.serializeState();

		// Serialize child to parent agent session mapping from GlobalSessionRegistry
		const registryState = this.globalSessionRegistry.serializeState();
		const childToParentAgentSession = registryState.childToParentMap;

		// Serialize issue to repository cache from RepositoryRouter
		const issueRepositoryCache = Object.fromEntries(
			this.repositoryRouter.getIssueRepositoryCache().entries(),
		);

		return {
			agentSessions: serializedState.sessions,
			agentSessionEntries: serializedState.entries,
			childToParentAgentSession,
			issueRepositoryCache,
			lanes: this.laneManager.serialize(),
			scopeApprovals: this.scopeApprovals.serialize(),
			needsInfo: this.needsInfo.serialize(),
			cockpitMirrors: this.cockpitMirror.serialize(),
			pendingDeliveries: this.verificationGate.serialize(),
			heldClientLinks: this.agentSessionManager.serializeHeldLinks?.() ?? {},
			previewLinks: this.previewLinks.serialize(),
			mentionSessionIds: [...this.mentionSessionIds],
			operatorSessions: this.operatorSessions.serialize(),
		};
	}

	/**
	 * Restore EdgeWorker mappings from serialized state (v4.0 flat format)
	 */
	public restoreMappings(state: SerializableEdgeWorkerState): void {
		// Restore Agent Session state from flat format
		if (state.agentSessions && state.agentSessionEntries) {
			this.agentSessionManager.restoreState(
				state.agentSessions,
				state.agentSessionEntries,
			);

			// Rebuild session-to-repo mapping from issueRepositoryCache
			// For each restored session, look up its issue in the cache to find the repo
			if (state.issueRepositoryCache) {
				for (const [sessionId, session] of Object.entries(
					state.agentSessions,
				)) {
					const issueId =
						(session as any).issueContext?.issueId ?? (session as any).issueId;
					if (issueId && state.issueRepositoryCache[issueId]) {
						const cachedRepoIds = state.issueRepositoryCache[issueId];
						// Use first repo ID for session-to-repo mapping (primary repo)
						const repoId = cachedRepoIds[0];
						if (repoId) {
							this.sessionRepositories.set(sessionId, repoId);
							// Also register the activity sink for this restored session
							const activitySink = this.getActivitySinkForRepo(repoId);
							if (activitySink) {
								this.agentSessionManager.setActivitySink(
									sessionId,
									activitySink,
								);
							}
						}
					}
				}
			}

			this.logger.debug(
				`Restored ${Object.keys(state.agentSessions).length} sessions`,
			);
		}

		// Restore child to parent agent session mapping into GlobalSessionRegistry
		if (state.childToParentAgentSession) {
			const entries = Object.entries(state.childToParentAgentSession);
			for (const [childId, parentId] of entries) {
				this.globalSessionRegistry.setParentSession(childId, parentId);
			}
			this.logger.debug(
				`Restored ${entries.length} child-to-parent agent session mappings`,
			);
		}

		// Restore issue to repository cache in RepositoryRouter
		// Handles migration from old Record<string, string> to Record<string, string[]>
		if (state.issueRepositoryCache) {
			const cache = new Map(
				Object.entries(state.issueRepositoryCache) as [
					string,
					string | string[],
				][],
			);
			this.repositoryRouter.restoreIssueRepositoryCache(cache);
			this.logger.debug(
				`Restored ${cache.size} issue-to-repository cache mappings`,
			);
		}

		// Restore per-workspace lane state (PON-112). Restore never starts
		// runners; armLaneBootRecovery decides what happens to a restored
		// active session and drains lanes left free with queued work.
		if (state.lanes) {
			this.laneManager.restore(state.lanes);
		}

		// Restore per-issue scope approvals (PON-150). Absent in older state
		// reads as "no gate pending" — correct for issues already in flight
		// when the gate shipped.
		this.scopeApprovals.restore(state.scopeApprovals);
		this.needsInfo.restore(state.needsInfo);

		// Restore the cockpit mirror map (PON-151). Derived state — boot
		// reconciliation repairs it against reality right after startup.
		this.cockpitMirror.restore(state.cockpitMirrors);

		// Restore held deliveries (PON-152). A restart restores these — it
		// NEVER delivers them; that stays a human action.
		this.verificationGate.restore(state.pendingDeliveries);

		// PON-221: the links held from the client while that work is in
		// review. Restored alongside the record that releases them — the two
		// are one fact split across two objects, and restoring only half of
		// it loses the links on the next approval.
		this.agentSessionManager.restoreHeldLinks?.(state.heldClientLinks);
		this.previewLinks.restore(state.previewLinks);

		// Restore mention markers (PON-151/152): a mention session completing
		// after a restart must still post conversationally, never be held.
		this.mentionSessionIds = new Set(state.mentionSessionIds ?? []);
		this.operatorSessions.restore(state.operatorSessions);
	}

	/**
	 * Post an activity directly via an issue tracker instance.
	 * Consolidates try/catch and success/error logging for EdgeWorker call sites
	 * that already have the issueTracker and agentSessionId resolved.
	 *
	 * @returns The activity ID when resolved, `null` otherwise.
	 */
	private async postActivityDirect(
		issueTracker: IIssueTrackerService,
		input: AgentActivityCreateInput,
		label: string,
		kind: ClientSurfaceKind,
		workspaceId?: string,
	): Promise<string | null> {
		return this.activityPoster.postActivityDirect(
			issueTracker,
			input,
			label,
			kind,
			workspaceId,
		);
	}

	/**
	 * Post instant acknowledgment thought when agent session is created
	 */
	private async postInstantAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		return this.activityPoster.postInstantAcknowledgment(
			sessionId,
			linearWorkspaceId,
		);
	}

	/**
	 * Post parent resume acknowledgment thought when parent session is resumed from child
	 */
	private async postParentResumeAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
	): Promise<void> {
		return this.activityPoster.postParentResumeAcknowledgment(
			sessionId,
			linearWorkspaceId,
		);
	}

	/**
	 * Handle prompt with streaming check - centralized logic for all input types
	 *
	 * This method implements the unified pattern for handling prompts:
	 * 1. Check if runner is actively streaming
	 * 2. Add to stream if streaming, OR resume session if not
	 *
	 * @param session The Cyrus agent session
	 * @param repository Repository configuration
	 * @param sessionId Linear agent activity session ID
	 * @param agentSessionManager Agent session manager instance
	 * @param promptBody The prompt text to send
	 * @param attachmentManifest Optional attachment manifest to append
	 * @param isNewSession Whether this is a new session
	 * @param additionalAllowedDirs Additional directories to allow access to
	 * @param logContext Context string for logging (e.g., "prompted webhook", "parent resume")
	 * @returns true if message was added to stream, false if session was resumed
	 */
	private async handlePromptWithStreamingCheck(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		agentSessionManager: AgentSessionManager,
		promptBody: string,
		attachmentManifest: string,
		isNewSession: boolean,
		additionalAllowedDirs: string[],
		logContext: string,
		linearWorkspaceId: string,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<boolean> {
		const log = this.logger.withContext({ sessionId });
		const existingRunner = session.agentRunner;

		// Handle running case - add message to existing stream (if supported)
		if (
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
			log.debug(
				`Adding prompt to existing stream for ${sessionId} (${logContext})`,
			);

			// Append attachment manifest to the prompt if we have one
			let fullPrompt = promptBody;
			if (attachmentManifest) {
				fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
			}

			// `addStreamMessage` can reject the message if the turn ended in the
			// race window between "still running" and "turn finished" (e.g. the
			// Codex app-server backend, which only steers an active turn). Fall
			// through to the resume path so the comment is never dropped. Claude's
			// streaming input never throws here, so this is a no-op for Claude.
			try {
				existingRunner.addStreamMessage(fullPrompt);
				return true; // Message added to stream
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume (${logContext})`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		}

		// Not streaming (or streaming was rejected) - resume/start session
		log.debug(`Resuming Claude session for ${sessionId} (${logContext})`);

		await this.resumeAgentSession(
			session,
			repository,
			sessionId,
			agentSessionManager,
			promptBody,
			attachmentManifest,
			isNewSession,
			additionalAllowedDirs,
			linearWorkspaceId,
			undefined, // maxTurns
			commentAuthor,
			commentTimestamp,
		);

		return false; // Session was resumed
	}

	/**
	 * Post thought about system prompt selection based on labels
	 */
	private async postSystemPromptSelectionThought(
		sessionId: string,
		labels: string[],
		linearWorkspaceId: string,
		repositoryId: string,
	): Promise<void> {
		return this.activityPoster.postSystemPromptSelectionThought(
			sessionId,
			labels,
			linearWorkspaceId,
			repositoryId,
		);
	}

	/**
	 * Resume or create an Agent session with the given prompt
	 * This is the core logic for handling prompted agent activities
	 * @param session The Cyrus agent session
	 * @param repository The repository configuration
	 * @param sessionId The Linear agent session ID
	 * @param agentSessionManager The agent session manager
	 * @param promptBody The prompt text to send
	 * @param attachmentManifest Optional attachment manifest
	 * @param isNewSession Whether this is a new session
	 */
	async resumeAgentSession(
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		agentSessionManager: AgentSessionManager,
		promptBody: string,
		attachmentManifest: string = "",
		isNewSession: boolean = false,
		additionalAllowedDirectories: string[] = [],
		linearWorkspaceId?: string,
		maxTurns?: number,
		commentAuthor?: string,
		commentTimestamp?: string,
	): Promise<void> {
		const log = this.logger.withContext({ sessionId });
		// PON-212 was only wired at session CREATION, so a resumed session
		// narrated nowhere — and a restart resumes everything. Live effect on
		// ACM-19: the mirror showed the scope investigation and NONE of the
		// implementation that followed approval, which is the half that makes
		// the other half read as work-before-consent.
		// Check for existing runner
		const existingRunner = session.agentRunner;

		// If there's an existing running runner that supports streaming, add to it
		if (
			existingRunner?.isRunning() &&
			existingRunner.supportsStreamingInput &&
			existingRunner.addStreamMessage
		) {
			let fullPrompt = promptBody;
			if (attachmentManifest) {
				fullPrompt = `${promptBody}\n\n${attachmentManifest}`;
			}
			// See handlePromptWithStreamingCheck: a steer-only backend can reject
			// the message if the turn just ended. Fall through to a fresh resume
			// turn rather than dropping the comment. No-op for Claude.
			try {
				existingRunner.addStreamMessage(fullPrompt);
				return;
			} catch (error) {
				log.warn(
					`Streaming message rejected for ${sessionId}; falling back to resume`,
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		}

		// Stop existing runner if it's not running
		if (existingRunner) {
			existingRunner.stop();
		}

		// Get issueId from issueContext (preferred) or deprecated issueId field
		const issueIdForResume = session.issueContext?.issueId ?? session.issueId;
		if (!issueIdForResume) {
			log.error(`No issue ID found for session ${session.id}`);
			throw new Error(`No issue ID found for session ${session.id}`);
		}

		// Fetch full issue details using workspace ID (from webhook context or repo fallback)
		const resolvedWorkspaceId =
			linearWorkspaceId ?? requireLinearWorkspaceId(repository);
		const fullIssue = await this.fetchFullIssueDetails(
			issueIdForResume,
			resolvedWorkspaceId,
		);
		if (!fullIssue) {
			log.error(`Failed to fetch full issue details for ${issueIdForResume}`);
			throw new Error(
				`Failed to fetch full issue details for ${issueIdForResume}`,
			);
		}

		// PON-164: a resume must land in a REAL checkout. A restored session
		// can point at a deleted directory, or — for sessions created before
		// PON-161 — at the empty-directory fallback. Observed live on
		// agent-prod: scope re-admission resumed a runner into a missing
		// worktree, with no creation and no credential minting. Validate,
		// re-create through the same authenticated path a fresh session
		// uses, and treat a refusal as terminal exactly like the created
		// path does. (The live-streaming shortcut above is exempt: a running
		// process cannot have its directory re-created underneath it.)
		const checkoutValid = (p: string) =>
			existsSync(p) && existsSync(join(p, ".git"));
		const workspaceIsRealCheckout = (
			w: import("cyrus-core").Workspace | undefined,
		): boolean =>
			!!w?.path &&
			existsSync(w.path) &&
			w.isGitWorktree !== false &&
			(w.repoPaths
				? Object.values(w.repoPaths).every((p) => checkoutValid(p))
				: checkoutValid(w.path));
		const ws = session.workspace;
		if (!workspaceIsRealCheckout(ws)) {
			log.warn(
				`Resume workspace for ${fullIssue.identifier} is missing or not a git checkout (path=${ws?.path ?? "none"}, isGitWorktree=${String(ws?.isGitWorktree)}) — re-creating before any runner starts (PON-164)`,
			);
			// Terminal helper shared by every dead-end below: visible error,
			// journal event, lane slot freed, cockpit mirror closed, no runner.
			const terminalResume = async (clientBody: string, repoName: string) => {
				await this.agentSessionManager.createErrorActivity(
					sessionId,
					clientBody,
				);
				this.logger.event("worktree_refusal_terminal", {
					issueId: fullIssue.id,
					repository: repoName,
					sessionId,
					phase: "resume",
				});
				this.handleLaneSessionEnded(sessionId, "not_started");
			};
			// Re-create with the session's FULL repository set, not just the
			// primary: a multi-repo session re-created single-repo would lose
			// its repoPaths map and silently collapse to one repository
			// (adversarial review finding, 2026-08-24). The resolved base
			// branches recorded at creation ride along so the re-created
			// checkout lands where the original did.
			const contextRepos = (session.repositories ?? [])
				.map((ctx) => this.repositories.get(ctx.repositoryId))
				.filter((r): r is RepositoryConfig => !!r);
			const recreateRepos =
				contextRepos.length > 0 ? contextRepos : [repository];
			const recreateOverrides = new Map<string, string>();
			for (const ctx of session.repositories ?? []) {
				if (ctx.baseBranchName) {
					recreateOverrides.set(ctx.repositoryId, ctx.baseBranchName);
				}
			}
			try {
				const fresh = this.config.handlers?.createWorkspace
					? await this.config.handlers.createWorkspace(
							fullIssue,
							recreateRepos,
							{
								...(recreateOverrides.size > 0
									? { baseBranchOverrides: recreateOverrides }
									: {}),
								resolveGitAuth: (repositoryPath, operation) =>
									this.resolveGitAuthForRepoPath(repositoryPath, operation),
							},
						)
					: await this.gitService.createGitWorktree(
							fullIssue,
							recreateRepos,
							recreateOverrides.size > 0
								? { baseBranchOverrides: recreateOverrides }
								: {},
						);
				// Trust nothing: the generic worktree fallbacks can still hand
				// back an empty directory or a stale deleted path (reuse
				// branch). A re-creation that did not produce a REAL checkout
				// is terminal, not a workspace (adversarial review finding).
				if (!workspaceIsRealCheckout(fresh)) {
					await terminalResume(
						CLIENT_MESSAGES.workspaceUnpreparable(),
						repository.name ?? repository.id,
					);
					return;
				}
				session.workspace = {
					...fresh,
					...(ws?.historyPath ? { historyPath: ws.historyPath } : {}),
				};
				this.logger.event("resume_workspace_recreated", {
					issueId: fullIssue.id,
					issueIdentifier: fullIssue.identifier,
					sessionId,
					path: fresh.path,
					repositories: recreateRepos.map((r) => r.id).join(","),
				});
				await this.savePersistedState();
			} catch (error) {
				if (error instanceof WorktreeCreationRefusedError) {
					await terminalResume(
						CLIENT_MESSAGES.worktreeRefusedOnResume(error.repositoryName),
						error.repositoryName,
					);
					return;
				}
				throw error;
			}
		}

		// Fetch issue labels early to determine runner type
		const labels = await this.fetchIssueLabels(fullIssue);

		// Determine which runner to use based on existing session IDs
		const hasClaudeSession = !isNewSession && Boolean(session.claudeSessionId);
		const hasGeminiSession = !isNewSession && Boolean(session.geminiSessionId);
		const hasCodexSession = !isNewSession && Boolean(session.codexSessionId);
		const hasCursorSession = !isNewSession && Boolean(session.cursorSessionId);
		const needsNewSession =
			isNewSession ||
			(!hasClaudeSession &&
				!hasGeminiSession &&
				!hasCodexSession &&
				!hasCursorSession);

		// Fetch system prompt based on labels

		const systemPromptResult = await this.determineSystemPromptFromLabels(
			labels,
			repository,
		);
		// PON-150: re-arm the gate on resume. A resumed runner does not
		// inherit the previous invocation's appended system prompt, so a
		// restart mid-gate would otherwise remove the gate exactly when the
		// client's answer arrives.
		// PON-211: an operator session gets the OPERATOR rules INSTEAD of the
		// client-facing ones, not in addition.
		//
		// Appending both was a straight contradiction: the client-surface
		// block bans internal vocabulary, bans "narration diaries" and
		// mandates deliverable framing, while the operator block asks for
		// exactly the opposite — name files, show diffs, the client register
		// does not apply here. The model was being told both at once, on the
		// one thread where the reviewer wants it to talk like an engineer.
		// The needs-info block is wrong here too: it points questions at the
		// client, and on this thread they belong to the reviewer.
		const systemPrompt =
			(this.appendScopeGateIfPending(
				systemPromptResult?.prompt,
				resolvedWorkspaceId,
				fullIssue.id,
				sessionId,
			) ?? "") + this.sessionRuleBlocks(sessionId);
		const promptType = systemPromptResult?.type;

		// Build allowed and disallowed tools lists
		const allowedTools = this.buildAllowedTools(repository, promptType);
		const disallowedTools = [
			...this.buildDisallowedTools(repository, promptType),
			// PON-208 R9: an operator session shares a branch with a human who
			// may have committed to it from their own machine. Their work is
			// not recoverable from here, so the destructive forms are denied.
			...(this.operatorSessions.isOperatorSession(sessionId)
				? OPERATOR_GIT_DENY
				: []),
		];
		// v3.1 (Harold's capability-by-state): the deny above is a static
		// list; WHO may mutate the work is enforced dynamically in the
		// capability gate (createCapabilityGuard), so it holds in every state,
		// not just the ones a label happened to name.

		// Set up attachments directory
		const workspaceFolderName = basename(session.workspace.path);
		const attachmentsDir = getAttachmentsDir(
			this.cyrusHome,
			workspaceFolderName,
			resolvedWorkspaceId,
		);
		await mkdir(attachmentsDir, { recursive: true });

		const allowedDirectories = [
			...new Set([
				attachmentsDir,
				repository.repositoryPath,
				...additionalAllowedDirectories,
				...this.gitService.getGitMetadataDirectoriesForWorkspace(
					session.workspace,
				),
			]),
		];

		const resumeSessionId = needsNewSession
			? undefined
			: session.claudeSessionId
				? session.claudeSessionId
				: session.geminiSessionId
					? session.geminiSessionId
					: session.codexSessionId
						? session.codexSessionId
						: session.cursorSessionId;

		console.log(
			`[resumeAgentSession] needsNewSession=${needsNewSession}, resumeSessionId=${resumeSessionId ?? "none"}`,
		);

		// Create runner configuration
		// buildAgentRunnerConfig determines runner type from labels for new sessions
		// For existing sessions, we still need labels for model override but ignore runner type
		const { config: runnerConfig, runnerType } =
			await this.buildAgentRunnerConfig(
				session,
				repository,
				sessionId,
				systemPrompt,
				allowedTools,
				allowedDirectories,
				disallowedTools,
				resumeSessionId,
				labels, // Always pass labels to preserve model override
				fullIssue.description || undefined, // Description tags can override label selectors
				maxTurns, // Pass maxTurns if specified
				resolvedWorkspaceId,
				this.buildSkillSessionContext(repository, fullIssue, session),
			);

		// Create the appropriate runner based on session state
		const runner = this.createRunnerForType(runnerType, runnerConfig);

		// Store runner
		agentSessionManager.addAgentRunner(sessionId, runner);

		// Save state
		await this.savePersistedState();

		// Prepare the full prompt
		const fullPrompt = await this.buildSessionPrompt(
			isNewSession,
			session,
			fullIssue,
			repository,
			promptBody,
			attachmentManifest,
			commentAuthor,
			commentTimestamp,
		);

		// Start session - use streaming mode if supported for ability to add messages later
		try {
			// A restored lane holder resuming counts as alive — cancel any
			// pending boot-grace release before the (long) streaming await.
			this.clearLaneGraceForSession(sessionId);
			if (runner.supportsStreamingInput && runner.startStreaming) {
				await runner.startStreaming(fullPrompt);
			} else {
				await runner.start(fullPrompt);
			}
		} catch (error) {
			log.error(`Failed to start streaming session for ${sessionId}:`, error);
			throw error;
		}
	}

	/**
	 * Post instant acknowledgment thought when receiving prompted webhook
	 */
	private async postInstantPromptedAcknowledgment(
		sessionId: string,
		linearWorkspaceId: string,
		isStreaming: boolean,
	): Promise<void> {
		return this.activityPoster.postInstantPromptedAcknowledgment(
			sessionId,
			linearWorkspaceId,
			isStreaming,
		);
	}

	/**
	 * Get the platform type for a workspace's issue tracker.
	 */
	private getRepositoryPlatform(linearWorkspaceId: string): string | undefined {
		try {
			return this.issueTrackers.get(linearWorkspaceId)?.getPlatformType();
		} catch {
			return undefined;
		}
	}

	/**
	 * Fetch complete issue details from Linear API
	 */
	public async fetchFullIssueDetails(
		issueId: string,
		linearWorkspaceId: string,
	): Promise<Issue | null> {
		const issueTracker = this.issueTrackers.get(linearWorkspaceId);
		if (!issueTracker) {
			this.logger.warn(
				`No issue tracker found for workspace ${linearWorkspaceId}`,
			);
			return null;
		}

		try {
			this.logger.debug(`Fetching full issue details for ${issueId}`);
			const fullIssue = await issueTracker.fetchIssue(issueId);
			this.logger.debug(`Successfully fetched issue details for ${issueId}`);

			// Check if issue has a parent
			try {
				const parent = await fullIssue.parent;
				if (parent) {
					this.logger.debug(
						`Issue ${issueId} has parent: ${parent.identifier}`,
					);
				}
			} catch (_error) {
				// Parent field might not exist, ignore error
			}

			return fullIssue;
		} catch (error) {
			this.logger.error(`Failed to fetch issue details for ${issueId}:`, error);
			return null;
		}
	}

	// ========================================================================
	// OAuth Token Refresh
	// ========================================================================

	/**
	 * Build OAuth config for LinearIssueTrackerService.
	 * Uses workspace-level token storage.
	 * Returns undefined if OAuth credentials are not available.
	 */
	private buildOAuthConfig(
		linearWorkspaceId: string,
	): LinearOAuthConfig | undefined {
		const clientId = process.env.LINEAR_CLIENT_ID;
		const clientSecret = process.env.LINEAR_CLIENT_SECRET;

		if (!clientId || !clientSecret) {
			this.logger.warn(
				"LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET not set, token refresh disabled",
			);
			return undefined;
		}

		const workspaceConfig = this.config.linearWorkspaces?.[linearWorkspaceId];
		if (!workspaceConfig?.linearRefreshToken) {
			this.logger.warn(
				`No refresh token for workspace ${linearWorkspaceId}, token refresh disabled`,
			);
			return undefined;
		}

		// Get workspace name from workspace-level config
		const workspaceName =
			this.config.linearWorkspaces?.[linearWorkspaceId]?.linearWorkspaceName ||
			linearWorkspaceId;

		return {
			clientId,
			clientSecret,
			refreshToken: workspaceConfig.linearRefreshToken,
			workspaceId: linearWorkspaceId,
			onTokenRefresh: async (tokens) => {
				// Update workspace config in memory
				if (this.config.linearWorkspaces?.[linearWorkspaceId]) {
					this.config.linearWorkspaces[linearWorkspaceId].linearToken =
						tokens.accessToken;
					this.config.linearWorkspaces[linearWorkspaceId].linearRefreshToken =
						tokens.refreshToken;
				}

				// Persist tokens to config.json
				await this.saveOAuthTokens({
					linearToken: tokens.accessToken,
					linearRefreshToken: tokens.refreshToken,
					linearWorkspaceId: linearWorkspaceId,
					linearWorkspaceName: workspaceName,
				});
			},
			// PON-115: a 401 that a refresh cannot fix means this workspace's
			// access is gone. Uninstalling produces no webhook — Linear stops
			// delivering to an app it has cut off — so this is the only signal
			// that a tenant has left.
			onAccessLost: (workspaceId, error) => {
				void this.handleTenantAccessLost(workspaceId, error);
			},
		};
	}

	/**
	 * Save OAuth tokens to config.json (workspace-level storage)
	 */
	/**
	 * Populate `appUserId` and `installedAt` for any configured workspace
	 * missing them (PON-115).
	 *
	 * Linear issues a distinct app-user id per installation, and its platform
	 * docs recommend storing it alongside the token so the agent can identify
	 * itself in each tenant. Installs authorized before this field existed have
	 * a token but no id, so it is fetched once via `viewer { id }` using that
	 * tenant's own tracker — never a shared client.
	 *
	 * `installedAt` cannot be recovered retroactively; for pre-existing
	 * installs it records when we first observed the install, which is stated
	 * as such rather than presented as the true install date.
	 */
	private async backfillWorkspaceInstallRecords(): Promise<void> {
		const workspaces = this.config.linearWorkspaces ?? {};
		const updates: Array<{
			workspaceId: string;
			appUserId?: string;
			installedAt?: string;
		}> = [];

		for (const [workspaceId, wsConfig] of Object.entries(workspaces)) {
			// A deactivated tenant's token is dead; probing it on every boot
			// would just 401 and re-trigger deactivation (PON-115).
			if (wsConfig.active === false) continue;
			const needsAppUserId = !wsConfig.appUserId;
			const needsInstalledAt = !wsConfig.installedAt;
			if (!needsAppUserId && !needsInstalledAt) continue;

			let appUserId: string | undefined;
			if (needsAppUserId) {
				const issueTracker = this.issueTrackers.get(workspaceId);
				if (!issueTracker) continue;
				try {
					const viewer = await issueTracker.fetchCurrentUser();
					appUserId = viewer?.id;
				} catch (error) {
					// A revoked or expired install fails here; leave it for the
					// next boot rather than blocking the others.
					this.logger.warn(
						`Could not resolve app user id for workspace ${workspaceId}:`,
						error,
					);
				}
			}

			if (appUserId || needsInstalledAt) {
				updates.push({
					workspaceId,
					...(appUserId ? { appUserId } : {}),
					...(needsInstalledAt
						? { installedAt: new Date().toISOString() }
						: {}),
				});
			}
		}

		if (updates.length === 0) return;

		for (const update of updates) {
			const existing = this.config.linearWorkspaces?.[update.workspaceId];
			if (!existing) continue;
			if (update.appUserId) existing.appUserId = update.appUserId;
			if (update.installedAt) existing.installedAt = update.installedAt;
			this.logger.event("workspace_install_record_backfilled", {
				workspaceId: update.workspaceId,
				appUserId: update.appUserId ? "resolved" : "unchanged",
				installedAt: update.installedAt ? "first_seen" : "unchanged",
			});
		}

		await this.persistWorkspaceConfig();
	}

	/**
	 * Write the in-memory `linearWorkspaces` map back to config.json,
	 * preserving every other key in the file.
	 */
	private async persistWorkspaceConfig(): Promise<void> {
		if (!this.configPath) return;
		try {
			const configContent = await readFile(this.configPath, "utf-8");
			const config = JSON.parse(configContent);
			config.linearWorkspaces = config.linearWorkspaces ?? {};
			for (const [workspaceId, wsConfig] of Object.entries(
				this.config.linearWorkspaces ?? {},
			)) {
				config.linearWorkspaces[workspaceId] = {
					...(config.linearWorkspaces[workspaceId] ?? {}),
					...wsConfig,
				};
			}
			await writeFile(this.configPath, JSON.stringify(config, null, "\t"), {
				mode: 0o600,
			});
			await chmod(this.configPath, 0o600);
		} catch (error) {
			this.logger.error("Failed to persist workspace config:", error);
		}
	}

	private async saveOAuthTokens(tokens: {
		linearToken: string;
		linearRefreshToken?: string;
		linearWorkspaceId: string;
		linearWorkspaceName?: string;
	}): Promise<void> {
		if (!this.configPath) {
			this.logger.warn("No config path set, cannot save OAuth tokens");
			return;
		}

		try {
			const configContent = await readFile(this.configPath, "utf-8");
			const config = JSON.parse(configContent);

			// Ensure linearWorkspaces exists
			if (!config.linearWorkspaces) {
				config.linearWorkspaces = {};
			}

			// Update workspace-level token storage.
			//
			// Merge onto the existing entry rather than rebuilding it: this
			// object carries per-workspace settings beyond credentials
			// (laneSerialization, linearWorkspaceSlug, and anything added
			// later). Rebuilding dropped every field not explicitly copied, so
			// a routine token refresh silently turned a tenant's serialized
			// lane back off (PON-112 regression).
			const existingWorkspace =
				config.linearWorkspaces[tokens.linearWorkspaceId] ?? {};
			config.linearWorkspaces[tokens.linearWorkspaceId] = {
				...existingWorkspace,
				linearToken: tokens.linearToken,
				...(tokens.linearRefreshToken
					? { linearRefreshToken: tokens.linearRefreshToken }
					: {}),
				...(tokens.linearWorkspaceName
					? { linearWorkspaceName: tokens.linearWorkspaceName }
					: {}),
			};

			await writeFile(this.configPath, JSON.stringify(config, null, "\t"), {
				mode: 0o600,
			});
			// writeFile's mode only applies when creating the file, so tighten
			// existing configs explicitly — this file holds tenant OAuth tokens.
			await chmod(this.configPath, 0o600);
			this.logger.debug(
				`OAuth tokens saved to config for workspace ${tokens.linearWorkspaceId}`,
			);
		} catch (error) {
			this.logger.error("Failed to save OAuth tokens:", error);
		}
	}
}
