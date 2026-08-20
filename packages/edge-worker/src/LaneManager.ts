import type { ILogger, SerializedLaneState } from "cyrus-core";
import { createLogger } from "cyrus-core";

/**
 * One queued session waiting for its workspace lane (PON-112).
 * `webhook` is the raw AgentSessionCreatedWebhook payload captured at enqueue
 * time; it is replayed through the normal created-session flow when the entry
 * starts, so the start path stays identical to a fresh delegation.
 */
export interface LaneQueueEntry {
	sessionId: string;
	issueId?: string;
	issueIdentifier?: string;
	enqueuedAt: string;
	webhook: unknown;
	/** Prompts received while queued; delivered as context when the session starts. */
	contextPrompts: string[];
	/**
	 * "created": new session, webhook replays through the created flow.
	 * "resume": prompt on an existing (delivered) session that arrived while
	 * another session held the lane; webhook replays through the prompted flow.
	 */
	kind: "created" | "resume";
}

interface LaneState {
	/**
	 * Sessions currently holding the lane. At most `limit` (default 1).
	 *
	 * A set rather than a single slot because a lane admits N concurrent
	 * sessions (PON-139). At N=1 this behaves exactly as the single slot did;
	 * the guarantee generalizes from "one active session" to "at most N", and
	 * every path that released the slot now releases one of N.
	 */
	activeSessionIds: Set<string>;
	queue: LaneQueueEntry[];
}

export interface LanePositionChange {
	sessionId: string;
	position: number;
}

/**
 * Matches short next/prioritize intents on a queued session ("next", "do this
 * one next", "prioritize this", "move to the front"). Deliberately anchored
 * and length-capped: misreading added context as a reorder is the worse
 * failure, so long prompts that merely contain "next" never match.
 */
const QUEUE_REORDER_INTENT_RE =
	/^(?:please\s+)?(?:next|first|(?:do|start|work\s+on|take)\s+(?:this|it)(?:\s+one)?\s+(?:next|first)|this\s+one\s+(?:next|first)|prioriti[sz]e(?:\s+(?:this|it)(?:\s+one)?)?|make\s+(?:this|it)\s+(?:next|first)|move\s+(?:this\s+)?(?:up|to\s+(?:the\s+)?(?:front|top))|(?:jump|top)\s+(?:of\s+)?the\s+queue|bump\s+(?:this|it)(?:\s+up)?)$/i;

const QUEUE_REORDER_INTENT_MAX_LENGTH = 48;

export function isQueueReorderIntent(prompt: string): boolean {
	const stripped = prompt.trim().replace(/[.!?\s]+$/u, "");
	if (
		stripped.length === 0 ||
		stripped.length > QUEUE_REORDER_INTENT_MAX_LENGTH
	) {
		return false;
	}
	return QUEUE_REORDER_INTENT_RE.test(stripped);
}

/**
 * Serializes work per Linear workspace to one active session at a time
 * (PON-112). Purely in-memory bookkeeping — persistence, activity posting,
 * and session starting stay in EdgeWorker. All methods are synchronous so
 * lane decisions never add latency to the webhook acknowledgment path.
 *
 * Workspaces opt in via `linearWorkspaces[id].laneSerialization: true`;
 * everything else bypasses with a single predicate call.
 */
export class LaneManager {
	private lanes = new Map<string, LaneState>();
	/** Reverse index: sessionId → workspaceId, for active and queued sessions. */
	private sessionWorkspace = new Map<string, string>();
	/** Boot-grace deadlines per workspace (ISO), for admin visibility only. */
	private graceDeadlines = new Map<string, string>();
	private isWorkspaceEnabled: (workspaceId: string) => boolean;
	/** How many sessions a workspace may run at once. Default 1. */
	private workspaceConcurrency: (workspaceId: string) => number;
	private logger: ILogger;

	constructor(
		isWorkspaceEnabled: (workspaceId: string) => boolean,
		logger?: ILogger,
		workspaceConcurrency: (workspaceId: string) => number = () => 1,
	) {
		this.isWorkspaceEnabled = isWorkspaceEnabled;
		this.workspaceConcurrency = workspaceConcurrency;
		this.logger = logger ?? createLogger({ component: "LaneManager" });
	}

	isEnabled(workspaceId: string): boolean {
		return this.isWorkspaceEnabled(workspaceId);
	}

	private lane(workspaceId: string): LaneState {
		let lane = this.lanes.get(workspaceId);
		if (!lane) {
			lane = { activeSessionIds: new Set(), queue: [] };
			this.lanes.set(workspaceId, lane);
		}
		return lane;
	}

	/**
	 * Try to take the lane for a session. Returns true when the lane was free
	 * (or this session already holds it — duplicate webhook deliveries must
	 * not enqueue a session behind itself).
	 */
	acquire(workspaceId: string, sessionId: string): boolean {
		const lane = this.lane(workspaceId);
		if (lane.activeSessionIds.has(sessionId)) return true;
		if (lane.activeSessionIds.size >= this.concurrencyOf(workspaceId)) {
			return false;
		}
		lane.activeSessionIds.add(sessionId);
		this.sessionWorkspace.set(sessionId, workspaceId);
		return true;
	}

	/**
	 * Append a session to the lane's queue. Returns its 1-based position.
	 * Idempotent for duplicate webhook deliveries: an already-queued session
	 * keeps its position.
	 */
	enqueue(
		workspaceId: string,
		entry: Omit<LaneQueueEntry, "contextPrompts"> &
			Partial<Pick<LaneQueueEntry, "contextPrompts">>,
	): number {
		const lane = this.lane(workspaceId);
		const existing = lane.queue.findIndex(
			(e) => e.sessionId === entry.sessionId,
		);
		if (existing !== -1) return existing + 1;
		lane.queue.push({ contextPrompts: [], ...entry });
		this.sessionWorkspace.set(entry.sessionId, workspaceId);
		return lane.queue.length;
	}

	/**
	 * Release the lane if (and only if) this session holds it. Idempotent —
	 * multiple end signals for the same session (result message, runner error,
	 * stop) may all fire. Returns true when the lane was actually released.
	 */
	release(workspaceId: string, sessionId: string): boolean {
		const lane = this.lanes.get(workspaceId);
		if (!lane?.activeSessionIds.delete(sessionId)) return false;
		this.sessionWorkspace.delete(sessionId);
		// Only clear the boot grace once nothing holds the lane: with N > 1 a
		// single session ending does not mean the lane is idle.
		if (lane.activeSessionIds.size === 0) {
			this.graceDeadlines.delete(workspaceId);
		}
		return true;
	}

	/**
	 * Dequeue the head entry and mark it active. Returns null when the queue
	 * is empty or the lane is still held.
	 */
	takeNext(workspaceId: string): LaneQueueEntry | null {
		const lane = this.lanes.get(workspaceId);
		if (
			!lane ||
			lane.activeSessionIds.size >= this.concurrencyOf(workspaceId)
		) {
			return null;
		}
		const next = lane.queue.shift();
		if (!next) return null;
		lane.activeSessionIds.add(next.sessionId);
		this.sessionWorkspace.set(next.sessionId, workspaceId);
		return next;
	}

	/**
	 * Move a queued session to the front. Returns the position changes for
	 * OTHER queued sessions (the moved session's confirmation is posted
	 * separately), or null when the session is not queued.
	 */
	moveToFront(sessionId: string): {
		alreadyFirst: boolean;
		changes: LanePositionChange[];
	} | null {
		const located = this.locateQueued(sessionId);
		if (!located) return null;
		const { lane, index } = located;
		if (index === 0) return { alreadyFirst: true, changes: [] };
		const before = this.positionsOf(lane);
		const [entry] = lane.queue.splice(index, 1);
		lane.queue.unshift(entry!);
		return {
			alreadyFirst: false,
			changes: this.diffPositions(before, lane).filter(
				(c) => c.sessionId !== sessionId,
			),
		};
	}

	/**
	 * Remove a queued session (stop signal, unassign, issue canceled/deleted).
	 * Returns position changes for the sessions that shifted, or null when the
	 * session was not queued.
	 */
	removeQueued(sessionId: string): { changes: LanePositionChange[] } | null {
		const located = this.locateQueued(sessionId);
		if (!located) return null;
		const { lane, index } = located;
		const before = this.positionsOf(lane);
		lane.queue.splice(index, 1);
		this.sessionWorkspace.delete(sessionId);
		return { changes: this.diffPositions(before, lane) };
	}

	/** Record a prompt received while queued; delivered when the session starts. */
	addContextPrompt(sessionId: string, body: string): boolean {
		const located = this.locateQueued(sessionId);
		if (!located) return false;
		located.entry.contextPrompts.push(body);
		return true;
	}

	isActive(sessionId: string): boolean {
		const workspaceId = this.sessionWorkspace.get(sessionId);
		if (!workspaceId) return false;
		return (
			this.lanes.get(workspaceId)?.activeSessionIds.has(sessionId) ?? false
		);
	}

	isQueued(sessionId: string): boolean {
		return this.locateQueued(sessionId) !== null;
	}

	/** 1-based queue position, or null when not queued. */
	positionOf(sessionId: string): number | null {
		const located = this.locateQueued(sessionId);
		return located ? located.index + 1 : null;
	}

	workspaceOf(sessionId: string): string | undefined {
		return this.sessionWorkspace.get(sessionId);
	}

	/** Queued sessions belonging to an issue (for unassign/cancel cleanup). */
	queuedSessionIdsForIssue(issueId: string): string[] {
		const out: string[] = [];
		for (const lane of this.lanes.values()) {
			for (const entry of lane.queue) {
				if (entry.issueId === issueId) out.push(entry.sessionId);
			}
		}
		return out;
	}

	activeSessionOf(workspaceId: string): string | null {
		const [first] = this.lanes.get(workspaceId)?.activeSessionIds ?? [];
		return first ?? null;
	}

	/** Every session currently holding this lane. */
	activeSessionsOf(workspaceId: string): string[] {
		return Array.from(this.lanes.get(workspaceId)?.activeSessionIds ?? []);
	}

	/** How many sessions this workspace may run at once. Default 1. */
	private concurrencyOf(workspaceId: string): number {
		const n = this.workspaceConcurrency(workspaceId);
		return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
	}

	queueLength(workspaceId: string): number {
		return this.lanes.get(workspaceId)?.queue.length ?? 0;
	}

	/** Workspaces that currently have lane state (active or queued sessions). */
	workspaceIds(): string[] {
		return Array.from(this.lanes.keys());
	}

	setGraceDeadline(workspaceId: string, deadlineIso: string | null): void {
		if (deadlineIso === null) this.graceDeadlines.delete(workspaceId);
		else this.graceDeadlines.set(workspaceId, deadlineIso);
	}

	graceDeadlineOf(workspaceId: string): string | undefined {
		return this.graceDeadlines.get(workspaceId);
	}

	serialize(): Record<string, SerializedLaneState> {
		const out: Record<string, SerializedLaneState> = {};
		for (const [workspaceId, lane] of this.lanes) {
			if (lane.activeSessionIds.size === 0 && lane.queue.length === 0) continue;
			const active = Array.from(lane.activeSessionIds);
			out[workspaceId] = {
				// Written for rollback safety: a build that predates per-lane
				// concurrency reads only this field, and at the default N=1 it is
				// a complete description. Null when more than one session is held,
				// which such a build could not have represented anyway.
				activeSessionId: active.length === 1 ? (active[0] as string) : null,
				activeSessionIds: active,
				queue: lane.queue.map((e) => ({ ...e })),
			};
		}
		return out;
	}

	restore(state: Record<string, SerializedLaneState>): void {
		for (const [workspaceId, laneState] of Object.entries(state)) {
			// Prefer the multi-holder field; fall back to the legacy single slot so
			// state written before per-lane concurrency restores intact.
			const restoredActive =
				laneState.activeSessionIds ??
				(laneState.activeSessionId ? [laneState.activeSessionId] : []);
			const lane: LaneState = {
				activeSessionIds: new Set(restoredActive),
				queue: (laneState.queue ?? []).map((e) => ({
					...e,
					contextPrompts: e.contextPrompts ?? [],
					kind: e.kind ?? "created",
				})),
			};
			this.lanes.set(workspaceId, lane);
			for (const sessionId of lane.activeSessionIds) {
				this.sessionWorkspace.set(sessionId, workspaceId);
			}
			for (const entry of lane.queue) {
				this.sessionWorkspace.set(entry.sessionId, workspaceId);
			}
			this.logger.info(
				`Restored lane for workspace ${workspaceId}: active=${
					lane.activeSessionIds.size > 0
						? Array.from(lane.activeSessionIds).join(",")
						: "none"
				}, queued=${lane.queue.length}`,
			);
		}
	}

	/** Debug snapshot for the admin endpoint. Never includes webhook payloads. */
	snapshot(): Record<
		string,
		{
			enabled: boolean;
			/** First holder, kept for existing admin consumers. */
			activeSessionId: string | null;
			/** All current holders (PON-139). */
			activeSessionIds: string[];
			/** This workspace's concurrency limit. */
			concurrency: number;
			graceDeadline?: string;
			queue: Array<{
				position: number;
				sessionId: string;
				issueIdentifier?: string;
				enqueuedAt: string;
				contextPromptCount: number;
			}>;
		}
	> {
		const out: ReturnType<LaneManager["snapshot"]> = {};
		for (const [workspaceId, lane] of this.lanes) {
			out[workspaceId] = {
				enabled: this.isWorkspaceEnabled(workspaceId),
				activeSessionId: this.activeSessionOf(workspaceId),
				activeSessionIds: Array.from(lane.activeSessionIds),
				concurrency: this.concurrencyOf(workspaceId),
				...(this.graceDeadlines.has(workspaceId) && {
					graceDeadline: this.graceDeadlines.get(workspaceId),
				}),
				queue: lane.queue.map((e, i) => ({
					position: i + 1,
					sessionId: e.sessionId,
					issueIdentifier: e.issueIdentifier,
					enqueuedAt: e.enqueuedAt,
					contextPromptCount: e.contextPrompts.length,
				})),
			};
		}
		return out;
	}

	private locateQueued(
		sessionId: string,
	): { lane: LaneState; entry: LaneQueueEntry; index: number } | null {
		const workspaceId = this.sessionWorkspace.get(sessionId);
		if (!workspaceId) return null;
		const lane = this.lanes.get(workspaceId);
		if (!lane) return null;
		const index = lane.queue.findIndex((e) => e.sessionId === sessionId);
		if (index === -1) return null;
		return { lane, entry: lane.queue[index]!, index };
	}

	private positionsOf(lane: LaneState): Map<string, number> {
		return new Map(lane.queue.map((e, i) => [e.sessionId, i + 1]));
	}

	private diffPositions(
		before: Map<string, number>,
		lane: LaneState,
	): LanePositionChange[] {
		const changes: LanePositionChange[] = [];
		lane.queue.forEach((e, i) => {
			const newPosition = i + 1;
			if (before.get(e.sessionId) !== newPosition) {
				changes.push({ sessionId: e.sessionId, position: newPosition });
			}
		});
		return changes;
	}
}
