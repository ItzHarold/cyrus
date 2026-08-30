import { EventEmitter } from "node:events";
import type {
	APIAssistantMessage,
	APIUserMessage,
	SDKAssistantMessage,
	SDKMessage,
	SDKRateLimitEvent,
	SDKResultMessage,
	SDKStatusMessage,
	SDKSystemMessage,
	SDKUserMessage,
} from "cyrus-claude-runner";
import {
	type AgentPendingWork,
	AgentSessionStatus,
	AgentSessionType,
	type AgentSessionUpdateFields,
	type CyrusAgentSession,
	type CyrusAgentSessionEntry,
	createLogger,
	getPinnedModel,
	type IAgentRunner,
	type ILogger,
	type IssueMinimal,
	modelSatisfiesPin,
	type RepositoryContext,
	type SerializedCyrusAgentSession,
	type SerializedCyrusAgentSessionEntry,
	type Workspace,
} from "cyrus-core";
import {
	findClientContentViolations,
	redactClientContent,
	sanitizeClientPaths,
} from "./client-content-policy.js";
import { CLIENT_MESSAGES } from "./client-messages.js";

/**
 * Models the SDK legitimately uses on its own behalf (PON-147) — session
 * titling and similar. Deliberately explicit and SHORT: verified against 12h
 * of live model_verified lines on both boxes (only haiku-4-5 ever appears
 * beside the pin) and 62 lines across 7 prior days. Exact-or-dated-suffix
 * matching, same rule as the pin itself. Anything not here and not the pin
 * fails the session regardless of token share.
 */
const KNOWN_INTERNAL_MODELS = ["claude-haiku-4-5"];

import {
	formatPendingWorkThought,
	formatScheduleWakeupResponse,
	tryParseScheduleWakeupInput,
} from "./PendingWorkFormatter.js";
import { SessionLinkTracker, SessionPlanTracker } from "./SessionSurface.js";
import type {
	ActivityPostOptions,
	ActivitySignal,
	IActivitySink,
} from "./sinks/index.js";

/**
 * Events emitted by AgentSessionManager
 */
// biome-ignore lint/complexity/noBannedTypes: Empty events type (events removed in CYPACK-996 skill refactor)
export type AgentSessionManagerEvents = {};

/**
 * Type-safe event emitter interface for AgentSessionManager
 */
export declare interface AgentSessionManager {
	on<K extends keyof AgentSessionManagerEvents>(
		event: K,
		listener: AgentSessionManagerEvents[K],
	): this;
	emit<K extends keyof AgentSessionManagerEvents>(
		event: K,
		...args: Parameters<AgentSessionManagerEvents[K]>
	): boolean;
}

/**
 * Manages Agent Sessions integration with Claude Code SDK
 * Transforms Claude streaming messages into Agent Session format
 * Handles session lifecycle: create → active → complete/error
 *
 * Single instance shared across all repositories. Activity sinks are
 * registered per-session so each session posts to the correct tracker.
 */
export class AgentSessionManager extends EventEmitter {
	private logger: ILogger;
	private activitySinks: Map<string, IActivitySink> = new Map(); // Per-session activity sinks
	private sessions: Map<string, CyrusAgentSession> = new Map();
	private entries: Map<string, CyrusAgentSessionEntry[]> = new Map(); // Stores a list of session entries per each session by its id
	private activeTasksBySession: Map<string, string> = new Map(); // Maps session ID to active Task tool use ID
	private toolCallsByToolUseId: Map<string, { name: string; input: any }> =
		new Map(); // Track tool calls by their tool_use_id
	private lastAssistantBodyBySession: Map<string, string> = new Map(); // Buffer: last assistant text per session for posting as response on result
	private lastAssistantBodyIsToolInputBySession: Map<string, boolean> =
		new Map(); // Whether the buffered body above is a tool_use input JSON (no trailing assistant text) — guards against posting raw JSON as the "response" (CYPACK-1177)
	private bufferedAssistantEntryBySession: Map<string, CyrusAgentSessionEntry> =
		new Map(); // One-behind buffer: holds last assistant entry until next message or result
	private taskSubjectsByToolUseId: Map<string, string> = new Map(); // Cache TaskCreate subjects by toolUseId until result arrives with task ID
	private taskSubjectsById: Map<string, string> = new Map(); // Cache task subjects by task ID (e.g., "1" → "Fix login bug")
	// PON-116 session surface. Plans and links are tracked independently on
	// purpose: measured demand says the links matter more (three of ten real
	// client issues had the client asking for a preview or merge button;
	// nobody asked for a plan), so a plan that cannot be published must never
	// take the links down with it.
	private readonly updateSessionSurface?: (
		sessionId: string,
		fields: AgentSessionUpdateFields,
	) => Promise<boolean>;
	private planTrackers: Map<string, SessionPlanTracker> = new Map();
	private linkTrackers: Map<string, SessionLinkTracker> = new Map();
	/**
	 * Links discovered while the work is held for review (PON-221).
	 *
	 * They are not dropped, only deferred: `releaseHeldLinks` attaches them
	 * when the operator approves and the summary reaches the client. A link
	 * the client never gets is as wrong as one they get too early.
	 */
	private heldLinks: Map<string, Array<{ url: string; label: string }>> =
		new Map();
	private activeStatusActivitiesBySession: Map<string, string> = new Map(); // Maps session ID to active compacting status activity ID
	private stopRequestedSessions: Set<string> = new Set(); // Sessions explicitly stopped by user signal
	// Per-session serialization queue for handleClaudeMessage. The EdgeWorker's
	// onMessage callback is fire-and-forget, so without serialization the async
	// handlers can interleave — causing tool_result to be processed before its
	// matching tool_use registers in toolCallsByToolUseId (seen with parallel
	// deferred tools like ToolSearch, where a tool_use and its tool_result can
	// arrive back-to-back in the same microtask batch).
	private messageProcessingQueues: Map<string, Promise<void>> = new Map();
	private getParentSessionId?: (childSessionId: string) => string | undefined;
	private resumeParentSession?: (
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	) => Promise<void>;
	private onSessionEnded?: (sessionId: string) => void;
	/**
	 * Resolves the owning tenant for a session so every log line can carry it
	 * (PON-115). Supplied by EdgeWorker, which holds the session→repository→
	 * workspace mapping; kept as a lookup rather than a field on the session so
	 * that sessions restored from older persisted state are tagged too.
	 */
	private getWorkspaceIdForSession?: (sessionId: string) => string | undefined;

	/**
	 * PON-179: true when the session's workspace runs the client-flow gates
	 * — its activity stream is a CLIENT surface, so working narration
	 * (thought/action activities, tool-call renderings) must not post.
	 * Supplied by EdgeWorker; absent = never quiet (non-gated unchanged).
	 */
	private isClientQuietSession?: (sessionId: string) => boolean;

	/** Sessions whose quiet stream already carries the generic status. */
	private quietStatusPosted = new Set<string>();

	constructor(
		getParentSessionId?: (childSessionId: string) => string | undefined,
		resumeParentSession?: (
			parentSessionId: string,
			prompt: string,
			childSessionId: string,
		) => Promise<void>,
		logger?: ILogger,
		onSessionEnded?: (sessionId: string) => void,
		getWorkspaceIdForSession?: (sessionId: string) => string | undefined,
		updateSessionSurface?: (
			sessionId: string,
			fields: AgentSessionUpdateFields,
		) => Promise<boolean>,
		isClientQuietSession?: (sessionId: string) => boolean,
	) {
		super();
		this.updateSessionSurface = updateSessionSurface;
		this.logger = logger ?? createLogger({ component: "AgentSessionManager" });
		this.getParentSessionId = getParentSessionId;
		this.resumeParentSession = resumeParentSession;
		this.onSessionEnded = onSessionEnded;
		this.getWorkspaceIdForSession = getWorkspaceIdForSession;
		this.isClientQuietSession = isClientQuietSession;
	}

	/**
	 * Register an activity sink for a specific session.
	 * This associates the session with the correct issue tracker for activity posting.
	 */
	/**
	 * Where a client-quiet session's narration goes instead of nowhere
	 * (PON-212).
	 *
	 * PON-179 stopped narration reaching a client's thread, which was right,
	 * and then dropped it on the floor, which was not: the operator lost it
	 * too. A 389-message session left four activities on the client thread and
	 * nothing anywhere else, so "what did it actually do" had no answer for
	 * anyone — not a permission problem, a deletion.
	 *
	 * Quiet should mean quiet on the CLIENT's surface and loud on the
	 * operator's. This is the same subject/surface split as PON-208, one layer
	 * earlier.
	 */
	private shadowSinks = new Map<
		string,
		{ sink: IActivitySink; targetSessionId: string }
	>();

	setShadowSink(
		sessionId: string,
		shadow: { sink: IActivitySink; targetSessionId: string } | undefined,
	): void {
		if (shadow) this.shadowSinks.set(sessionId, shadow);
		else this.shadowSinks.delete(sessionId);
	}

	/**
	 * Post an activity that the client must not see onto the operator's
	 * surface. Never throws and never blocks the client path: losing a line of
	 * narration is a cost, breaking the session is a fault.
	 */
	private postToShadow(
		sessionId: string,
		content: Record<string, unknown>,
	): void {
		const shadow = this.shadowSinks.get(sessionId);
		if (!shadow) return;
		void Promise.resolve()
			.then(() =>
				shadow.sink.postActivity(shadow.targetSessionId, content as never),
			)
			.catch((error) => {
				this.logger.debug(`Shadow post failed: ${String(error)}`);
			});
	}

	setActivitySink(sessionId: string, sink: IActivitySink): void {
		this.activitySinks.set(sessionId, sink);
		if (!this.planTrackers.has(sessionId)) {
			this.planTrackers.set(sessionId, new SessionPlanTracker());
			// The identifier is what attributes a preview URL to this session.
			// Without it the link tracker emits no preview at all, which is the
			// intended conservative behaviour rather than a degradation.
			this.linkTrackers.set(
				sessionId,
				new SessionLinkTracker(
					this.sessions.get(sessionId)?.issueContext?.issueIdentifier,
				),
			);
		}
	}

	/**
	 * Publish the session plan, if there is an honest one to publish.
	 *
	 * Silent by design when there is nothing to show: `snapshot()` returns null
	 * rather than an empty list, so a session with no task list simply has no
	 * checklist. A missing checklist reads as "this agent doesn't show plans";
	 * an empty or half-filled one reads as broken.
	 *
	 * A failed publish disables the plan for this session — never the links.
	 */
	private async publishPlan(sessionId: string): Promise<void> {
		if (!this.updateSessionSurface) return;
		const tracker = this.planTrackers.get(sessionId);
		const plan = tracker?.snapshot();
		if (!tracker || !plan) return;

		try {
			const ok = await this.updateSessionSurface(sessionId, { plan });
			if (!ok) tracker.disable();
		} catch {
			tracker.disable();
		}
	}

	/**
	 * Surface any PR or preview link this text reveals.
	 *
	 * Independent of the plan on purpose: measured demand says the links matter
	 * more than the checklist, so a plan failure must never suppress them.
	 */
	private async publishLinks(
		sessionId: string,
		text: string | undefined,
	): Promise<void> {
		if (!this.updateSessionSurface || !text) return;
		const tracker = this.linkTrackers.get(sessionId);
		const found = tracker?.scan(text);
		if (!found?.length) return;

		// Held work: keep them until the operator releases the delivery.
		if (this.holdLinkPublication?.(sessionId)) {
			const held = this.heldLinks.get(sessionId) ?? [];
			for (const link of found)
				if (!held.some((h) => h.url === link.url)) held.push(link);
			this.heldLinks.set(sessionId, held);
			this.sessionLog(sessionId).info(
				`[event:client_links_held] ${JSON.stringify({
					sessionId,
					labels: found.map((l) => l.label),
					heldTotal: held.length,
				})}`,
			);
			return;
		}

		try {
			await this.updateSessionSurface(sessionId, { addedExternalUrls: found });
		} catch {
			// Cosmetic. A link that fails to attach must not disturb the session.
		}
	}

	/**
	 * Attach the links held during review (PON-221).
	 *
	 * Called once the client has the summary, so the buttons appear with the
	 * delivery rather than before it. Best-effort by the same reasoning as
	 * `publishLinks`: the delivery is the deliverable, and a button that
	 * fails to attach must never fail the release that already happened.
	 */
	async releaseHeldLinks(sessionId: string): Promise<void> {
		const held = this.heldLinks.get(sessionId);
		this.heldLinks.delete(sessionId);
		if (!this.updateSessionSurface || !held?.length) return;

		try {
			await this.updateSessionSurface(sessionId, { addedExternalUrls: held });
			this.sessionLog(sessionId).info(
				`[event:client_links_released] ${JSON.stringify({
					sessionId,
					labels: held.map((l) => l.label),
				})}`,
			);
		} catch {
			// See above: the client already has the work.
		}
	}

	/**
	 * Get the activity sink for a session.
	 */
	private getActivitySink(sessionId: string): IActivitySink | undefined {
		return this.activitySinks.get(sessionId);
	}

	/**
	 * Get a session-scoped logger with context (sessionId, platform, issueIdentifier).
	 */
	private sessionLog(sessionId: string): ILogger {
		const session = this.sessions.get(sessionId);
		return this.logger.withContext({
			sessionId,
			platform: session?.issueContext?.trackerId,
			issueIdentifier: session?.issueContext?.issueIdentifier,
			workspaceId: this.getWorkspaceIdForSession?.(sessionId),
		});
	}

	/**
	 * Initialize an agent session from webhook
	 * The session is already created by the platform, we just need to track it
	 *
	 * @param sessionId - Internal session ID
	 * @param issueId - Issue/PR identifier
	 * @param issueMinimal - Minimal issue data
	 * @param workspace - Workspace configuration
	 * @param platform - Source platform ("linear", "github", "gitlab", "slack"). Defaults to "linear".
	 *                   Only "linear" sessions will have activities streamed to Linear.
	 * @param repositories - Repository contexts for the session (defaults to empty array)
	 */
	createCyrusAgentSession(
		sessionId: string,
		issueId: string,
		issueMinimal: IssueMinimal,
		workspace: Workspace,
		platform: "linear" | "github" | "gitlab" | "slack" = "linear",
		repositories: RepositoryContext[] = [],
	): CyrusAgentSession {
		const log = this.logger.withContext({
			sessionId,
			platform,
			issueIdentifier: issueMinimal.identifier,
		});
		log.info(`Tracking session for issue ${issueId}`);

		const agentSession: CyrusAgentSession = {
			id: sessionId,
			// Only Linear sessions have a valid external session ID for posting activities
			externalSessionId: platform === "linear" ? sessionId : undefined,
			type: AgentSessionType.CommentThread,
			status: AgentSessionStatus.Active,
			context: AgentSessionType.CommentThread,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			issueContext: {
				trackerId: platform,
				issueId: issueId,
				issueIdentifier: issueMinimal.identifier,
			},
			issueId, // Kept for backwards compatibility
			issue: issueMinimal,
			repositories,
			workspace: workspace,
		};

		// Store locally
		this.sessions.set(sessionId, agentSession);
		this.entries.set(sessionId, []);

		return agentSession;
	}

	/**
	 * Continue an existing conversation under a NEW agent session (PON-208).
	 *
	 * A new Linear agent session normally means a new model conversation:
	 * `createCyrusAgentSession` mints a bare record, resume keys on
	 * `claudeSessionId`, and nothing copies that value between sessions. That
	 * is right for a re-delegation — and wrong for the cockpit mirror, where
	 * the whole point is that Harold picks up the conversation the client's
	 * session left off, in the same worktree, on the same branch and PR.
	 *
	 * Copies the runner session ids AND the workspace: the workspace is what
	 * makes it the same checkout, and a resumed conversation pointed at a
	 * different directory is worse than a fresh one.
	 *
	 * Returns false when there is nothing to adopt — the caller must then
	 * start a fresh conversation rather than silently pretending continuity.
	 */
	adoptRunnerSession(fromSessionId: string, toSessionId: string): boolean {
		const from = this.sessions.get(fromSessionId);
		const to = this.sessions.get(toSessionId);
		if (!from || !to) return false;
		const hasConversation =
			from.claudeSessionId ??
			from.geminiSessionId ??
			from.codexSessionId ??
			from.cursorSessionId;
		if (!hasConversation || !from.workspace?.path) return false;

		to.claudeSessionId = from.claudeSessionId;
		to.geminiSessionId = from.geminiSessionId;
		to.codexSessionId = from.codexSessionId;
		to.cursorSessionId = from.cursorSessionId;
		to.workspace = from.workspace;
		to.repositories = from.repositories;
		to.updatedAt = Date.now();
		this.logger.info(
			`Adopted conversation from ${fromSessionId} into ${toSessionId} at ${from.workspace.path}`,
		);
		return true;
	}

	/**
	 * Mirror the runner session ids back onto another session record.
	 *
	 * The SDK can hand back a new session id on each turn, so after an
	 * operator turn the mirror record moves on and the client record does
	 * not. Left alone the two fork: the client's next resume — a needs-info
	 * answer, say — would continue a conversation that never saw the
	 * operator's work, and neither side would report an error.
	 */
	syncRunnerSessionTo(fromSessionId: string, toSessionId: string): void {
		const from = this.sessions.get(fromSessionId);
		const to = this.sessions.get(toSessionId);
		if (!from || !to) return;
		if (
			to.claudeSessionId === from.claudeSessionId &&
			to.geminiSessionId === from.geminiSessionId &&
			to.codexSessionId === from.codexSessionId &&
			to.cursorSessionId === from.cursorSessionId
		) {
			return;
		}
		to.claudeSessionId = from.claudeSessionId;
		to.geminiSessionId = from.geminiSessionId;
		to.codexSessionId = from.codexSessionId;
		to.cursorSessionId = from.cursorSessionId;
		to.updatedAt = Date.now();
		this.logger.debug(
			`Synced conversation id from ${fromSessionId} back to ${toSessionId}`,
		);
	}

	/**
	 * Create an agent session for chat-style platforms (Slack, etc.) that are
	 * not tied to a specific issue or repository.
	 *
	 * Unlike {@link createCyrusAgentSession}, this does NOT require issue
	 * context — the session lives in a standalone workspace with no issue
	 * tracker linkage.
	 *
	 * @param repositories - Repository contexts for the session (defaults to empty array for chatbot sessions)
	 */
	createChatSession(
		sessionId: string,
		workspace: Workspace,
		platform: string,
		repositories: RepositoryContext[] = [],
	): CyrusAgentSession {
		const log = this.logger.withContext({ sessionId, platform });
		log.info("Creating chat session");

		const agentSession: CyrusAgentSession = {
			id: sessionId,
			type: AgentSessionType.CommentThread,
			status: AgentSessionStatus.Active,
			context: AgentSessionType.CommentThread,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			repositories,
			workspace,
		};

		this.sessions.set(sessionId, agentSession);
		this.entries.set(sessionId, []);

		return agentSession;
	}

	/**
	 * Update Agent Session with session ID from system initialization
	 * Automatically detects whether it's Claude or Gemini based on the runner
	 */
	updateAgentSessionWithRunnerSessionId(
		sessionId: string,
		claudeSystemMessage: SDKSystemMessage,
	): void {
		const linearSession = this.sessions.get(sessionId);
		if (!linearSession) {
			const log = this.sessionLog(sessionId);
			log.warn(`No session found`);
			return;
		}

		// Determine which runner is being used
		const runner = linearSession.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		// Update the appropriate session ID based on runner type
		if (runnerType === "gemini") {
			linearSession.geminiSessionId = claudeSystemMessage.session_id;
		} else if (runnerType === "codex") {
			linearSession.codexSessionId = claudeSystemMessage.session_id;
		} else if (runnerType === "cursor") {
			linearSession.cursorSessionId = claudeSystemMessage.session_id;
		} else {
			linearSession.claudeSessionId = claudeSystemMessage.session_id;
		}

		linearSession.updatedAt = Date.now();
		linearSession.metadata = {
			...linearSession.metadata, // Preserve existing metadata
			model: claudeSystemMessage.model,
			tools: claudeSystemMessage.tools,
			permissionMode: claudeSystemMessage.permissionMode,
			apiKeySource: claudeSystemMessage.apiKeySource,
		};
	}

	/**
	 * Create a session entry from user/assistant message (without syncing to Linear)
	 */
	private async createSessionEntry(
		sessionId: string,
		sdkMessage: SDKUserMessage | SDKAssistantMessage,
	): Promise<CyrusAgentSessionEntry> {
		// Extract tool info if this is an assistant message
		const toolInfo =
			sdkMessage.type === "assistant" ? this.extractToolInfo(sdkMessage) : null;
		// Extract tool_use_id and error status if this is a user message with tool_result
		const toolResultInfo =
			sdkMessage.type === "user"
				? this.extractToolResultInfo(sdkMessage)
				: null;
		// Extract SDK error from assistant messages (e.g., rate_limit, billing_error)
		// SDKAssistantMessage has optional `error?: SDKAssistantMessageError` field
		// See: @anthropic-ai/claude-agent-sdk sdk.d.ts lines 1013-1022
		// Evidence from ~/.cyrus/logs/CYGROW-348 session jsonl shows assistant messages with
		// "error":"rate_limit" field when usage limits are hit
		const sdkError =
			sdkMessage.type === "assistant" ? sdkMessage.error : undefined;

		// Determine which runner is being used
		const session = this.sessions.get(sessionId);
		const runner = session?.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		const sessionEntry: CyrusAgentSessionEntry = {
			// Set the appropriate session ID based on runner type
			...(runnerType === "gemini"
				? { geminiSessionId: sdkMessage.session_id }
				: runnerType === "codex"
					? { codexSessionId: sdkMessage.session_id }
					: runnerType === "cursor"
						? { cursorSessionId: sdkMessage.session_id }
						: { claudeSessionId: sdkMessage.session_id }),
			type: sdkMessage.type,
			content: this.extractContent(sdkMessage),
			metadata: {
				timestamp: Date.now(),
				parentToolUseId: sdkMessage.parent_tool_use_id || undefined,
				...(toolInfo && {
					toolUseId: toolInfo.id,
					toolName: toolInfo.name,
					toolInput: toolInfo.input,
				}),
				...(toolResultInfo && {
					toolUseId: toolResultInfo.toolUseId,
					toolResultError: toolResultInfo.isError,
				}),
				...(sdkError && { sdkError }),
			},
		};

		// DON'T store locally yet - wait until we actually post to Linear
		return sessionEntry;
	}

	/**
	 * Complete a session from Claude result message.
	 * Posts the final result to the issue tracker and handles child session completion.
	 */
	/**
	 * PON-168 / R2: run client-visible model output through the content
	 * policy. Violations are journaled; the unambiguous ones are redacted —
	 * loudly, never silently. Returns the text to post.
	 */
	private applyClientContentPolicy(
		sessionId: string,
		surface: string,
		text: string,
	): string {
		const violations = findClientContentViolations(text);
		if (violations.length === 0) return text;
		// PON-179: paths under the session's own workspace redact to
		// REPO-RELATIVE form — the client reads `SUPPORT.md`, not a box path.
		const workspacePath = this.sessions.get(sessionId)?.workspace?.path;
		const { text: redacted, redactions } = redactClientContent(text, {
			stripPrefixes: workspacePath ? [workspacePath] : [],
		});
		this.sessionLog(sessionId).warn(
			`[event:client_content_policy_violation] surface=${surface} rules=${[...new Set(violations.map((v) => v.rule))].join(",")} redacted=${redactions.length} logged=${violations.length - redactions.length}`,
		);
		return redacted;
	}

	/**
	 * PON-179/182: policy-sanitize text bound for a client surface OUTSIDE
	 * this manager's own posting funnel (the elicitation body). Quiet
	 * sessions get the full policy; every other session still gets the
	 * unconditional path floor — no absolute box path on any client surface.
	 */
	sanitizeClientSurfaceText(
		sessionId: string,
		surface: string,
		text: string,
	): string {
		if (this.isClientQuietSession?.(sessionId)) {
			return this.applyClientContentPolicy(sessionId, surface, text);
		}
		const workspacePath = this.sessions.get(sessionId)?.workspace?.path;
		return sanitizeClientPaths(text, {
			stripPrefixes: workspacePath ? [workspacePath] : [],
		}).text;
	}

	/**
	 * PON-182: the unconditional path floor for activity payloads. Internal
	 * absolute paths have no legitimate use on ANY client-visible surface —
	 * quiet or not — so every string field that can carry one is rewritten
	 * repo-relative (or …/basename off-workspace). Debug-logged, not
	 * journaled per hit: paths in narration are routine on non-quiet
	 * workspaces and per-hit WARNs would be noise.
	 */
	private sanitizePathsInContent<T extends Record<string, unknown>>(
		sessionId: string,
		content: T,
	): T {
		const workspacePath = this.sessions.get(sessionId)?.workspace?.path;
		const options = {
			stripPrefixes: workspacePath ? [workspacePath] : [],
		};
		let changed = false;
		const out: Record<string, unknown> = { ...content };
		for (const key of ["body", "action", "parameter", "result"]) {
			const value = out[key];
			if (typeof value === "string") {
				const { text, redactions } = sanitizeClientPaths(value, options);
				if (redactions.length > 0) {
					out[key] = text;
					changed = true;
				}
			}
		}
		if (changed) {
			this.sessionLog(sessionId).debug(
				"[event:client_path_sanitized] internal path(s) rewritten repo-relative in outbound activity",
			);
		}
		return changed ? (out as T) : content;
	}

	/**
	 * PON-152: when set, the final completion response runs through this
	 * before posting; returning true suppresses the client-facing post (the
	 * interceptor has stored it for delivery on approval).
	 */
	private finalResponseInterceptor?: (
		sessionId: string,
		content: string,
		isError: boolean,
	) => boolean;

	setFinalResponseInterceptor(
		interceptor: (
			sessionId: string,
			content: string,
			isError: boolean,
		) => boolean,
	): void {
		this.finalResponseInterceptor = interceptor;
	}

	/**
	 * PON-221: true while this session's delivery is held for review.
	 *
	 * External URLs are a SESSION SURFACE write, not an activity, so they
	 * reach the client through neither the client-quiet funnel nor the
	 * final-response hold — both of which only ever see activities. That is
	 * how a client watched a draft pull request button appear on their thread
	 * while Harold was still reviewing the work. This is the fourth path to a
	 * client surface, and the first that is not a post.
	 *
	 * Deliberately NOT keyed on client-quiet: PON-182 decoupled narration
	 * suppression from the gates, so a workspace can be quiet without ever
	 * having a release event — and holding links there would strand them
	 * forever. "Held" must mean "there is an approval coming".
	 */
	private holdLinkPublication?: (sessionId: string) => boolean;

	setLinkPublicationHold(hold: (sessionId: string) => boolean): void {
		this.holdLinkPublication = hold;
	}

	async completeSession(
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			const log = this.sessionLog(sessionId);
			log.error(`No session found`);
			return;
		}

		const log = this.sessionLog(sessionId);

		// Clear any active Task when session completes
		this.activeTasksBySession.delete(sessionId);

		const wasStopRequested = this.consumeStopRequest(sessionId);
		const status = wasStopRequested
			? AgentSessionStatus.Error
			: resultMessage.subtype === "success"
				? AgentSessionStatus.Complete
				: AgentSessionStatus.Error;

		// Update session status and metadata
		await this.updateSessionStatus(sessionId, status, {
			totalCostUsd: resultMessage.total_cost_usd,
			usage: resultMessage.usage,
		});

		// Notify before the early returns below — every outcome (success,
		// error, user stop) must count as "session ended" so a workspace lane
		// holding this session releases (PON-112).
		//
		// PON-154: but a result message is NOT the same thing as the session
		// ending. When the Stop hook blocks a stop, the CLI emits a result and
		// then CONTINUES in the same stream — observed live: a lane released on
		// a mid-session result, and a second session was admitted concurrently
		// into a concurrency-1 lane while the first ran another 81 seconds. So
		// when the runner reports it is still running, the release is deferred
		// to the runner's own completion (the onComplete wiring in EdgeWorker),
		// which fires when the stream actually ends. The immediate release
		// stays as the fallback for runners that are already stopped by the
		// time their result is processed — release is idempotent, so the
		// belt-and-braces double fire is a no-op, but a missing fire wedges a
		// lane forever.
		const stillRunning =
			this.getSession(sessionId)?.agentRunner?.isRunning?.() === true;
		if (stillRunning) {
			log.info(
				`[event:lane_release_deferred] result received while the runner is still streaming (Stop-hook continuation); the lane releases on actual completion`,
			);
		} else {
			try {
				this.onSessionEnded?.(sessionId);
			} catch (error) {
				log.error(`onSessionEnded callback failed:`, error);
			}
		}

		if (wasStopRequested) {
			log.info(`Session was stopped by user`);
			return;
		}

		// Post final result to issue tracker
		await this.addResultEntry(sessionId, resultMessage);

		// When the turn ended with work still scheduled or in flight
		// (ScheduleWakeup/cron timers, backgrounded tasks), the runner holds
		// its session open and the wakeup will stream new messages in later.
		// Post a thought AFTER the response so Linear's agent panel returns
		// to its working state and the user can see what the session is
		// waiting on.
		if (resultMessage.subtype === "success") {
			const pendingWork = this.getRunnerPendingWork(sessionId);
			if (pendingWork) {
				const thoughtBody = formatPendingWorkThought(pendingWork);
				if (thoughtBody) {
					await this.createThoughtActivity(sessionId, thoughtBody);
					log.info(
						`Posted pending-work thought (${pendingWork.sessionCrons.length} crons, ${pendingWork.backgroundTasks.length} background tasks)`,
					);
				}
			}
		}

		// Handle child session completion
		const parentSessionId = this.getParentSessionId?.(sessionId);
		if (parentSessionId && this.resumeParentSession) {
			await this.handleChildSessionCompletion(sessionId, resultMessage);
		}

		log.info(`Session completed (subtype: ${resultMessage.subtype})`);
	}

	/**
	 * Pending work (scheduled wakeups/crons, in-flight background tasks) for
	 * the session's runner, or null when the runner doesn't support pending
	 * work reporting or nothing is pending.
	 */
	private getRunnerPendingWork(sessionId: string): AgentPendingWork | null {
		const runner = this.sessions.get(sessionId)?.agentRunner;
		if (!runner?.getPendingWork) return null;
		const pendingWork = runner.getPendingWork();
		return pendingWork.sessionCrons.length > 0 ||
			pendingWork.backgroundTasks.length > 0
			? pendingWork
			: null;
	}

	private consumeStopRequest(linearAgentActivitySessionId: string): boolean {
		if (!this.stopRequestedSessions.has(linearAgentActivitySessionId)) {
			return false;
		}

		this.stopRequestedSessions.delete(linearAgentActivitySessionId);
		return true;
	}

	requestSessionStop(linearAgentActivitySessionId: string): void {
		this.stopRequestedSessions.add(linearAgentActivitySessionId);
	}

	/**
	 * Handle child session completion and resume parent
	 */
	private async handleChildSessionCompletion(
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		if (!this.getParentSessionId || !this.resumeParentSession) {
			return;
		}

		const parentAgentSessionId = this.getParentSessionId(sessionId);

		if (!parentAgentSessionId) {
			log.error(`No parent session ID found for child session`);
			return;
		}

		log.info(
			`Child session completed, resuming parent ${parentAgentSessionId}`,
		);

		try {
			const childResult =
				"result" in resultMessage
					? resultMessage.result
					: "No result available";
			const promptToParent = `Child agent session ${sessionId} completed with result:\n\n${childResult}`;

			await this.resumeParentSession(
				parentAgentSessionId,
				promptToParent,
				sessionId,
			);

			log.info(`Successfully resumed parent session ${parentAgentSessionId}`);
		} catch (error) {
			log.error(`Failed to resume parent session:`, error);
		}
	}

	/**
	 * Handle streaming Claude messages and route to appropriate methods.
	 *
	 * Serializes processing per session so concurrent onMessage callbacks from
	 * the runner (which is fire-and-forget) do not interleave their async work.
	 * Without this serialization, a tool_result message could run its handler
	 * ahead of the matching tool_use registration in toolCallsByToolUseId,
	 * producing a fallback action="Tool" activity in Linear (seen with parallel
	 * deferred tools like ToolSearch).
	 */
	async handleClaudeMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		const prev =
			this.messageProcessingQueues.get(sessionId) ?? Promise.resolve();
		const next = prev.then(() => this.processClaudeMessage(sessionId, message));
		// Swallow errors in the chained promise so one failure does not block
		// future messages for this session. The concrete handler already logs
		// errors internally.
		this.messageProcessingQueues.set(
			sessionId,
			next.catch(() => undefined),
		);
		return next;
	}

	/**
	 * Actual message dispatch. Invoked only via the per-session queue in
	 * handleClaudeMessage so at most one instance runs for a given session.
	 */
	private async processClaudeMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			switch (message.type) {
				case "system":
					if (message.subtype === "init") {
						this.updateAgentSessionWithRunnerSessionId(sessionId, message);

						// Post model notification + PON-110 pin assertion
						const systemMessage = message as SDKSystemMessage;
						if (systemMessage.model) {
							if (!modelSatisfiesPin(systemMessage.model)) {
								const pinned = getPinnedModel();
								log.error(
									`[event:model_drift] running=${systemMessage.model} pinned=${pinned} - failing session (PON-110)`,
								);
								await this.postModelNotificationThought(
									sessionId,
									`Model drift: session started on ${systemMessage.model} but the pinned model is ${pinned}. Failing this session (PON-110).`,
								);
								throw new Error(
									`PON-110 model drift: running=${systemMessage.model} pinned=${pinned}`,
								);
							}
							log.info(`[event:model_requested] model=${systemMessage.model}`);
							await this.postModelNotificationThought(
								sessionId,
								systemMessage.model,
							);
						}
					} else if (message.subtype === "status") {
						// Handle status updates (compacting, etc.)
						await this.handleStatusMessage(
							sessionId,
							message as SDKStatusMessage,
						);
					}
					break;

				case "user": {
					const userEntry = await this.createSessionEntry(
						sessionId,
						message as SDKUserMessage,
					);
					await this.syncEntryToActivitySink(userEntry, sessionId);
					break;
				}

				case "assistant": {
					const assistantEntry = await this.createSessionEntry(
						sessionId,
						message as SDKAssistantMessage,
					);
					// Buffer the text content so addResultEntry can post it as the response.
					// Track whether this body is a tool_use input (JSON) rather than real
					// assistant prose, so addResultEntry never posts raw tool JSON as the
					// final "response" when a turn ends on a tool call (CYPACK-1177).
					if (assistantEntry.content) {
						// PON-116: PR and preview URLs only ever appear in the
						// agent's own output, so this is where they surface.
						void this.publishLinks(sessionId, assistantEntry.content);
						this.lastAssistantBodyBySession.set(
							sessionId,
							assistantEntry.content,
						);
						this.lastAssistantBodyIsToolInputBySession.set(
							sessionId,
							!!assistantEntry.metadata?.toolUseId,
						);
					}
					if (assistantEntry.metadata?.toolUseId) {
						// Tool-use message: flush any buffered text first (preserves ordering),
						// then post immediately for real-time "in progress" display
						await this.flushBufferedAssistant(sessionId);
						await this.syncEntryToActivitySink(assistantEntry, sessionId);
					} else {
						// Text-only message: buffer it so the LAST one can be posted as "response"
						// Flush any previous buffered text first (posts as thought)
						await this.flushBufferedAssistant(sessionId);
						// Skip empty/whitespace-only text turns — otherwise they post as
						// blank thoughts in Linear, showing up as an extra blank line
						// between activities (e.g. between "Using model: ..." and the
						// first real assistant turn).
						if (assistantEntry.content?.trim()) {
							this.bufferedAssistantEntryBySession.set(
								sessionId,
								assistantEntry,
							);
						}
					}
					break;
				}

				case "result":
					{
						// PON-110: ground truth - assert billed models against the pin.
						const resultMsg = message as unknown as {
							modelUsage?: Record<
								string,
								{ inputTokens?: number; outputTokens?: number }
							>;
						};
						const usage = resultMsg.modelUsage ?? {};
						const usedModels = Object.keys(usage);
						if (usedModels.length > 0) {
							const weight = (m: string) =>
								(usage[m]?.inputTokens ?? 0) + (usage[m]?.outputTokens ?? 0);
							const dominant = usedModels.reduce((a, b) =>
								weight(a) >= weight(b) ? a : b,
							);
							if (!modelSatisfiesPin(dominant)) {
								const pinned = getPinnedModel();
								log.error(
									`[event:model_drift] billed=${dominant} pinned=${pinned} used=${usedModels.join(",")} (PON-110)`,
								);
								await this.postModelNotificationThought(
									sessionId,
									`Model drift: work was billed to ${dominant} but the pinned model is ${pinned}. Failing this session (PON-110).`,
								);
								throw new Error(
									`PON-110 model drift: billed=${dominant} pinned=${pinned}`,
								);
							}
							// PON-147: EVERY used model must be the pin or a known
							// SDK-internal — the plurality check above lets an
							// unpinned model do 49% of a session unexamined (one
							// three-model session slipped through in the wild).
							// Allowlist, not threshold: the question is which
							// models are legitimate at all, not how much.
							const totalTokens = usedModels.reduce(
								(sum, m) => sum + weight(m),
								0,
							);
							for (const used of usedModels) {
								if (modelSatisfiesPin(used)) continue;
								if (
									KNOWN_INTERNAL_MODELS.some(
										(internal) =>
											used === internal || used.startsWith(`${internal}-`),
									)
								) {
									continue;
								}
								const pinned = getPinnedModel();
								const share =
									totalTokens > 0
										? Math.round((weight(used) / totalTokens) * 100)
										: 0;
								log.error(
									`[event:model_drift] unexpected=${used} share=${share}% pinned=${pinned} used=${usedModels.join(",")} (PON-147)`,
								);
								await this.postModelNotificationThought(
									sessionId,
									`Model drift: ${used} carried ${share}% of this session's tokens but is neither the pinned model (${pinned}) nor a known internal helper. Failing this session (PON-147).`,
								);
								throw new Error(
									`PON-147 model drift: unexpected=${used} share=${share}% pinned=${pinned}`,
								);
							}
							log.info(
								`[event:model_verified] billed=${dominant} used=${usedModels.join(",")}`,
							);
						}
					}
					// Result arrived: discard buffered entry (addResultEntry uses lastAssistantBodyBySession
					// to post the content as a response activity)
					this.bufferedAssistantEntryBySession.delete(sessionId);
					await this.completeSession(sessionId, message as SDKResultMessage);
					break;

				case "rate_limit_event":
					this.handleRateLimitEvent(sessionId, message as SDKRateLimitEvent);
					break;

				default:
					log.warn(`Unknown message type: ${(message as any).type}`);
			}
		} catch (error) {
			log.error(`Error handling message:`, error);
			// Mark session as error state
			await this.updateSessionStatus(sessionId, AgentSessionStatus.Error);
		}
	}

	/**
	 * Flush the buffered assistant entry as thought/action (non-result flush).
	 * Called when a new message arrives before result, to post the previous
	 * assistant message as a thought/action activity.
	 */
	private async flushBufferedAssistant(sessionId: string): Promise<void> {
		const buffered = this.bufferedAssistantEntryBySession.get(sessionId);
		if (!buffered) return;
		this.bufferedAssistantEntryBySession.delete(sessionId);
		// Defensive guard: never post a blank thought — it would appear as an
		// empty line between real activities in Linear.
		if (!buffered.content?.trim()) return;
		await this.syncEntryToActivitySink(buffered, sessionId);
	}

	/**
	 * Handle rate limit events from Claude runners
	 */
	private handleRateLimitEvent(
		sessionId: string,
		message: SDKRateLimitEvent,
	): void {
		const log = this.sessionLog(sessionId);
		const info = message.rate_limit_info;

		if (info.status === "rejected") {
			const resetsAt = info.resetsAt
				? new Date(info.resetsAt * 1000).toISOString()
				: "unknown";
			log.warn(
				`Rate limited (${info.rateLimitType ?? "unknown"}), resets at ${resetsAt}`,
			);
		} else if (info.status === "allowed_warning") {
			log.info(
				`Rate limit warning: ${Math.round((info.utilization ?? 0) * 100)}% utilization (${info.rateLimitType ?? "unknown"})`,
			);
		}
		// "allowed" status is a no-op — fires frequently and provides no actionable information
	}

	/**
	 * Update session status and metadata
	 */
	private async updateSessionStatus(
		sessionId: string,
		status: AgentSessionStatus,
		additionalMetadata?: Partial<CyrusAgentSession["metadata"]>,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		session.status = status;
		session.updatedAt = Date.now();

		if (additionalMetadata) {
			session.metadata = { ...session.metadata, ...additionalMetadata };
		}

		this.sessions.set(sessionId, session);
	}

	/**
	 * Add result entry from result message
	 */
	private async addResultEntry(
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<void> {
		// Determine which runner is being used
		const session = this.sessions.get(sessionId);
		const runner = session?.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		// For error results, content may be in errors[] rather than result.
		const resultText =
			"result" in resultMessage && typeof resultMessage.result === "string"
				? resultMessage.result.trim()
				: "";

		// For success results, prefer the buffered last assistant message
		// (structured content) over result.result (a plain-text duplicate). But
		// when a turn ENDS on a tool call with no trailing assistant text, that
		// buffered body is the tool's raw input JSON — which must never be posted
		// as the Linear "response" (CYPACK-1177 / CYHOST-905: sessions showed a
		// "Finished" entry whose body was raw ScheduleWakeup / background-Bash
		// JSON).
		const bufferedAssistant = this.lastAssistantBodyBySession.get(sessionId);
		const bufferedIsToolInput =
			this.lastAssistantBodyIsToolInputBySession.get(sessionId) ?? false;
		this.lastAssistantBodyBySession.delete(sessionId);
		this.lastAssistantBodyIsToolInputBySession.delete(sessionId);

		let content: string;
		if (resultMessage.is_error) {
			content = (
				"errors" in resultMessage &&
				Array.isArray(resultMessage.errors) &&
				resultMessage.errors.length > 0
					? resultMessage.errors.join("\n")
					: resultText
			).trim();
		} else if (bufferedIsToolInput) {
			// Turn ended on a tool call. Render a friendly response for a
			// ScheduleWakeup (gated on the runner actually reporting a pending
			// cron so a finished session is never rewritten); otherwise fall back
			// to the SDK's result text and, failing that, post nothing — the raw
			// tool JSON is never surfaced. Any pending work is declared by the
			// separate "Standing by" thought, so an empty response here is fine.
			const pendingWork = this.getRunnerPendingWork(sessionId);
			const wakeupInput =
				pendingWork && pendingWork.sessionCrons.length > 0
					? tryParseScheduleWakeupInput(bufferedAssistant ?? "")
					: null;
			content = wakeupInput
				? formatScheduleWakeupResponse(wakeupInput)
				: resultText;
		} else {
			content = (bufferedAssistant ?? resultText).trim();
		}

		// Never post an empty/blank "response" activity — that renders as a
		// bare "Finished" with no body. Skip it entirely (the timeline already
		// shows the trailing action, and pending work has its own thought).
		if (!content.trim()) {
			return;
		}

		// Client content policy (PON-168): the completion summary is the
		// highest-volume model-authored client surface. Checked before the
		// verification interceptor so a held-then-delivered summary is
		// already clean.
		content = this.applyClientContentPolicy(
			sessionId,
			"final-response",
			content,
		);

		// Verify-before-client-sees (PON-152): a gated workspace's completion
		// summary is held for operator approval instead of posted. The
		// interceptor stores it; progress activity earlier in the session was
		// untouched — only the "this is done" moment is gated.
		if (
			this.finalResponseInterceptor?.(
				sessionId,
				content,
				resultMessage.is_error === true,
			) === true
		) {
			this.sessionLog(sessionId).info(
				`[event:client_summary_suppressed] completion response held for verification (PON-152)`,
			);
			return;
		}

		const resultEntry: CyrusAgentSessionEntry = {
			// Set the appropriate session ID based on runner type
			...(runnerType === "gemini"
				? { geminiSessionId: resultMessage.session_id }
				: runnerType === "codex"
					? { codexSessionId: resultMessage.session_id }
					: runnerType === "cursor"
						? { cursorSessionId: resultMessage.session_id }
						: { claudeSessionId: resultMessage.session_id }),
			type: "result",
			content,
			metadata: {
				timestamp: Date.now(),
				durationMs: resultMessage.duration_ms,
				isError: resultMessage.is_error,
			},
		};

		// DON'T store locally - syncEntryToActivitySink will do it
		// Sync to Linear
		await this.syncEntryToActivitySink(resultEntry, sessionId);
	}

	/**
	 * Extract content from Claude message
	 */
	private extractContent(
		sdkMessage: SDKUserMessage | SDKAssistantMessage,
	): string {
		const message =
			sdkMessage.type === "user"
				? (sdkMessage.message as APIUserMessage)
				: (sdkMessage.message as APIAssistantMessage);

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			return message.content
				.map((block) => {
					if (block.type === "text") {
						return block.text;
					} else if (block.type === "tool_use") {
						// For tool use blocks, return the input as JSON string
						return JSON.stringify(block.input, null, 2);
					} else if (block.type === "tool_result") {
						// For tool_result blocks, extract just the text content
						// Also store the error status in metadata if needed
						if ("is_error" in block && block.is_error) {
							// Mark this as an error result - we'll handle this elsewhere
						}
						if (typeof block.content === "string") {
							return block.content;
						}
						if (Array.isArray(block.content)) {
							return block.content
								.map((contentBlock: any) => {
									if (contentBlock.type === "text") {
										return contentBlock.text;
									}
									// ToolSearch emits tool_reference blocks; preserve the tool name
									// so the formatter can render "Loaded tools: `X`, `Y`".
									if (
										contentBlock.type === "tool_reference" &&
										contentBlock.tool_name
									) {
										return contentBlock.tool_name;
									}
									return "";
								})
								.filter(Boolean)
								.join("\n");
						}
						return "";
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}

		return "";
	}

	/**
	 * Extract tool information from Claude assistant message
	 */
	private extractToolInfo(
		sdkMessage: SDKAssistantMessage,
	): { id: string; name: string; input: any } | null {
		const message = sdkMessage.message as APIAssistantMessage;

		if (Array.isArray(message.content)) {
			const toolUse = message.content.find(
				(block) => block.type === "tool_use",
			);
			if (
				toolUse &&
				"id" in toolUse &&
				"name" in toolUse &&
				"input" in toolUse
			) {
				return {
					id: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
				};
			}
		}
		return null;
	}

	/**
	 * Extract tool_use_id and error status from Claude user message containing tool_result
	 */
	private extractToolResultInfo(
		sdkMessage: SDKUserMessage,
	): { toolUseId: string; isError: boolean } | null {
		const message = sdkMessage.message as APIUserMessage;

		if (Array.isArray(message.content)) {
			const toolResult = message.content.find(
				(block) => block.type === "tool_result",
			);
			if (toolResult && "tool_use_id" in toolResult) {
				return {
					toolUseId: toolResult.tool_use_id,
					isError: "is_error" in toolResult && toolResult.is_error === true,
				};
			}
		}
		return null;
	}

	/**
	 * Extract tool result content and error status from session entry
	 */
	private extractToolResult(
		entry: CyrusAgentSessionEntry,
	): { content: string; isError: boolean } | null {
		// Check if we have the error status in metadata
		const isError = entry.metadata?.toolResultError || false;

		return {
			content: entry.content,
			isError: isError,
		};
	}

	/**
	 * Sync session entry to external tracker (create AgentActivity)
	 */
	private async syncEntryToActivitySink(
		entry: CyrusAgentSessionEntry,
		sessionId: string,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				log.warn(`No session found`);
				return;
			}

			// Store entry locally first
			const entries = this.entries.get(sessionId) || [];
			entries.push(entry);
			this.entries.set(sessionId, entries);

			// Build activity content based on entry type
			let content: any;
			let ephemeral = false;
			switch (entry.type) {
				case "user": {
					const activeTaskId = this.activeTasksBySession.get(sessionId);
					if (activeTaskId && activeTaskId === entry.metadata?.toolUseId) {
						content = {
							type: "thought",
							body: `✅ Task Completed\n\n\n\n${entry.content}\n\n---\n\n`,
						};
						this.activeTasksBySession.delete(sessionId);
					} else if (entry.metadata?.toolUseId) {
						// This is a tool result - create an action activity with the result
						const toolResult = this.extractToolResult(entry);
						if (toolResult) {
							// Get the original tool information
							const originalTool = this.toolCallsByToolUseId.get(
								entry.metadata.toolUseId,
							);
							const toolName = originalTool?.name || "Tool";
							const toolInput = originalTool?.input || "";

							// Clean up the tool call from our tracking map
							if (entry.metadata.toolUseId) {
								this.toolCallsByToolUseId.delete(entry.metadata.toolUseId);
							}

							// Handle TaskCreate results: cache the task ID → subject mapping
							const baseToolName = toolName.replace("↪ ", "");
							if (baseToolName === "TaskCreate" && entry.metadata?.toolUseId) {
								const cachedSubject = this.taskSubjectsByToolUseId.get(
									entry.metadata.toolUseId,
								);
								if (cachedSubject) {
									// Parse task ID from result like "Task #1 created successfully: ..."
									const taskIdMatch = toolResult.content?.match(/Task #(\d+)/);
									if (taskIdMatch?.[1]) {
										this.taskSubjectsById.set(taskIdMatch[1], cachedSubject);
										// PON-116: the plan mirrors the real task list.
										this.planTrackers
											.get(sessionId)
											?.addTask(taskIdMatch[1], cachedSubject);
										void this.publishPlan(sessionId);
									}
									this.taskSubjectsByToolUseId.delete(
										entry.metadata.toolUseId!,
									);
								}
							}

							// Handle TaskUpdate/TaskGet results: post enriched thought with subject
							if (baseToolName === "TaskUpdate") {
								// PON-116: keep the plan in step with the task list.
								const taskId = String(toolInput?.taskId ?? "");
								const status = String(toolInput?.status ?? "");
								if (taskId && status) {
									this.planTrackers.get(sessionId)?.updateTask(taskId, status);
									void this.publishPlan(sessionId);
								}
							}
							if (baseToolName === "TaskUpdate" || baseToolName === "TaskGet") {
								const formatter = session.agentRunner?.getFormatter();
								if (!formatter) {
									log.warn(`No formatter available for session ${sessionId}`);
									return;
								}

								// Try to enrich toolInput with subject from cache or result
								const enrichedInput = { ...toolInput };
								if (!enrichedInput.subject) {
									const taskId = enrichedInput.taskId || "";
									// First try: look up subject from our cache
									const cachedSubject = this.taskSubjectsById.get(taskId);
									if (cachedSubject) {
										enrichedInput.subject = cachedSubject;
									} else if (baseToolName === "TaskGet" && toolResult.content) {
										// Second try: parse subject from TaskGet result content
										// Format: "ID: 123\nSubject: Fix bug\nStatus: ..."
										const subjectMatch =
											toolResult.content.match(/^Subject:\s*(.+)$/m);
										if (subjectMatch?.[1]) {
											enrichedInput.subject = subjectMatch[1].trim();
											// Also cache it for future TaskUpdate calls
											if (taskId) {
												this.taskSubjectsById.set(
													taskId,
													enrichedInput.subject,
												);
											}
										}
									} else if (
										baseToolName === "TaskUpdate" &&
										toolResult.content
									) {
										// Try to parse subject from TaskUpdate result content
										// Format: "Updated task #3 subject" or may contain task details
										const subjectMatch =
											toolResult.content.match(/^Subject:\s*(.+)$/m);
										if (subjectMatch?.[1]) {
											enrichedInput.subject = subjectMatch[1].trim();
											if (taskId) {
												this.taskSubjectsById.set(
													taskId,
													enrichedInput.subject,
												);
											}
										}
									}
								}

								const formattedTask = formatter.formatTaskParameter(
									baseToolName,
									enrichedInput,
								);
								content = {
									type: "thought",
									body: formattedTask,
								};
								ephemeral = false;
								break;
							}

							// Skip creating activity for TodoWrite/write_todos results since they already created a non-ephemeral thought
							// Skip TaskCreate/TaskList results since they already created a non-ephemeral thought
							// Skip AskUserQuestion results since it's custom handled via Linear's select signal elicitation
							if (
								toolName === "TodoWrite" ||
								toolName === "↪ TodoWrite" ||
								toolName === "write_todos" ||
								toolName === "TaskCreate" ||
								toolName === "↪ TaskCreate" ||
								toolName === "TaskList" ||
								toolName === "↪ TaskList" ||
								toolName === "AskUserQuestion" ||
								toolName === "↪ AskUserQuestion"
							) {
								return;
							}

							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Format parameter and result using runner's formatter
							const formattedParameter = formatter.formatToolParameter(
								toolName,
								toolInput,
							);
							const formattedResult = formatter.formatToolResult(
								toolName,
								toolInput,
								toolResult.content?.trim() || "",
								toolResult.isError,
							);

							// Format the action name (with description for Bash tool)
							const formattedAction = formatter.formatToolActionName(
								toolName,
								toolInput,
								toolResult.isError,
							);

							content = {
								type: "action",
								action: formattedAction,
								parameter: formattedParameter,
								result: formattedResult,
							};
						} else {
							return;
						}
					} else {
						return;
					}
					break;
				}
				case "assistant": {
					// Assistant messages can be thoughts or responses
					if (entry.metadata?.toolUseId) {
						const toolName = entry.metadata.toolName || "Tool";

						// Store tool information for later use in tool results
						if (entry.metadata.toolUseId) {
							// Check if this is a subtask with arrow prefix
							let storedName = toolName;
							if (entry.metadata?.parentToolUseId) {
								const activeTaskId = this.activeTasksBySession.get(sessionId);
								if (activeTaskId === entry.metadata?.parentToolUseId) {
									storedName = `↪ ${toolName}`;
								}
							}

							this.toolCallsByToolUseId.set(entry.metadata.toolUseId, {
								name: storedName,
								input: entry.metadata.toolInput || entry.content,
							});
						}

						// Skip AskUserQuestion tool - it's custom handled via Linear's select signal elicitation
						if (toolName === "AskUserQuestion") {
							return;
						}

						// Special handling for TodoWrite tool (Claude) and write_todos (Gemini) - treat as thought instead of action
						if (toolName === "TodoWrite" || toolName === "write_todos") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							const formattedTodos = formatter.formatTodoWriteParameter(
								entry.content,
							);
							content = {
								type: "thought",
								body: formattedTodos,
							};
							// TodoWrite/write_todos is not ephemeral
							ephemeral = false;
						} else if (toolName === "TaskCreate" || toolName === "TaskList") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available for session ${sessionId}`);
								return;
							}

							// Special handling for Task tools - format as thought instead of action
							const toolInput = entry.metadata.toolInput || entry.content;
							const formattedTask = formatter.formatTaskParameter(
								toolName,
								toolInput,
							);
							content = {
								type: "thought",
								body: formattedTask,
							};
							// Task tools are not ephemeral
							ephemeral = false;

							// Cache TaskCreate subject by toolUseId so we can map it to task ID when result arrives
							if (
								toolName === "TaskCreate" &&
								toolInput?.subject &&
								entry.metadata.toolUseId
							) {
								this.taskSubjectsByToolUseId.set(
									entry.metadata.toolUseId,
									toolInput.subject,
								);
							}
						} else if (toolName === "TaskUpdate" || toolName === "TaskGet") {
							// Skip posting at tool_use time — defer to tool_result time
							// so we can enrich with subject from result or cache
							return;
						} else if (toolName === "Task") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Special handling for Task tool - add start marker and track active task
							const toolInput = entry.metadata.toolInput || entry.content;
							const formattedParameter = formatter.formatToolParameter(
								toolName,
								toolInput,
							);
							const displayName = toolName;

							// Track this as the active Task for this session
							if (entry.metadata?.toolUseId) {
								this.activeTasksBySession.set(
									sessionId,
									entry.metadata.toolUseId,
								);
							}

							content = {
								type: "action",
								action: displayName,
								parameter: formattedParameter,
								// result will be added later when we get tool result
							};
							// Task is not ephemeral
							ephemeral = false;
						} else {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Other tools - check if they're within an active Task
							const toolInput = entry.metadata.toolInput || entry.content;
							let displayName = toolName;

							if (entry.metadata?.parentToolUseId) {
								const activeTaskId = this.activeTasksBySession.get(sessionId);
								if (activeTaskId === entry.metadata?.parentToolUseId) {
									displayName = `↪ ${toolName}`;
								}
							}

							const formattedParameter = formatter.formatToolParameter(
								displayName,
								toolInput,
							);

							content = {
								type: "action",
								action: displayName,
								parameter: formattedParameter,
								// result will be added later when we get tool result
							};
							// Standard tool calls are ephemeral
							ephemeral = true;
						}
					} else if (entry.metadata?.sdkError) {
						// Assistant message with SDK error (e.g., rate_limit, billing_error)
						// Create an error type so it's visible to users (not just a thought)
						// Per CYPACK-719: usage limits should trigger "error" type activity
						content = {
							type: "error",
							body: entry.content,
						};
					} else {
						// Regular assistant message - create a thought
						content = {
							type: "thought",
							body: entry.content,
						};
					}
					break;
				}

				case "system":
					// System messages are thoughts
					content = {
						type: "thought",
						body: entry.content,
					};
					break;

				case "result":
					// Result messages can be responses or errors
					if (entry.metadata?.isError) {
						content = {
							type: "error",
							body: entry.content,
						};
					} else {
						content = {
							type: "response",
							body: entry.content,
						};
					}
					break;

				default:
					// Default to thought
					content = {
						type: "thought",
						body: entry.content,
					};
			}

			// Ensure we have an external session ID for activity posting
			if (!session.externalSessionId) {
				log.debug(
					`Skipping activity sync - no external session ID (platform: ${session.issueContext?.trackerId || "unknown"})`,
				);
				return;
			}

			const options: ActivityPostOptions = {};
			if (ephemeral) {
				options.ephemeral = true;
			}

			const activitySink = this.getActivitySink(sessionId);
			if (!activitySink) {
				log.debug(
					`Skipping activity sync - no activity sink registered for session`,
				);
				return;
			}

			// PON-179: the STREAMED-entries path is the main narration artery
			// (formatter output — tool-call actions, assistant thoughts). On a
			// client-quiet workspace it obeys the same rule as the direct
			// funnel: one generic status, then silence; the shared
			// quietStatusPosted set means one status across BOTH paths.
			if (
				this.isClientQuietSession?.(sessionId) &&
				(content.type === "thought" || content.type === "action")
			) {
				if (!this.quietStatusPosted.has(sessionId)) {
					this.quietStatusPosted.add(sessionId);
					log.info(
						`[event:client_quiet_stream] first streamed ${content.type} suppressed — posting the generic status instead`,
					);
					content = {
						type: "thought",
						body: CLIENT_MESSAGES.workingStatus(),
					};
					options.ephemeral = undefined;
				} else {
					// PON-212: redirected, not discarded. The operator reads the
					// same typed transcript the agent produced.
					this.postToShadow(sessionId, content as never);
					log.debug(`Redirected streamed ${content.type} to the operator`);
					return;
				}
			} else if (
				this.isClientQuietSession?.(sessionId) &&
				content.type !== "response" &&
				typeof (content as { body?: unknown }).body === "string"
			) {
				// Errors and other stragglers still post — policy-sanitized,
				// paths repo-relative.
				content = {
					...content,
					body: this.applyClientContentPolicy(
						sessionId,
						`activity:${content.type}`,
						(content as { body: string }).body,
					),
				} as typeof content;
			}

			// PON-182: unconditional path floor on the streamed path too —
			// non-quiet narration posts, but never with a box path in it.
			content = this.sanitizePathsInContent(sessionId, content);

			const result = await activitySink.postActivity(
				session.externalSessionId,
				content,
				options,
			);

			if (result.activityId) {
				entry.linearAgentActivityId = result.activityId;
				if (entry.type === "result") {
					log.info(
						`Result message emitted to Linear (activity ${entry.linearAgentActivityId})`,
					);
				} else {
					log.debug(
						`Created ${content.type} activity ${entry.linearAgentActivityId}`,
					);
				}
			}
		} catch (error) {
			log.error(`Failed to sync entry to activity sink:`, error);
		}
	}

	/**
	 * Get session by ID
	 */
	getSession(sessionId: string): CyrusAgentSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Get session entries by session ID
	 */
	getSessionEntries(sessionId: string): CyrusAgentSessionEntry[] {
		return this.entries.get(sessionId) || [];
	}

	/**
	 * Get all active sessions
	 */
	getActiveSessions(): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) => session.status === AgentSessionStatus.Active,
		);
	}

	/**
	 * Add or update agent runner for a session
	 */
	addAgentRunner(sessionId: string, agentRunner: IAgentRunner): void {
		const log = this.sessionLog(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) {
			log.warn(`No session found`);
			return;
		}

		session.agentRunner = agentRunner;
		session.updatedAt = Date.now();
		log.debug(`Added agent runner`);
	}

	/**
	 *  Get all agent runners
	 */
	getAllAgentRunners(): IAgentRunner[] {
		return Array.from(this.sessions.values())
			.map((session) => session.agentRunner)
			.filter((runner): runner is IAgentRunner => runner !== undefined);
	}

	/**
	 * Resolve the issue ID from a session, checking issueContext first then deprecated issueId.
	 */
	private getSessionIssueId(session: CyrusAgentSession): string | undefined {
		return session.issueContext?.issueId ?? session.issueId;
	}

	/**
	 * Get all agent runners for a specific issue
	 */
	getAgentRunnersForIssue(issueId: string): IAgentRunner[] {
		return Array.from(this.sessions.values())
			.filter((session) => this.getSessionIssueId(session) === issueId)
			.map((session) => session.agentRunner)
			.filter((runner): runner is IAgentRunner => runner !== undefined);
	}

	/**
	 * Get sessions by issue ID
	 */
	getSessionsByIssueId(issueId: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) => this.getSessionIssueId(session) === issueId,
		);
	}

	/**
	 * Get active sessions by issue ID
	 */
	getActiveSessionsByIssueId(issueId: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				this.getSessionIssueId(session) === issueId &&
				session.status === AgentSessionStatus.Active,
		);
	}

	/**
	 * Get active sessions where the issue's branch name matches the given branch.
	 * Useful for detecting when multiple sessions share the same worktree.
	 */
	getActiveSessionsByBranchName(branchName: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				session.status === AgentSessionStatus.Active &&
				session.issue?.branchName === branchName,
		);
	}

	/**
	 * Get active sessions tracking a given base branch for a specific repository.
	 * Used by GitHub push webhook handling to notify agents when their base branch receives new commits.
	 */
	getSessionsByBaseBranch(
		baseBranchName: string,
		repositoryId: string,
	): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				session.status === AgentSessionStatus.Active &&
				session.repositories.some(
					(r) =>
						r.repositoryId === repositoryId &&
						r.baseBranchName === baseBranchName,
				),
		);
	}

	/**
	 * Find an active multi-repo session that includes the given repository.
	 * Used by GitHub webhook handling to resolve the correct sub-worktree
	 * when a @ mention targets a specific repo within a multi-repo workspace.
	 */
	getActiveMultiRepoSessionForRepository(
		repositoryId: string,
	): CyrusAgentSession | null {
		for (const session of this.sessions.values()) {
			if (session.status !== AgentSessionStatus.Active) continue;
			if (!session.workspace.repoPaths) continue; // not multi-repo
			const matchesRepo = session.repositories.some(
				(r) => r.repositoryId === repositoryId,
			);
			if (matchesRepo) {
				return session;
			}
		}
		return null;
	}

	/**
	 * Get all sessions
	 */
	getAllSessions(): CyrusAgentSession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Get agent runner for a specific session
	 */
	getAgentRunner(sessionId: string): IAgentRunner | undefined {
		const session = this.sessions.get(sessionId);
		return session?.agentRunner;
	}

	/**
	 * Check if an agent runner exists for a session
	 */
	hasAgentRunner(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return session?.agentRunner !== undefined;
	}

	/**
	 * Post an activity to the activity sink for a session.
	 * Consolidates session lookup, externalSessionId guard, try/catch, and logging.
	 *
	 * @returns The activity ID when resolved, `null` otherwise.
	 */
	private async postActivity(
		sessionId: string,
		input: {
			content: any;
			ephemeral?: boolean;
			signal?: ActivitySignal;
			signalMetadata?: Record<string, unknown>;
		},
		label: string,
	): Promise<string | null> {
		const log = this.sessionLog(sessionId);
		const session = this.sessions.get(sessionId);

		if (!session?.externalSessionId) {
			log.debug(
				`Skipping ${label} - no external session ID (platform: ${session?.issueContext?.trackerId || "unknown"})`,
			);
			return null;
		}

		// PON-179: on a gated workspace the activity stream is a CLIENT
		// surface. Working narration — thoughts, tool-call action renderings
		// (which can carry internal paths, diffs, even the operator note's
		// parameters) — does not post. Liveness comes from the ack, the
		// per-invocation "Analyzing your request…" (which also re-arms the
		// status), ONE generic status line, elicitations, and the final
		// response. Everything else that still posts is policy-sanitized.
		const contentType = input.content?.type;
		if (
			this.isClientQuietSession?.(sessionId) &&
			(contentType === "thought" || contentType === "action")
		) {
			if (label === "analyzing thought") {
				// Clean generic text; passing it re-arms the one status line
				// for this invocation, so every prompt shows fresh liveness.
				this.quietStatusPosted.delete(sessionId);
			} else if (!this.quietStatusPosted.has(sessionId)) {
				this.quietStatusPosted.add(sessionId);
				log.info(
					`[event:client_quiet_stream] first ${contentType} suppressed — posting the generic status instead`,
				);
				input = {
					content: { type: "thought", body: CLIENT_MESSAGES.workingStatus() },
				};
				label = "quiet status";
			} else {
				// PON-212: the other narration artery. Same rule — the client
				// does not see it, the operator does.
				if (input.content) this.postToShadow(sessionId, input.content as never);
				log.debug(`Redirected ${label} to the operator (client-quiet)`);
				return null;
			}
		} else if (
			this.isClientQuietSession?.(sessionId) &&
			contentType !== "response" &&
			typeof input.content?.body === "string"
		) {
			// Backstop for anything else that still posts on the client
			// surface (errors, status clears): the R2 policy, path-redaction
			// repo-relative. The response path is covered upstream.
			input = {
				...input,
				content: {
					...input.content,
					body: this.applyClientContentPolicy(
						sessionId,
						`activity:${contentType}`,
						input.content.body,
					),
				},
			};
		}

		// PON-182: unconditional path floor — applies to whatever is left
		// posting, quiet or not (a no-op on already-clean content).
		if (input.content && typeof input.content === "object") {
			input = {
				...input,
				content: this.sanitizePathsInContent(sessionId, input.content),
			};
		}

		try {
			const options: ActivityPostOptions = {};
			if (input.ephemeral !== undefined) {
				options.ephemeral = input.ephemeral;
			}
			if (input.signal) {
				options.signal = input.signal;
			}
			if (input.signalMetadata) {
				options.signalMetadata = input.signalMetadata;
			}

			const activitySink = this.getActivitySink(sessionId);
			if (!activitySink) {
				log.debug(
					`Skipping ${label} - no activity sink registered for session`,
				);
				return null;
			}

			const result = await activitySink.postActivity(
				session.externalSessionId,
				input.content,
				options,
			);

			if (result.activityId) {
				log.debug(`Created ${label} activity ${result.activityId}`);
				return result.activityId;
			}
			log.debug(`Created ${label}`);
			return null;
		} catch (error) {
			log.error(`Error creating ${label}:`, error);
			return null;
		}
	}

	/**
	 * Create a thought activity
	 */
	async createThoughtActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "thought", body } },
			"thought",
		);
	}

	/**
	 * Create an action activity
	 */
	async createActionActivity(
		sessionId: string,
		action: string,
		parameter: string,
		result?: string,
	): Promise<void> {
		const content: any = { type: "action", action, parameter };
		if (result !== undefined) {
			content.result = result;
		}
		await this.postActivity(sessionId, { content }, "action");
	}

	/**
	 * Create a response activity
	 */
	/**
	 * Post a response activity and PROVE it landed (PON-152 delivery). The
	 * lenient posting paths swallow every failure by design — fine for
	 * progress activity, fatal for the one post that flips work to
	 * "delivered". Throws on a missing session, a missing sink, or a post
	 * that produced no activity id, so the caller keeps the work pending and
	 * the operator retries instead of being told it went out.
	 */
	async postResponseActivityStrict(
		sessionId: string,
		body: string,
	): Promise<string> {
		const session = this.sessions.get(sessionId);
		if (!session?.externalSessionId) {
			throw new Error(
				"session has no external session id (removed, or non-Linear platform)",
			);
		}
		const activitySink = this.getActivitySink(sessionId);
		if (!activitySink) {
			throw new Error("no activity sink registered for the session");
		}
		const checkedBody = this.applyClientContentPolicy(
			sessionId,
			"delivery",
			body,
		);
		const result = await activitySink.postActivity(
			session.externalSessionId,
			// Same literal shape the lenient path sends (it passes through an
			// `any`-typed field; the sink accepts the string literal at
			// runtime).
			{ type: "response", body: checkedBody } as never,
			{},
		);
		if (!result?.activityId) {
			throw new Error("activity post returned no activity id");
		}
		return result.activityId;
	}

	async createResponseActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "response", body } },
			"response",
		);
	}

	/**
	 * PON-138: how far a session got, for the startup-death heuristic —
	 * a session that dies with only a handful of entries never reached
	 * real work and is a retry candidate.
	 */
	getEntryCount(sessionId: string): number {
		return this.entries.get(sessionId)?.length ?? 0;
	}

	/**
	 * PON-138: the last result entry's error text, or null when the session
	 * has no result yet / ended cleanly.
	 */
	getLastResultError(sessionId: string): string | null {
		const entries = this.entries.get(sessionId) ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "result") continue;
			return entry.metadata?.isError ? (entry.content ?? "") : null;
		}
		return null;
	}

	/**
	 * Create an error activity
	 */
	async createErrorActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "error", body } },
			"error",
		);
	}

	/**
	 * Create an elicitation activity
	 */
	async createElicitationActivity(
		sessionId: string,
		body: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "elicitation", body } },
			"elicitation",
		);
	}

	/**
	 * Create an approval elicitation activity with auth signal
	 */
	async createApprovalElicitation(
		sessionId: string,
		body: string,
		approvalUrl: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{
				content: { type: "elicitation", body },
				signal: "auth",
				signalMetadata: { url: approvalUrl },
			},
			"approval elicitation",
		);
	}

	/**
	 * Remove a session and all associated tracking state.
	 * Use for immediate cleanup when a session is permanently done
	 * (e.g., issue moved to terminal state).
	 */
	removeSession(sessionId: string): void {
		const log = this.sessionLog(sessionId);
		this.sessions.delete(sessionId);
		this.entries.delete(sessionId);
		this.activitySinks.delete(sessionId);
		this.activeTasksBySession.delete(sessionId);
		this.activeStatusActivitiesBySession.delete(sessionId);
		this.stopRequestedSessions.delete(sessionId);
		this.lastAssistantBodyBySession.delete(sessionId);
		this.bufferedAssistantEntryBySession.delete(sessionId);
		this.messageProcessingQueues.delete(sessionId);
		log.debug("Removed session");
	}

	/**
	 * Clear completed sessions older than specified time
	 */
	cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): void {
		const cutoff = Date.now() - olderThanMs;

		for (const [sessionId, session] of this.sessions.entries()) {
			if (
				(session.status === "complete" || session.status === "error") &&
				session.updatedAt < cutoff
			) {
				const log = this.sessionLog(sessionId);
				this.sessions.delete(sessionId);
				this.entries.delete(sessionId);
				log.debug(`Cleaned up session`);
			}
		}
	}

	/**
	 * Serialize Agent Session state for persistence
	 */
	serializeState(): {
		sessions: Record<string, SerializedCyrusAgentSession>;
		entries: Record<string, SerializedCyrusAgentSessionEntry[]>;
	} {
		const sessions: Record<string, SerializedCyrusAgentSession> = {};
		const entries: Record<string, SerializedCyrusAgentSessionEntry[]> = {};

		// Serialize sessions
		for (const [sessionId, session] of this.sessions.entries()) {
			// Exclude agentRunner from serialization as it's not serializable
			const { agentRunner: _agentRunner, ...serializableSession } = session;
			sessions[sessionId] = serializableSession;
		}

		// Serialize entries
		for (const [sessionId, sessionEntries] of this.entries.entries()) {
			entries[sessionId] = sessionEntries.map((entry) => ({
				...entry,
			}));
		}

		return { sessions, entries };
	}

	/**
	 * Restore Agent Session state from serialized data
	 */
	restoreState(
		serializedSessions: Record<string, SerializedCyrusAgentSession>,
		serializedEntries: Record<string, SerializedCyrusAgentSessionEntry[]>,
	): void {
		// Clear existing state
		this.sessions.clear();
		this.entries.clear();

		// Restore sessions (migrate old sessions without repositories field)
		for (const [sessionId, sessionData] of Object.entries(serializedSessions)) {
			const session: CyrusAgentSession = {
				...sessionData,
				repositories: sessionData.repositories ?? [],
			};
			this.sessions.set(sessionId, session);
		}

		// Restore entries
		for (const [sessionId, entriesData] of Object.entries(serializedEntries)) {
			const sessionEntries: CyrusAgentSessionEntry[] = entriesData.map(
				(entryData) => ({
					...entryData,
				}),
			);
			this.entries.set(sessionId, sessionEntries);
		}

		this.logger.debug(
			`Restored ${this.sessions.size} sessions, ${Object.keys(serializedEntries).length} entry collections`,
		);
	}

	/**
	 * Post a thought about the model being used
	 */
	private async postModelNotificationThought(
		sessionId: string,
		model: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "thought", body: `Using model: ${model}` } },
			"model notification",
		);
	}

	/**
	 * Post an ephemeral "Analyzing your request..." thought and return the activity ID
	 */
	async postAnalyzingThought(sessionId: string): Promise<string | null> {
		return this.postActivity(
			sessionId,
			{
				content: { type: "thought", body: "Analyzing your request…" },
				ephemeral: true,
			},
			"analyzing thought",
		);
	}

	/**
	 * Handle status messages (compacting, etc.)
	 */
	private async handleStatusMessage(
		sessionId: string,
		message: SDKStatusMessage,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session?.externalSessionId) {
			const log = this.sessionLog(sessionId);
			log.debug(
				`Skipping status message - no external session ID (platform: ${session?.issueContext?.trackerId || "unknown"})`,
			);
			return;
		}

		if (message.status === "compacting") {
			const activityId = await this.postActivity(
				sessionId,
				{
					content: {
						type: "thought",
						body: "Compacting conversation history…",
					},
					ephemeral: true,
				},
				"compacting status",
			);
			if (activityId) {
				this.activeStatusActivitiesBySession.set(sessionId, activityId);
			}
		} else if (message.status === null) {
			// Clear the status - post a non-ephemeral thought to replace the ephemeral one
			await this.postActivity(
				sessionId,
				{
					content: { type: "thought", body: "Conversation history compacted" },
					ephemeral: false,
				},
				"status clear",
			);
			// Clean up the stored activity ID regardless — stale IDs do no harm
			this.activeStatusActivitiesBySession.delete(sessionId);
		}
	}
}
