import type {
	AgentActivityCreateInput,
	IIssueTrackerService,
	ILogger,
	RepoSetupHookEvent,
	RepositoryConfig,
} from "cyrus-core";

/**
 * How a direct post relates to the client (PON-189).
 *
 * `sanctioned` — the client is the intended reader: acknowledgments, queue
 * positions, blocked-by notices, refusals. Always posts.
 * `narration` — internal working detail that happens to be addressed at the
 * session: tool output, prompt-selection, sub-issue transcripts. Obeys the
 * same suppression as the other two posting paths on a client-quiet
 * workspace.
 *
 * There is no default: every call site chooses, because the one that did not
 * choose is the one that leaked.
 */
export type ClientSurfaceKind = "sanctioned" | "narration";

/**
 * The client-surface floor, injected so this module needs no knowledge of
 * workspaces or content policy (PON-189).
 */
export interface ClientSurfaceGuard {
	/** Is this session's workspace client-quiet (narration suppressed)? */
	isQuiet(sessionId: string): boolean;
	/** Path floor on every workspace; full content policy on quiet ones. */
	sanitize(sessionId: string, surface: string, text: string): string;
}

export class ActivityPoster {
	private issueTrackers: Map<string, IIssueTrackerService>;
	private repositories: Map<string, RepositoryConfig>;
	private logger: ILogger;
	private clientSurface: ClientSurfaceGuard;

	constructor(
		issueTrackers: Map<string, IIssueTrackerService>,
		repositories: Map<string, RepositoryConfig>,
		logger: ILogger,
		clientSurface: ClientSurfaceGuard,
	) {
		this.issueTrackers = issueTrackers;
		this.repositories = repositories;
		this.logger = logger;
		this.clientSurface = clientSurface;
	}

	/**
	 * Apply the client-surface floor to a direct post (PON-189).
	 *
	 * This module writes straight to `createAgentActivity`, bypassing both
	 * gated paths in AgentSessionManager — which is exactly how routing
	 * internals reached a client thread on a workspace whose very next
	 * thought was suppressed. Every direct post now goes through the same
	 * two rules the other paths obey: narration is suppressed on a quiet
	 * workspace, and internal paths never survive on any workspace.
	 *
	 * Returns the input to post, or null when the post is suppressed.
	 */
	private applyClientSurfaceFloor(
		input: AgentActivityCreateInput,
		kind: ClientSurfaceKind,
		label: string,
	): AgentActivityCreateInput | null {
		const sessionId = input.agentSessionId;
		const content = input.content as Record<string, unknown> | undefined;
		if (!content) return input;
		const type = content.type;

		if (
			kind === "narration" &&
			(type === "thought" || type === "action") &&
			this.clientSurface.isQuiet(sessionId)
		) {
			this.logger.info(
				`[event:client_quiet_stream] direct ${String(type)} suppressed (client-quiet): ${label}`,
			);
			return null;
		}

		let changed = false;
		const out: Record<string, unknown> = { ...content };
		for (const key of ["body", "action", "parameter", "result"]) {
			const value = out[key];
			if (typeof value !== "string") continue;
			const sanitized = this.clientSurface.sanitize(
				sessionId,
				`direct:${label}`,
				value,
			);
			if (sanitized !== value) {
				out[key] = sanitized;
				changed = true;
			}
		}
		if (!changed) return input;
		return {
			...input,
			content: out as AgentActivityCreateInput["content"],
		};
	}

	async postActivityDirect(
		issueTracker: IIssueTrackerService,
		input: AgentActivityCreateInput,
		label: string,
		kind: ClientSurfaceKind,
	): Promise<string | null> {
		const guarded = this.applyClientSurfaceFloor(input, kind, label);
		if (!guarded) return null;
		try {
			const result = await issueTracker.createAgentActivity(guarded);
			if (result.success) {
				if (result.agentActivity) {
					const activity = await result.agentActivity;
					this.logger.debug(`Created ${label} activity ${activity.id}`);
					return activity.id;
				}
				this.logger.debug(`Created ${label}`);
				return null;
			}
			this.logger.error(`Failed to create ${label}:`, result);
			return null;
		} catch (error) {
			this.logger.error(`Error creating ${label}:`, error);
			return null;
		}
	}

	async postThoughtActivity(
		sessionId: string,
		workspaceId: string,
		body: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body },
			},
			"thought activity",
			"sanctioned",
		);
	}

	async postInstantAcknowledgment(
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "thought",
					// Keep short and direct — final per-queue-state wording lands with PON-112
					body: "Got it. Looking at this now.",
				},
			},
			"instant acknowledgment",
			"sanctioned",
		);
	}

	async postParentResumeAcknowledgment(
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body: "Resuming from child session" },
			},
			"parent resume acknowledgment",
			"narration",
		);
	}

	/**
	 * The deliverable-framed scope, posted to the client thread by the
	 * machinery (PON-188).
	 *
	 * The gate instructs the session to post this itself, but a session's only
	 * way to say something mid-run is assistant text — which is narration, and
	 * narration is suppressed on exactly the workspaces this gate runs on. The
	 * client was left with "Shall I proceed with the scope above?" and no
	 * scope above. So the text the session already recorded as `client_scope`
	 * is posted from here instead: sanctioned, deterministic, and impossible
	 * for a model to forget.
	 *
	 * Returns true only when the activity was actually created — the caller
	 * treats anything else as "the scope did not land" and refuses to ask.
	 */
	async postClientScopeProposal(
		sessionId: string,
		workspaceId: string,
		body: string,
	): Promise<boolean> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return false;
		}
		const guarded = this.applyClientSurfaceFloor(
			{
				agentSessionId: sessionId,
				content: { type: "thought", body },
			},
			"sanctioned",
			"client scope proposal",
		);
		if (!guarded) return false;
		try {
			const result = await issueTracker.createAgentActivity(guarded);
			if (!result.success) {
				this.logger.error("Failed to post client scope proposal:", result);
				return false;
			}
			return true;
		} catch (error) {
			this.logger.error("Error posting client scope proposal:", error);
			return false;
		}
	}

	async postRepoSetupHookActivity(
		sessionId: string,
		workspaceId: string,
		event: RepoSetupHookEvent,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		const parameter = event.repositoryName
			? `Repository setup hook for ${event.repositoryName}`
			: "Repository setup hook";

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "action",
					action: event.scriptName,
					parameter,
					result: this.formatRepoSetupHookResult(event),
				},
			},
			"repository setup hook",
			"narration",
		);
	}

	private formatRepoSetupHookResult(event: RepoSetupHookEvent): string {
		if (event.status === "started") {
			return "Started.";
		}

		const duration = this.formatDuration(event.durationMs);
		if (event.status === "succeeded") {
			return `Succeeded${duration ? ` in ${duration}` : ""}.`;
		}

		const lines = [
			`Failed${duration ? ` after ${duration}` : ""}: ${event.errorMessage ?? "setup hook exited unsuccessfully"}`,
		];
		if (typeof event.exitCode === "number") {
			lines.push(`Exit code: ${event.exitCode}`);
		}
		if (event.signal) {
			lines.push(`Signal: ${event.signal}`);
		}

		const stdoutTail = this.escapeCodeFence(event.stdoutTail?.trim());
		const stderrTail = this.escapeCodeFence(event.stderrTail?.trim());
		if (stdoutTail) {
			lines.push("", "Stdout tail:", "```", stdoutTail, "```");
		}
		if (stderrTail) {
			lines.push("", "Stderr tail:", "```", stderrTail, "```");
		}
		const hint = this.formatRepoSetupHookFailureHint(event);
		if (hint) {
			lines.push("", hint);
		}
		return lines.join("\n");
	}

	private formatRepoSetupHookFailureHint(
		event: RepoSetupHookEvent,
	): string | null {
		const output = [event.errorMessage, event.stdoutTail, event.stderrTail]
			.filter((value): value is string => Boolean(value))
			.join("\n")
			.toLowerCase();

		if (!this.looksLikeSudoFailure(output)) {
			return null;
		}

		// R2 (PON-168): no product-internal names on tenant surfaces.
		return "The setup script does not run with sudo privileges. Keep `cyrus-setup.sh` to repo-local setup; packages that need privileged installation must be preinstalled on the runtime by the operator.";
	}

	private looksLikeSudoFailure(output: string): boolean {
		return [
			/sudo:/,
			/no tty present/,
			/a password is required/,
			/not in the sudoers file/,
			/must be run as root/,
			/permission denied.*sudo/,
		].some((pattern) => pattern.test(output));
	}

	private formatDuration(durationMs?: number): string | null {
		if (typeof durationMs !== "number") return null;
		if (durationMs < 1_000) return `${durationMs}ms`;
		return `${(durationMs / 1_000).toFixed(1)}s`;
	}

	private escapeCodeFence(value?: string): string {
		return value?.replace(/```/g, "'''") ?? "";
	}

	async postSystemPromptSelectionThought(
		sessionId: string,
		labels: string[],
		workspaceId: string,
		repositoryId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		// Determine which prompt type was selected and which label triggered it
		let selectedPromptType: string | null = null;
		let triggerLabel: string | null = null;
		const repository = Array.from(this.repositories.values()).find(
			(r) => r.id === repositoryId,
		);

		if (repository?.labelPrompts) {
			// Check debugger labels
			const debuggerConfig = repository.labelPrompts.debugger;
			const debuggerLabels = Array.isArray(debuggerConfig)
				? debuggerConfig
				: debuggerConfig?.labels;
			const debuggerLabel = debuggerLabels?.find((label) =>
				labels.includes(label),
			);
			if (debuggerLabel) {
				selectedPromptType = "debugger";
				triggerLabel = debuggerLabel;
			} else {
				// Check builder labels
				const builderConfig = repository.labelPrompts.builder;
				const builderLabels = Array.isArray(builderConfig)
					? builderConfig
					: builderConfig?.labels;
				const builderLabel = builderLabels?.find((label) =>
					labels.includes(label),
				);
				if (builderLabel) {
					selectedPromptType = "builder";
					triggerLabel = builderLabel;
				} else {
					// Check scoper labels
					const scoperConfig = repository.labelPrompts.scoper;
					const scoperLabels = Array.isArray(scoperConfig)
						? scoperConfig
						: scoperConfig?.labels;
					const scoperLabel = scoperLabels?.find((label) =>
						labels.includes(label),
					);
					if (scoperLabel) {
						selectedPromptType = "scoper";
						triggerLabel = scoperLabel;
					} else {
						// Check orchestrator labels
						const orchestratorConfig = repository.labelPrompts.orchestrator;
						const orchestratorLabels = Array.isArray(orchestratorConfig)
							? orchestratorConfig
							: (orchestratorConfig?.labels ?? ["orchestrator"]);
						const orchestratorLabel = orchestratorLabels?.find((label) =>
							labels.includes(label),
						);
						if (orchestratorLabel) {
							selectedPromptType = "orchestrator";
							triggerLabel = orchestratorLabel;
						}
					}
				}
			}
		}

		// Only post if a role was actually triggered
		if (!selectedPromptType || !triggerLabel) {
			return;
		}

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: {
					type: "thought",
					body: `Entering '${selectedPromptType}' mode because of the '${triggerLabel}' label. I'll follow the ${selectedPromptType} process...`,
				},
			},
			"system prompt selection",
			"narration",
		);
	}

	/**
	 * Lane-busy acknowledgment for a newly created session (PON-112). Posted
	 * as the ONE first activity instead of the normal instant acknowledgment.
	 */
	async postQueuedAcknowledgment(
		sessionId: string,
		workspaceId: string,
		position: number,
	): Promise<void> {
		await this.postLaneElicitation(
			sessionId,
			workspaceId,
			`Queued — position #${position}. One issue is worked at a time; reorder anytime by telling me which issue should be next.`,
			"queued acknowledgment",
		);
	}

	/** Position update for a queued session whose position actually changed. */
	async postQueuePositionUpdate(
		sessionId: string,
		workspaceId: string,
		position: number,
	): Promise<void> {
		await this.postLaneElicitation(
			sessionId,
			workspaceId,
			position === 1
				? "Queue update — now position #1. This issue is next."
				: `Queue update — now position #${position}.`,
			"queue position update",
		);
	}

	/** Confirmation on the session that was moved to the front of the queue. */
	async postQueueReorderConfirmation(
		sessionId: string,
		workspaceId: string,
		alreadyFirst: boolean,
	): Promise<void> {
		await this.postLaneElicitation(
			sessionId,
			workspaceId,
			alreadyFirst
				? "This issue is already next in the queue."
				: "Done — this issue is now next in the queue.",
			"queue reorder confirmation",
		);
	}

	/** Ack for a non-reorder prompt on a queued session; position unchanged. */
	async postQueueContextAcknowledgment(
		sessionId: string,
		workspaceId: string,
		position: number,
	): Promise<void> {
		await this.postLaneElicitation(
			sessionId,
			workspaceId,
			`Got it — noted for when this issue starts. Still position #${position}.`,
			"queue context acknowledgment",
		);
	}

	/**
	 * Posted on a queued session that was removed (stop, unassign, cancel).
	 * A response, not an elicitation: the session is leaving the queue, so it
	 * should end its turn cleanly rather than keep waiting on the user.
	 */
	async postQueueRemovedNotice(
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}
		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "response", body: "Removed from the queue." },
			},
			"queue removal notice",
			"sanctioned",
		);
	}

	/**
	 * Posted on a session that held the lane across a restart and was not
	 * resumed within the boot grace window (PON-112).
	 */
	async postLaneGraceReleaseNotice(
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		await this.postLaneElicitation(
			sessionId,
			workspaceId,
			"The service restarted while this issue was active and nothing resumed it within 10 minutes, so the lane was released to let queued work continue. Comment here to resume this session.",
			"lane grace release notice",
		);
	}

	/**
	 * Post a lane message as an ELICITATION, not a thought (PON-112).
	 *
	 * Linear only delivers `prompted` webhooks for sessions where the agent has
	 * yielded its turn — status `awaitingInput` or terminal. A queued session
	 * that posts a thought and then goes silent keeps holding its turn, so
	 * Linear records client replies on it but never pushes them to us: the
	 * reorder the queued acknowledgment explicitly invites would silently
	 * never arrive. An elicitation puts the session in `awaitingInput`, which
	 * is both semantically accurate (a queued session IS waiting on the human)
	 * and the state in which replies are delivered.
	 *
	 * Verified against the Linear API: posting a bare elicitation (no select
	 * signal, free-form reply) transitions the session to `awaitingInput`.
	 */
	private async postLaneElicitation(
		sessionId: string,
		workspaceId: string,
		body: string,
		label: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}
		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "elicitation", body },
			},
			label,
			"sanctioned",
		);
	}

	async postInstantPromptedAcknowledgment(
		sessionId: string,
		workspaceId: string,
		isStreaming: boolean,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return;
		}

		// Keep short and direct — final per-queue-state wording lands with PON-112
		const message = isStreaming
			? "Got it — feeding this into the run in progress."
			: "Got it. Looking at this now.";

		await this.postActivityDirect(
			issueTracker,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body: message },
			},
			"prompted acknowledgment",
			"sanctioned",
		);
	}

	async postComment(
		issueId: string,
		body: string,
		workspaceId: string,
		parentId?: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			throw new Error(`No issue tracker found for workspace ${workspaceId}`);
		}
		const commentInput: { body: string; parentId?: string } = {
			body,
		};
		// Add parent ID if provided (for reply)
		if (parentId) {
			commentInput.parentId = parentId;
		}
		await issueTracker.createComment(issueId, commentInput);
	}
}
