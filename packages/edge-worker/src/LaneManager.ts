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
	activeSessionId: string | null;
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
	private logger: ILogger;

	constructor(
		isWorkspaceEnabled: (workspaceId: string) => boolean,
		logger?: ILogger,
	) {
		this.isWorkspaceEnabled = isWorkspaceEnabled;
		this.logger = logger ?? createLogger({ component: "LaneManager" });
	}

	isEnabled(workspaceId: string): boolean {
		return this.isWorkspaceEnabled(workspaceId);
	}

	private lane(workspaceId: string): LaneState {
		let lane = this.lanes.get(workspaceId);
		if (!lane) {
			lane = { activeSessionId: null, queue: [] };
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
		if (lane.activeSessionId === sessionId) return true;
		if (lane.activeSessionId !== null) return false;
		lane.activeSessionId = sessionId;
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
		if (!lane || lane.activeSessionId !== sessionId) return false;
		lane.activeSessionId = null;
		this.sessionWorkspace.delete(sessionId);
		this.graceDeadlines.delete(workspaceId);
		return true;
	}

	/**
	 * Dequeue the head entry and mark it active. Returns null when the queue
	 * is empty or the lane is still held.
	 */
	takeNext(workspaceId: string): LaneQueueEntry | null {
		const lane = this.lanes.get(workspaceId);
		if (!lane || lane.activeSessionId !== null) return null;
		const next = lane.queue.shift();
		if (!next) return null;
		lane.activeSessionId = next.sessionId;
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
		return this.lanes.get(workspaceId)?.activeSessionId === sessionId;
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
		return this.lanes.get(workspaceId)?.activeSessionId ?? null;
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
			if (lane.activeSessionId === null && lane.queue.length === 0) continue;
			out[workspaceId] = {
				activeSessionId: lane.activeSessionId,
				queue: lane.queue.map((e) => ({ ...e })),
			};
		}
		return out;
	}

	restore(state: Record<string, SerializedLaneState>): void {
		for (const [workspaceId, laneState] of Object.entries(state)) {
			const lane: LaneState = {
				activeSessionId: laneState.activeSessionId ?? null,
				queue: (laneState.queue ?? []).map((e) => ({
					...e,
					contextPrompts: e.contextPrompts ?? [],
					kind: e.kind ?? "created",
				})),
			};
			this.lanes.set(workspaceId, lane);
			if (lane.activeSessionId) {
				this.sessionWorkspace.set(lane.activeSessionId, workspaceId);
			}
			for (const entry of lane.queue) {
				this.sessionWorkspace.set(entry.sessionId, workspaceId);
			}
			this.logger.info(
				`Restored lane for workspace ${workspaceId}: active=${lane.activeSessionId ?? "none"}, queued=${lane.queue.length}`,
			);
		}
	}

	/** Debug snapshot for the admin endpoint. Never includes webhook payloads. */
	snapshot(): Record<
		string,
		{
			enabled: boolean;
			activeSessionId: string | null;
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
				activeSessionId: lane.activeSessionId,
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
