import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	CyrusAgentSession,
	CyrusAgentSessionEntry,
	IssueContext,
	IssueMinimal,
} from "./CyrusAgentSession.js";
import { createLogger, type ILogger } from "./logging/index.js";

/** Current persistence format version */
export const PERSISTENCE_VERSION = "4.0";

// Serialized versions with Date fields as strings
export type SerializedCyrusAgentSession = CyrusAgentSession;
// extends Omit<CyrusAgentSession, 'createdAt' | 'updatedAt'> {
//   createdAt: string
//   updatedAt: string
// }

export type SerializedCyrusAgentSessionEntry = CyrusAgentSessionEntry;
// extends Omit<CyrusAgentSessionEntry, 'metadata'> {
//   metadata?: Omit<CyrusAgentSessionEntry['metadata'], 'timestamp'> & {
//     timestamp?: string
//   }
// }

/**
 * v2.0 session format (for migration purposes)
 */
interface V2CyrusAgentSession {
	linearAgentActivitySessionId: string;
	type: string;
	status: string;
	context: string;
	createdAt: number;
	updatedAt: number;
	issueId: string;
	issue: IssueMinimal;
	workspace: {
		path: string;
		isGitWorktree: boolean;
		historyPath?: string;
	};
	claudeSessionId?: string;
	geminiSessionId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Serializable EdgeWorker state for persistence
 *
 * v4.0: Flat session format - sessions keyed directly by sessionId (no repo nesting)
 * v3.0: Nested format - sessions keyed by [repoId][sessionId]
 */
export interface SerializableEdgeWorkerState {
	// Agent Session state - flat map of sessionId → session (v4.0)
	agentSessions?: Record<string, SerializedCyrusAgentSession>;
	agentSessionEntries?: Record<string, SerializedCyrusAgentSessionEntry[]>;
	// Child to parent agent session mapping
	childToParentAgentSession?: Record<string, string>;
	// Issue to repository mapping (for caching user repository selections)
	// v4.1: string[] (multi-repo). Migration: old Record<string, string> auto-converts.
	issueRepositoryCache?: Record<string, string[]>;
	// Per-workspace serialized-lane state (v4.2, PON-112). Absent for state
	// saved by older versions and for installs with no lane-enabled workspace.
	lanes?: Record<string, SerializedLaneState>;
	// Per-issue scope approvals (v4.3, PON-150). Keyed by issue id — the
	// approval belongs to the issue, not to any one session. Absent for state
	// saved by older versions, which reads as "no gate pending" and is correct
	// for issues already in flight when the gate shipped.
	scopeApprovals?: Record<string, SerializedScopeApprovalRecord>;
	/** Open needs-info waits, keyed by issue id (PON-172, v4.8 additive) */
	needsInfo?: Record<string, SerializedNeedsInfoRecord>;
	// Operator-cockpit mirror map (v4.4, PON-151). Keyed by the CLIENT issue
	// id; the value names the mirror issue in the cockpit workspace. Derived
	// state only — boot reconciliation repairs it, never trusts it.
	cockpitMirrors?: Record<string, SerializedCockpitMirror>;
	// Verification gate (v4.5, PON-152). Keyed by client issue id: completed
	// work whose client-facing summary is held until the operator approves.
	// NEVER auto-released — a restart must restore these, not deliver them.
	pendingDeliveries?: Record<string, SerializedVerificationRecord>;
	/**
	 * Links held from the client while their work is in review (v4.12,
	 * PON-221). Keyed by session id.
	 *
	 * Persisted for the same reason `pendingDeliveries` is: the record that
	 * releases these survives a restart, so these have to as well. Without
	 * it, a deploy between "the agent opened the PR" and "Harold approved"
	 * would drop the links silently — the summary would reach the client with
	 * nothing to click, and nothing anywhere would say why.
	 */
	heldClientLinks?: Record<string, Array<{ url: string; label: string }>>;
	// Mention-session markers (v4.5, PON-151/152). A mention session
	// completing after a restart must still post conversationally, never be
	// held for verification or close a delegation's mirror.
	mentionSessionIds?: string[];
	/**
	 * Live operator sessions on cockpit mirrors (v4.11, PON-208).
	 *
	 * Restored rather than recomputed: the link is the only record that a
	 * given cockpit session is a working surface rather than a client one,
	 * and every exemption keys on it. Losing it across a restart would not
	 * fail loudly — it would quietly make Harold's next turn behave like a
	 * client session (quiet, gated, and billed to the cockpit's own tenant).
	 */
	operatorSessions?: SerializedOperatorSession[];
}

/**
 * One live operator session on a cockpit mirror (PON-208).
 *
 * The whole point is that the two workspace ids differ: the CLIENT's drives
 * credentials, git auth and content policy; the COCKPIT's is where the
 * activities post.
 */
export interface SerializedOperatorSession {
	/** The cockpit-side Linear agent session id — the SURFACE. */
	mirrorSessionId: string;
	/** The cockpit mirror issue the operator is working on. */
	mirrorIssueId: string;
	/** The client agent session whose conversation this one continues. */
	clientSessionId: string;
	/** The client issue — the SUBJECT of the work. */
	clientIssueId: string;
	clientIssueIdentifier?: string;
	/** Client workspace: credentials, git auth, content policy, lanes. */
	clientWorkspaceId: string;
	/** Cockpit workspace: where every activity from this session lands. */
	cockpitWorkspaceId: string;
	/** Repository the work happens in (the client's). */
	repositoryId: string;
	startedAt: string;
	/**
	 * Which human is driving this session (PON-211).
	 *
	 * The multi-reviewer seam, put in before there is a second reviewer. One
	 * agent identity serves every mirror today, so every turn reads as the
	 * app in Linear and nothing records who asked for it. That is fine right
	 * up until a second reviewer exists, at which point the history is
	 * already written and unattributable — this is the one part that cannot
	 * be backfilled, so it goes in now even though nothing reads it yet.
	 */
	reviewerId?: string;
	/**
	 * True while the OPERATOR holds the branch ("mine"): no session runs and
	 * the agent must not touch the working tree until a handback.
	 */
	operatorHoldsBranch?: boolean;
	/**
	 * This session owns the CLIENT's delivery (v4.15, PON-225).
	 *
	 * An operator session normally reports to the reviewer and its completion
	 * is deliberately exempt from the verification gate — holding it would
	 * mint a second pending delivery and overwrite the summary the client is
	 * owed. A session STARTED from a queued mirror is the opposite case: it
	 * is the client's implementation run, so its completion is the thing the
	 * gate exists to hold. This flag is that distinction, and nothing else
	 * about the session changes.
	 */
	ownsDelivery?: boolean;
}

/**
 * One completed-but-unapproved piece of work (PON-152).
 */
export interface SerializedVerificationRecord {
	state: "in-verification" | "delivered";
	/** When the work FIRST completed — the escalation ladder clock. */
	completedAt: string;
	workspaceId: string;
	issueIdentifier?: string;
	sessionId: string;
	/** The suppressed client-facing summary, delivered on approval. */
	summary: string;
	isError: boolean;
	/** GitHub PR links parsed from the summary (drafts to mark ready). */
	prUrls: string[];
	deliveredAt?: string;
	/** One-shot ladder bookkeeping */
	escalatedAt?: string;
	delayNotedAt?: string;
	/**
	 * The PR head SHA as of when `summary` was captured (v4.13, PON-210).
	 *
	 * The client's summary describes a specific state of the code. Review can
	 * move the code afterwards — operator iteration is exempt from the gate,
	 * so nothing refreshes the summary — and the client was then told about a
	 * version that is not what merges. Keeping the head the summary described
	 * is what makes that detectable at all.
	 *
	 * Cleared by `recordPending`: a new summary describes a head we have not
	 * looked up yet. Set by the mirror composition, which already fetches it.
	 */
	capturedHeadSha?: string;
	/**
	 * Whether the head lookup has been ATTEMPTED for this summary (v4.13).
	 *
	 * Separate from `capturedHeadSha` because a failed first lookup must not
	 * leave the slot open. The mirror recomposes on a 3-minute clock: if the
	 * GitHub call blips at capture time and a later tick fills the slot, the
	 * head recorded is the head as of THAT tick — which may already include
	 * the reviewer's commits, so the summary is stamped as describing work it
	 * never described and the staleness is erased by the act of looking.
	 * First attempt wins; a failed one leaves staleness permanently unknown,
	 * which degrades to today's behaviour rather than to a false negative.
	 */
	capturedHeadResolved?: boolean;
	/**
	 * The head the reviewer was last warned was stale (v4.13, PON-210).
	 *
	 * The escape hatch. A first `approve:` on a moved head refuses and asks
	 * for a rewrite; approving again while the head is unchanged delivers,
	 * because the reviewer has now seen the warning and chosen to proceed.
	 * Without this a delivery could wedge — and a gate that cannot be
	 * overridden by the human it reports to is a gate that gets worked around.
	 */
	staleNotifiedForSha?: string;
}

/**
 * One mirrored issue in the operator cockpit (PON-151).
 */
export interface SerializedCockpitMirror {
	/** The mirror issue's id in the cockpit workspace */
	mirrorIssueId: string;
	/** Tenant workspace the client issue lives in */
	tenantWorkspaceId: string;
	/** Last state written to the mirror (label name) */
	state: string;
	/** Client issue identifier, e.g. "DVV-12" (for re-rendering) */
	issueIdentifier?: string;
	/** Client issue URL (for re-rendering) */
	issueUrl?: string;
	/** Client issue title (for re-rendering) */
	title?: string;
	/**
	 * The client this work is for (PON-207, v4.10). Resolved from
	 * (workspace, team) at write time; stored so ordering can group by client
	 * without re-resolving, and so a mirror written before the client model
	 * existed is recognisable as needing adoption.
	 */
	clientId?: string;
	/** Team key within the client's workspace, e.g. "ACM". */
	teamKey?: string;
	/**
	 * Place in the cross-client queue of work waiting on a reviewer
	 * (PON-211), 1-based. Undefined when this mirror is not waiting — it is
	 * claimed, or the agent's/client's turn. Rank 1 is next up.
	 */
	queueRank?: number;
	/** Place within this client's own queue, 1-based (PON-211). */
	clientQueuePosition?: number;
	/**
	 * The mirror's own agent session (PON-212) — where the client-quiet
	 * narration is redirected so the operator can read what was done. Created
	 * with the mirror; absent on mirrors written before this existed.
	 */
	narrationSessionId?: string;
	/**
	 * Which version of the description renderer produced this mirror's body
	 * (PON-211). A mismatch means a release changed the rendering and this
	 * mirror is showing the old one — treated as a change so it refreshes.
	 */
	renderVersion?: number;
	/**
	 * The cockpit team the mirror issue actually lives in (PON-207).
	 *
	 * Recorded so that repointing the cockpit at a different team is a
	 * migration rather than a wedge: an issue cannot take a status from
	 * another team, so a mirror left behind in the old team must be replaced,
	 * not updated. Absent on records written before this existed — those are
	 * verified once, on first touch.
	 */
	mirrorTeamId?: string;
	/**
	 * The title last written to the mirror. Compared on update so a change of
	 * client label, team, or issue title re-titles the mirror — and so the
	 * old `[ACM-13] …` shape is detected and adopted rather than duplicated.
	 */
	mirrorTitle?: string;
	/**
	 * The session's internal reading (PON-169), rendered into the mirror
	 * description so the operator sees the approach before approving.
	 * Carried across state transitions; latest note wins.
	 */
	operatorNote?: string;
	/**
	 * Operator brief (PON-170), composed at scope approval: what the client
	 * approved, when, after how many revisions, plus PR/preview links as
	 * they become known. All carried across transitions like the note.
	 */
	clientScope?: string;
	approvedAt?: string;
	revisions?: number;
	briefLinks?: string[];
	/**
	 * When this mirror entered its current state, ISO (PON-221).
	 *
	 * The mirror's own clock, not the client issue's. Harold read "10 hours
	 * ago" on a mirror that was minutes old, because the only age on the
	 * board belonged to the client's issue — which had been open all night
	 * while its scope was being agreed. A mirror's age is the age of the
	 * review, and the review starts when the mirror does.
	 */
	stateSince?: string;
	/**
	 * Last round-robin rank written as the mirror's Linear sortOrder
	 * (PON-173) — cached so unchanged ranks skip the write.
	 */
	sortOrder?: number;
}

/**
 * One issue's scope-confirmation state (PON-150).
 *
 * `approvedAt` is the SLA clock start: the moment the client's structured
 * "Approve scope" answer arrived. It is written exactly once.
 */
/**
 * One issue's needs-info state (PON-172): a mid-work ask for client-side
 * inputs. Persisted so a restart cannot make a client-blocking wait
 * invisible; the answer resumes the same transcript through PON-164's
 * validated resume.
 */
export interface SerializedNeedsInfoRecord {
	state: "awaiting" | "answered";
	/** The question as asked (client-visible text, for the operator's view) */
	question: string;
	/** When the current ask was posted */
	askedAt: string;
	/** When the FIRST ask on this issue was posted (re-asks keep this) */
	firstAskedAt?: string;
	/** When the client responded */
	answeredAt?: string;
	/** Session that asked — the one the answer resumes */
	sessionId?: string;
	workspaceId?: string;
	issueIdentifier?: string;
}

export interface SerializedScopeApprovalRecord {
	state: "awaiting" | "approved" | "revised";
	/** When the scope reading's confirmation elicitation was first posted */
	proposedAt: string;
	/** When the client approved — the SLA clock start. Written once. */
	approvedAt?: string;
	/** How many times the client asked for a revised reading */
	revisions?: number;
	/** Linear workspace the issue lives in (for the queryable list) */
	workspaceId?: string;
	/** Human-readable issue identifier (for the queryable list) */
	issueIdentifier?: string;
	/**
	 * The internal reading recorded for the operator (PON-169): approach,
	 * files, risks, interpretations. Operator-side only — never posted on
	 * a tenant surface. Latest note replaces the previous one.
	 */
	operatorNote?: string;
	/** When the operator note was last recorded/replaced */
	operatorNoteAt?: string;
	/**
	 * The deliverable-framed scope text as posted to the client (PON-170):
	 * captured at proposal time so the operator brief can show what the
	 * client actually approved. Latest wins, like the note.
	 */
	clientScope?: string;
	/**
	 * The exact client-scope text last posted to the client thread by the
	 * machinery (PON-188, v4.9). Compared against `clientScope` to decide
	 * whether the scope still needs posting: a revision differs and re-posts,
	 * a replay matches and does not double-post.
	 */
	clientScopePosted?: string;
	/**
	 * What the client typed alongside their choice (v4.16, PON-230).
	 *
	 * Linear sends the option label and their own words as one body. Read as
	 * a whole string it matched no label at all, so the words were lost and
	 * the choice went uncounted. Kept because an approval carrying "and keep
	 * it simple" is an approval WITH a condition, and the operator brief is
	 * where that has to survive.
	 */
	clientReplyNote?: string;
	/**
	 * Scope approved but implementation deliberately not started (v4.14,
	 * PON-224): approved work parks as Queued in the cockpit until the
	 * reviewer delegates the mirror. Set at approval, cleared when
	 * implementation actually starts. Absent on records approved before
	 * v4.14 = implementation already ran under the old auto-start flow.
	 */
	implementationDeferred?: boolean;
}

/**
 * Serialized state of one workspace lane (PON-112).
 * The queue entry's `webhook` is the raw AgentSessionCreatedWebhook payload,
 * stored verbatim at enqueue time and replayed through the normal session
 * start path when the entry reaches the front of the queue.
 */
export interface SerializedLaneState {
	/**
	 * Legacy single-holder field. Still written when a lane holds at most one
	 * session, so that rolling back to a build which only understands this
	 * field does not strand a live lane. Read as a fallback when
	 * `activeSessionIds` is absent.
	 */
	activeSessionId: string | null;
	/**
	 * Sessions currently holding the lane (PON-139). A lane admits up to N,
	 * default 1. Absent in state written before per-lane concurrency existed.
	 */
	activeSessionIds?: string[];
	queue: Array<{
		sessionId: string;
		issueId?: string;
		issueIdentifier?: string;
		enqueuedAt: string;
		webhook: unknown;
		contextPrompts: string[];
		/**
		 * "created": webhook is an AgentSessionCreatedWebhook, replayed through
		 * the created flow. "resume": webhook is an AgentSessionPromptedWebhook
		 * for an existing (delivered) session, replayed through the prompted
		 * flow. Absent in pre-4.2 state — treated as "created".
		 */
		kind?: "created" | "resume";
	}>;
}

/**
 * v3.0 nested state format (for migration purposes)
 */
export interface V3SerializableEdgeWorkerState {
	agentSessions?: Record<string, Record<string, SerializedCyrusAgentSession>>;
	agentSessionEntries?: Record<
		string,
		Record<string, SerializedCyrusAgentSessionEntry[]>
	>;
	childToParentAgentSession?: Record<string, string>;
	issueRepositoryCache?: Record<string, string>;
}

/**
 * Manages persistence of critical mappings to survive restarts
 */
export class PersistenceManager {
	private persistencePath: string;
	private logger: ILogger;
	/** In-process save serialization — see saveEdgeWorkerState. */
	private saveChain: Promise<void> = Promise.resolve();

	constructor(persistencePath?: string, logger?: ILogger) {
		this.persistencePath =
			persistencePath || join(homedir(), ".cyrus", "state");
		this.logger = logger ?? createLogger({ component: "PersistenceManager" });
	}

	/**
	 * Get the full path to the single EdgeWorker state file
	 */
	private getEdgeWorkerStateFilePath(): string {
		return join(this.persistencePath, "edge-worker-state.json");
	}

	/**
	 * Ensure the persistence directory exists
	 */
	private async ensurePersistenceDirectory(): Promise<void> {
		await mkdir(this.persistencePath, { recursive: true });
	}

	/**
	 * Save EdgeWorker state to disk (single file for all repositories)
	 */
	async saveEdgeWorkerState(state: SerializableEdgeWorkerState): Promise<void> {
		// Serialize saves in-process AND write atomically (temp + rename).
		// This file carries every lane queue, session, and scope approval —
		// two concurrent plain writeFile calls can interleave into JSON that
		// loadEdgeWorkerState rejects, silently resetting ALL state at next
		// boot. Fire-and-forget writers (the cockpit mirror, PON-151) made
		// concurrent saves routine rather than exotic, so both protections
		// are load-bearing.
		const run = this.saveChain.then(async () => {
			await this.ensurePersistenceDirectory();
			const stateFile = this.getEdgeWorkerStateFilePath();
			const stateData = {
				version: PERSISTENCE_VERSION,
				savedAt: new Date().toISOString(),
				state,
			};
			const tempFile = `${stateFile}.tmp`;
			await writeFile(tempFile, JSON.stringify(stateData, null, 2), "utf8");
			await rename(tempFile, stateFile);
		});
		// The chain must survive a failed save; the caller still sees it.
		this.saveChain = run.catch(() => {});
		try {
			await run;
		} catch (error) {
			this.logger.error("Failed to save EdgeWorker state:", error);
			throw error;
		}
	}

	/**
	 * Load EdgeWorker state from disk (single file for all repositories)
	 * Automatically migrates from v2.0 to v3.0 format if needed.
	 */
	async loadEdgeWorkerState(): Promise<SerializableEdgeWorkerState | null> {
		try {
			const stateFile = this.getEdgeWorkerStateFilePath();
			if (!existsSync(stateFile)) {
				return null;
			}

			const stateData = JSON.parse(await readFile(stateFile, "utf8"));

			// Validate state structure exists
			if (!stateData.state) {
				this.logger.warn("Invalid state file (missing state), ignoring");
				return null;
			}

			// Handle version migration
			if (stateData.version === "2.0") {
				this.logger.info("Migrating state from v2.0 to v3.0 to v4.0");
				const v3State = this.migrateV2ToV3(stateData.state);
				const migratedState = this.migrateV3ToV4(v3State);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version === "3.0") {
				this.logger.info("Migrating state from v3.0 to v4.0");
				const migratedState = this.migrateV3ToV4(
					stateData.state as V3SerializableEdgeWorkerState,
				);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version !== PERSISTENCE_VERSION) {
				this.logger.warn(
					`Unknown state file version ${stateData.version}, ignoring`,
				);
				return null;
			}

			return stateData.state;
		} catch (error) {
			this.logger.error("Failed to load EdgeWorker state:", error);
			return null;
		}
	}

	/**
	 * Migrate v2.0 state format to v3.0 format
	 *
	 * Changes:
	 * - linearAgentActivitySessionId -> id
	 * - Add externalSessionId (set to original linearAgentActivitySessionId for Linear sessions)
	 * - Add issueContext object with trackerId, issueId, issueIdentifier
	 * - issueId becomes optional (kept for backwards compatibility)
	 * - issue becomes optional
	 */
	private migrateV2ToV3(
		v2State: V3SerializableEdgeWorkerState,
	): V3SerializableEdgeWorkerState {
		const migratedState: V3SerializableEdgeWorkerState = {
			...v2State,
			agentSessions: {},
		};

		// Migrate agent sessions
		if (v2State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v2State.agentSessions,
			)) {
				migratedState.agentSessions![repoId] = {};
				for (const [_sessionId, v2Session] of Object.entries(repoSessions)) {
					const session = v2Session as unknown as V2CyrusAgentSession;
					const migratedSession = this.migrateSessionV2ToV3(session);
					// Use the new id as the key
					migratedState.agentSessions![repoId][migratedSession.id] =
						migratedSession;
				}
			}
		}

		// agentSessionEntries keys need to be updated to use new session IDs
		// Since linearAgentActivitySessionId becomes id, the keys remain the same
		// The entries themselves don't need modification

		return migratedState;
	}

	/**
	 * Migrate v3.0 state format to v4.0 format
	 *
	 * Changes:
	 * - Flatten nested {[repoId]: {[sessionId]: session}} to flat {[sessionId]: session}
	 * - Flatten nested entries similarly
	 */
	private migrateV3ToV4(
		v3State: V3SerializableEdgeWorkerState,
	): SerializableEdgeWorkerState {
		const flatSessions: Record<string, SerializedCyrusAgentSession> = {};
		const flatEntries: Record<string, SerializedCyrusAgentSessionEntry[]> = {};

		// Flatten sessions: merge all repo-keyed sessions into a single flat map
		// Preserve the repoId key as a RepositoryContext so migrated sessions
		// know which repository they belong to (instead of defaulting to [])
		if (v3State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v3State.agentSessions,
			)) {
				for (const [sessionId, session] of Object.entries(repoSessions)) {
					if (!session.repositories?.length) {
						session.repositories = [
							{
								repositoryId: repoId,
							},
						];
					}
					flatSessions[sessionId] = session;
				}
			}
		}

		// Flatten entries similarly
		if (v3State.agentSessionEntries) {
			for (const repoEntries of Object.values(v3State.agentSessionEntries)) {
				for (const [sessionId, entries] of Object.entries(repoEntries)) {
					flatEntries[sessionId] = entries;
				}
			}
		}

		// Migrate issueRepositoryCache from old Record<string, string> to Record<string, string[]>
		let migratedCache: Record<string, string[]> | undefined;
		if (v3State.issueRepositoryCache) {
			migratedCache = {};
			for (const [issueId, repoId] of Object.entries(
				v3State.issueRepositoryCache,
			)) {
				migratedCache[issueId] = [repoId];
			}
		}

		return {
			agentSessions: flatSessions,
			agentSessionEntries: flatEntries,
			childToParentAgentSession: v3State.childToParentAgentSession,
			issueRepositoryCache: migratedCache,
		};
	}

	/**
	 * Migrate a single session from v2.0 to v3.0 format
	 */
	private migrateSessionV2ToV3(
		v2Session: V2CyrusAgentSession,
	): SerializedCyrusAgentSession {
		// Build issueContext from v2.0 fields
		const issueContext: IssueContext = {
			trackerId: "linear", // v2.0 only supported Linear
			issueId: v2Session.issueId,
			issueIdentifier: v2Session.issue?.identifier || v2Session.issueId,
		};

		return {
			// New field: rename linearAgentActivitySessionId to id
			id: v2Session.linearAgentActivitySessionId,
			// New field: store the original Linear session ID as externalSessionId
			externalSessionId: v2Session.linearAgentActivitySessionId,
			// Preserved fields
			type: v2Session.type,
			status: v2Session.status,
			context: v2Session.context,
			createdAt: v2Session.createdAt,
			updatedAt: v2Session.updatedAt,
			workspace: v2Session.workspace,
			claudeSessionId: v2Session.claudeSessionId,
			geminiSessionId: v2Session.geminiSessionId,
			metadata: v2Session.metadata,
			// New field: structured issue context
			issueContext,
			// Kept for backwards compatibility (marked as deprecated in interface)
			issueId: v2Session.issueId,
			// Now optional
			issue: v2Session.issue,
			// New field: empty repositories for migrated sessions
			repositories: [],
		} as SerializedCyrusAgentSession;
	}

	/**
	 * Check if EdgeWorker state file exists
	 */
	hasStateFile(): boolean {
		return existsSync(this.getEdgeWorkerStateFilePath());
	}

	/**
	 * Delete EdgeWorker state file
	 */
	async deleteStateFile(): Promise<void> {
		try {
			const stateFile = this.getEdgeWorkerStateFilePath();
			if (existsSync(stateFile)) {
				await writeFile(stateFile, "", "utf8"); // Clear file instead of deleting
			}
		} catch (error) {
			this.logger.error("Failed to delete EdgeWorker state file:", error);
		}
	}

	/**
	 * Convert Map to Record for serialization
	 */
	static mapToRecord<T>(map: Map<string, T>): Record<string, T> {
		return Object.fromEntries(map.entries());
	}

	/**
	 * Convert Record to Map for deserialization
	 */
	static recordToMap<T>(record: Record<string, T>): Map<string, T> {
		return new Map(Object.entries(record));
	}

	/**
	 * Convert Set to Array for serialization
	 */
	static setToArray<T>(set: Set<T>): T[] {
		return Array.from(set);
	}

	/**
	 * Convert Array to Set for deserialization
	 */
	static arrayToSet<T>(array: T[]): Set<T> {
		return new Set(array);
	}
}
