/**
 * Operator cockpit (PON-151): mirror every delegated issue from tenant
 * workspaces into one Linear team/project the operator already looks at.
 *
 * Two rules contain the cost of duplicated state:
 *   1. The mirror is DERIVED, never a source of truth. This module only
 *      writes; nothing anywhere reads a mirror to make a decision.
 *   2. Boot reconciliation repairs drift rather than preserving it.
 *
 * The module is deliberately self-contained: it talks Linear GraphQL directly
 * with the cockpit workspace's token, touching none of the client-path
 * services. Every public method catches and logs — a broken mirror must never
 * break a client session — and every write happens in the COCKPIT workspace
 * only, never in a tenant's.
 */

import type { ILogger, SerializedCockpitMirror } from "cyrus-core";
import {
	buildMirrorTitle,
	type ResolvedClient,
	teamKeyOf,
} from "./client-registry.js";
import { computeRoundRobinOrder, stateRankOf } from "./operator-ordering.js";

/** The mirror's state labels, from the PON-151 design table. */
export const COCKPIT_STATES = [
	"queued",
	"active",
	"needs-info",
	"in-verification",
	// PON-233: the client has it. Distinct from in-verification, which is
	// the REVIEWER's hold — these look the same on a board and mean opposite
	// things about whose move it is.
	"in-client-review",
	// A delivered piece of work the client asked to change. It re-enters at
	// the head of the order rather than the back of the queue.
	"rework",
	"delivered",
] as const;
export type CockpitState = (typeof COCKPIT_STATES)[number];

/**
 * The lifecycle as WORKFLOW STATUSES (PON-207).
 *
 * Labels could never be board columns, so state was invisible until you
 * opened an issue. Statuses are the columns. The names are what the operator
 * reads across the top of the board, so they are written for a human rather
 * than matching our internal keys.
 *
 * Adopted by name, never created: workflow statuses are per-team, and the
 * cockpit team is the operator's to shape. A missing set degrades to labels
 * rather than failing, and says exactly what to create.
 */
export const COCKPIT_STATUS_NAMES: Record<CockpitState, string> = {
	queued: "Queued",
	active: "Active",
	"needs-info": "Needs info",
	"in-verification": "In verification",
	"in-client-review": "In client review",
	rework: "Rework",
	delivered: "Delivered",
};

/** What the mirror needs to know about a client issue. */
export interface CockpitIssueRef {
	issueId: string;
	issueIdentifier?: string;
	title?: string;
	url?: string;
}

export interface CockpitMirrorDeps {
	/** Current cockpit config — read live so hot-reload applies. */
	getConfig: () =>
		| {
				linearWorkspaceId: string;
				workspaceName: string;
				teamId: string;
				projectId?: string;
		  }
		| undefined;
	/** Linear token for a workspace — the cockpit workspace's token writes. */
	getToken: (workspaceId: string) => string | undefined;
	/** Human-readable tenant workspace name, for the mirror description. */
	getWorkspaceName: (workspaceId: string) => string | undefined;
	/**
	 * Which client this work is for (PON-207). Resolved per call so a config
	 * hot-reload takes effect without restarting anything.
	 */
	resolveClient: (workspaceId: string, teamKey?: string) => ResolvedClient;
	/**
	 * Is this issue still inside its scope conversation? (PON-219)
	 *
	 * The cockpit contains only APPROVED work. Before the client approves,
	 * the scope conversation belongs to them and the agent alone, and nothing
	 * about it belongs in the operator's queue.
	 *
	 * This is a dependency rather than a check at each call site because
	 * `upsert` has a dozen callers and any future one would have to remember.
	 * An invariant with twelve enforcement points is twelve chances to lose
	 * it; here it is one, and it cannot be forgotten by construction.
	 *
	 * Absent (or false) means no gate applies — an ungated workspace has no
	 * approval to wait for, so its mirrors are created at delegation exactly
	 * as before.
	 */
	scopeGatePending?: (tenantWorkspaceId: string, issueId: string) => boolean;
	/** Persist EdgeWorker state (best-effort; failures already logged). */
	persist: () => Promise<void>;
}

interface TeamSetup {
	labelIds: Record<string, string>;
	completedStateId: string | undefined;
	/** The team's canceled status, so an abandoned issue does not read as shipped. */
	canceledStateId: string | undefined;
	/**
	 * Lifecycle status ids by state, when the cockpit team defines all six
	 * (PON-207). Undefined means the team has not been set up yet and the
	 * mirror falls back to labels — the pre-PON-207 behaviour.
	 */
	stateIds?: Record<CockpitState, string>;
	/** Team-identity labels (`team:ACM`), created lazily like state labels. */
	teamLabelIds: Record<string, string>;
}

/**
 * Closes that mean "this was discarded", not "this finished" (PON-219).
 *
 * The client's own issue state answers this whenever it is terminal. These
 * are the closes where it is NOT: the work was abandoned, superseded, or
 * reconciled away while the client's issue is still open. Defaulting those to
 * the completed state put "Delivered" on the operator's board for work nobody
 * did — caught live on CKP-11, where an unapproved mirror was reconciled away
 * and read as shipped.
 *
 * Everything not listed here is a genuine end of work and still closes as
 * completed, so an ungated workspace — where a session simply ending is how
 * work finishes — is unchanged.
 */
const DISCARD_REASONS = new Set([
	"reconciled",
	"not_started",
	"unassigned",
	"stopped_while_queued",
	"scope_canceled",
]);

/** How long a failed team setup stays failed before another attempt. */
const SETUP_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Mirror titles, old and new. Reconcile adopts and closes by this.
 *
 * Old (pre-PON-207): `[DVV-12] Title`
 * New:               `Acme Corp · DVV-12 — Title`, or with a team segment
 *                    `Acme Corp · ACMOPS · ACMOPS-4 — Title`
 *
 * Both are recognised, and must stay recognised: a boot that stopped
 * recognising the old shape would treat every existing mirror as an orphan
 * and close live work.
 */
const MIRROR_TITLE_PATTERN =
	/^\[([A-Z][A-Z0-9]*-\d+)\]\s|·\s([A-Z][A-Z0-9]*-\d+)\s—\s/;

/**
 * Does this issue look like a cockpit mirror (PON-211)?
 *
 * Used by any instance that finds itself holding an issue it cannot route, to
 * tell "a client issue I have no repository for" apart from "someone else's
 * derived view that was never addressed to me". The two need opposite
 * answers: the first is a real question for the operator, the second is a
 * misdelegation and asking about it is noise.
 *
 * Title shape only — deliberately. An instance that is not the cockpit's
 * owner has no mirror map to consult and no business reading the issue body
 * of a team it does not serve.
 */
/**
 * States where the mirror is waiting on a REVIEWER rather than on the agent
 * or the client. Only these queue — "active" is the agent's turn and
 * and an unapproved scope conversation is not a mirror at all (PON-219).
 */
const WAITING_STATES = new Set([
	"in-verification",
	"needs-info",
	// PON-233: queued belongs here now. Since PON-224 the reviewer is the one
	// who STARTS a parked mirror, so approved work waiting to be picked up is
	// waiting on them — and until this it never rendered "▶ Next up", which
	// is the one line that says what to take.
	"queued",
	// A change the client asked for is waiting on the reviewer too.
	"rework",
	// Deliberately NOT "in-client-review": the client holds it, and offering
	// it as next-up would point the reviewer at work that is not theirs.
]);

/**
 * Bumped whenever `renderDescription` changes what it produces (PON-211).
 *
 * The mirror body is derived, and a mirror only rewrites when its state
 * changes — so without this, a release that changes the rendering leaves every
 * existing mirror showing the old body until its work happens to move. Bump it
 * in the same commit as any rendering change.
 */
// Bumped to 4 for PON-221: the state line now carries the mirror's own age,
// the client-issue line no longer promises links that are held, and the
// preview renders as an anchor. Mirrors written by the previous release
// refresh themselves on first touch rather than showing the old wording.
const DESCRIPTION_VERSION = 6;
/** Bumped when the label shape changes; mirrors below it get their labels rewritten. */
const LABELS_VERSION = 1;
/** The one queued mirror to start next. */
const NEXT_UP_LABEL = "next-up";

/**
 * A duration in the reviewer's words (PON-221).
 *
 * Coarse on purpose. The mirror's body is rewritten on transitions and on a
 * refresh clock, and a value that changes every second would make every
 * render a diff; minutes are the finest granularity anyone reviewing work
 * acts on. Reads as an age — "held 2h 5m" — never as a timestamp.
 */
/**
 * A stored state without its queue-position suffix (`queued (#3)` → `queued`).
 *
 * The position is a rendering detail that changes every time the work ahead
 * drains. Comparing states WITH it made "#3 becomes #2" look like a
 * transition — which restarted the mirror's age, so a mirror queued for hours
 * read "for just now" precisely as it neared the front. `setOperatorNote`
 * re-upserts on the bare state and hit the same edge from the other side.
 */
export function bareCockpitState(state: string | undefined): string {
	return (state ?? "").replace(/\s*\(#\d+\)\s*$/, "");
}

export function formatMirrorAge(fromIso: string, nowMs: number): string {
	const started = Date.parse(fromIso);
	if (Number.isNaN(started)) return "";
	const ms = nowMs - started;
	if (ms < 0) return "just now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24)
		return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

export function isForeignCockpitMirror(title: string | undefined): boolean {
	return MIRROR_TITLE_PATTERN.test(title ?? "");
}

export class CockpitMirror {
	private deps: CockpitMirrorDeps;
	private logger: ILogger;
	private mirrors = new Map<string, SerializedCockpitMirror>();
	/** Lazy per-team setup (labels + Done state), keyed by teamId. */
	private setupByTeam = new Map<string, Promise<TeamSetup | undefined>>();
	/** Failed-setup cooldown per team — no per-event retry storms. */
	private setupFailedAt = new Map<string, number>();
	/** The last misconfiguration logged, so the loud warning fires once. */
	private lastMisconfigLogged: string | undefined;
	/** The last team told it has no lifecycle columns — logged once. */
	private lastStatusSetupLogged: string | undefined;
	/**
	 * Per-issue write chain: transitions for one issue apply in order, so a
	 * fast active→done cannot be overtaken by a slower queued update.
	 */
	private writeChains = new Map<string, Promise<void>>();

	constructor(deps: CockpitMirrorDeps, logger: ILogger) {
		this.deps = deps;
		this.logger = logger;
	}

	/** Mirroring is on only when configured AND the cockpit token exists. */
	private configFor(tenantWorkspaceId: string):
		| {
				linearWorkspaceId: string;
				workspaceName: string;
				teamId: string;
				projectId?: string;
		  }
		| undefined {
		const config = this.guardedConfig();
		if (!config) return undefined;
		// Never mirror the cockpit's own workspace: the operator already
		// lives there, and self-mirroring doubles every issue.
		if (tenantWorkspaceId === config.linearWorkspaceId) return undefined;
		return config;
	}

	/** The declared config, misconfiguration-guarded, token verified. */
	private guardedConfig():
		| {
				linearWorkspaceId: string;
				workspaceName: string;
				teamId: string;
				projectId?: string;
		  }
		| undefined {
		const config = this.deps.getConfig();
		if (!config) return undefined;
		// PON-207: the cross-tenant guard keys on IDS, not names.
		//
		// The danger it exists for is a copied-wrong workspace id — client
		// ids sit right next to the operator's in the same map — which would
		// write our cross-tenant view into a client's Linear. An id that is
		// not a configured workspace, or that has no token, cannot be written
		// to, and that is the check that matters.
		//
		// The declared NAME is now advisory. Keying the kill switch on it
		// meant a client renaming their workspace disabled the operator's
		// whole view, which punishes us for something only they control.
		const actualName = this.deps.getWorkspaceName(config.linearWorkspaceId);
		if (actualName === undefined) {
			const key = `unknown:${config.linearWorkspaceId}`;
			if (this.lastMisconfigLogged !== key) {
				this.lastMisconfigLogged = key;
				this.logger.error(
					`[event:cockpit_disabled_misconfigured] cockpit.linearWorkspaceId ${config.linearWorkspaceId} is not a configured workspace — mirroring is DISABLED until it names one`,
				);
			}
			return undefined;
		}
		if (config.workspaceName && actualName !== config.workspaceName) {
			const key = `renamed:${config.linearWorkspaceId}:${actualName}`;
			if (this.lastMisconfigLogged !== key) {
				this.lastMisconfigLogged = key;
				this.logger.warn(
					`[event:cockpit_workspace_renamed] cockpit.workspaceName says "${config.workspaceName}" but the workspace is now "${actualName}" — mirroring continues on the id; update the declaration when convenient`,
				);
			}
		}
		if (!this.deps.getToken(config.linearWorkspaceId)) return undefined;
		return config;
	}

	/**
	 * Create or update the mirror for a client issue. Fire-and-forget from
	 * the caller's perspective; never throws.
	 */
	upsert(
		issue: CockpitIssueRef,
		tenantWorkspaceId: string,
		state: CockpitState,
		detail?: {
			position?: number;
			/**
			 * Who to NOTIFY (PON-211). Subscribers, not assignee.
			 *
			 * This used to stamp `assigneeId`, which quietly made claiming
			 * impossible: the stamp was re-applied on every transition, so a
			 * reviewer who assigned themselves had it reverted at the next
			 * state change with no error. Linear already separates the two —
			 * assignee is the human who owns the work, subscribers are who
			 * hears about it — and "you are automatically subscribed to issues
			 * assigned to you" means a real claim keeps its notifications.
			 *
			 * So the mirror notifies and never claims. Claiming is a human act
			 * and nothing here undoes it.
			 */
			subscriberIds?: string[];
			/**
			 * The agent working this mirror right now, or null to clear it.
			 * Linear's own delegate field: "the assignee remains responsible
			 * while the agent contributes on their behalf".
			 */
			delegateId?: string | null;
			/** Extra description body (the held summary, PR links) */
			note?: string;
			/**
			 * The session's internal reading (PON-169). Unlike `note`, this is
			 * stored on the record and carried across every later transition.
			 */
			operatorNote?: string;
			/**
			 * Operator-brief fields (PON-170), merged into the record: scalars
			 * overwrite when provided, `addLinks` unions. Carried across every
			 * later transition like the operator note.
			 */
			brief?: {
				clientScope?: string;
				approvedAt?: string;
				revisions?: number;
				addLinks?: string[];
			};
		},
	): Promise<void> {
		return this.chain(issue.issueId, async () => {
			const config = this.configFor(tenantWorkspaceId);
			if (!config) return;
			const setup = await this.ensureTeamSetup(config);
			if (!setup) return;

			// PON-207: who this work is FOR. Resolved per write so a config
			// hot-reload lands without a restart.
			const teamKey = teamKeyOf(issue.issueIdentifier);
			await this.resolveAgentHandle(config.linearWorkspaceId);
			const client = this.deps.resolveClient(tenantWorkspaceId, teamKey);

			const existing = this.mirrors.get(issue.issueId);

			// PON-219: only approved work reaches the cockpit.
			//
			// Deliberately gates CREATION, not updates. Once an issue has been
			// approved and mirrored, later transitions must keep landing even
			// if the scope record is revised or removed — a mirror that stopped
			// updating would be worse than one that never appeared, because the
			// operator would be reading a stale board and not know it.
			if (
				!existing?.mirrorIssueId &&
				this.deps.scopeGatePending?.(tenantWorkspaceId, issue.issueId)
			) {
				// One exception, and it is the important one. `in-verification`
				// means a session finished work and it is being HELD — so if
				// that arrives while the scope is still unapproved, the gate
				// has been bypassed. The gate is intrinsic (a prompt step), so
				// a model can end its turn without it; withholding here would
				// hide a real violation behind a rule meant to reduce noise.
				// Unapproved work that exists is exactly what an operator has
				// to see.
				if (state === "in-verification") {
					this.logger.warn(
						`[event:cockpit_unapproved_work_held] ${JSON.stringify({
							issueIdentifier: issue.issueIdentifier,
							note: "work reached verification without an approved scope",
						})}`,
					);
				} else {
					this.logger.info(
						`[event:cockpit_creation_withheld] ${JSON.stringify({
							issueIdentifier: issue.issueIdentifier,
							state,
							reason: "scope_not_approved",
						})}`,
					);
					return;
				}
			}

			const mergedLinks = [
				...new Set([
					...(existing?.briefLinks ?? []),
					...(detail?.brief?.addLinks ?? []),
				]),
			];
			// The state exactly as it will be stored, position suffix and all.
			// `stateSince` compares against THIS: comparing against the bare
			// state would restart the mirror's clock on every re-rank, which
			// is the opposite of what an age is for.
			const nextState =
				detail?.position !== undefined
					? `${state} (#${detail.position})`
					: state;
			const record: SerializedCockpitMirror = {
				mirrorIssueId: existing?.mirrorIssueId ?? "",
				renderVersion: DESCRIPTION_VERSION,
				queueRank: existing?.queueRank,
				...(existing?.narrationSessionId
					? { narrationSessionId: existing.narrationSessionId }
					: {}),
				clientQueuePosition: existing?.clientQueuePosition,
				tenantWorkspaceId,
				state: nextState,
				issueIdentifier: issue.issueIdentifier ?? existing?.issueIdentifier,
				issueUrl: issue.url ?? existing?.issueUrl,
				title: issue.title ?? existing?.title,
				clientId: client.id,
				...(teamKey ? { teamKey } : {}),
				...((detail?.operatorNote ?? existing?.operatorNote) !== undefined
					? { operatorNote: detail?.operatorNote ?? existing?.operatorNote }
					: {}),
				...((detail?.brief?.clientScope ?? existing?.clientScope) !== undefined
					? {
							clientScope: detail?.brief?.clientScope ?? existing?.clientScope,
						}
					: {}),
				...((detail?.brief?.approvedAt ?? existing?.approvedAt) !== undefined
					? { approvedAt: detail?.brief?.approvedAt ?? existing?.approvedAt }
					: {}),
				...((detail?.brief?.revisions ?? existing?.revisions) !== undefined
					? { revisions: detail?.brief?.revisions ?? existing?.revisions }
					: {}),
				...(mergedLinks.length ? { briefLinks: mergedLinks } : {}),
				// PON-221: the mirror's own clock. Preserved while the state
				// is unchanged so a re-render (a refresh tick, a renderer
				// bump) never resets the age; restarted the moment the work
				// actually moves. A mirror restored without one adopts now —
				// understating an age is honest, inventing one is not.
				// Compared on the BARE state: a re-rank (#3 → #2) and an
				// operator note both rewrite the record without the work
				// having moved, and neither is a new state to start counting
				// from.
				stateSince:
					existing &&
					bareCockpitState(existing.state) === bareCockpitState(nextState)
						? (existing.stateSince ?? new Date().toISOString())
						: new Date().toISOString(),
			};
			const description =
				this.renderDescription(record, tenantWorkspaceId) +
				(detail?.note ? `\n\n${detail.note}` : "");
			// v3.1 (Harold): statuses are the state; labels only for what is
			// not a state — the tenant, and the single next-up marker.
			const labelIds = await this.markerLabelIds(config, client.id, record);
			record.labelsVersion = LABELS_VERSION;
			// PON-207: the lifecycle is a board column when the team defines
			// the statuses; labels stay alongside so a half-migrated cockpit
			// still filters and nothing is lost if the statuses go away.
			const stateId = setup.stateIds?.[state];
			const lifecycle = stateId ? { stateId } : {};
			// PON-211: the mirror NEVER writes assigneeId. That field is the
			// reviewer's claim now, and a derived view does not get to
			// overwrite a human's decision — least of all silently, on an
			// unrelated state change.
			const notify = detail?.subscriberIds?.length
				? { subscriberIds: detail.subscriberIds }
				: {};
			const delegate =
				detail?.delegateId !== undefined
					? { delegateId: detail.delegateId }
					: {};
			// One project per client: the swim lane.
			const projectId = client.cockpitProjectId ?? config.projectId;
			const project = projectId ? { projectId } : {};
			const mirrorTitle = buildMirrorTitle({
				client,
				issueIdentifier: record.issueIdentifier,
				teamKey,
				title: record.title,
			});

			// PON-207: a mirror in ANOTHER team cannot be updated — Linear
			// refuses a status from a different team, and rightly. This is
			// what repointing the cockpit looks like from here: the old
			// mirror stays where it is as history, and the work gets a fresh
			// one in the team the operator now uses.
			const usableExisting =
				existing?.mirrorIssueId &&
				(await this.mirrorLivesInTeam(existing, config))
					? existing
					: undefined;
			if (usableExisting?.mirrorIssueId) {
				const existing = usableExisting;
				// v3.1 (Harold's requirement A): no narration thread, ever. A
				// mirror carries ZERO sessions until the reviewer delegates; the
				// delegation creates the one implementation thread. Legacy
				// mirrors keep their recorded narrationSessionId untouched and
				// nothing posts to it any more.
				const noteChanged =
					detail?.operatorNote !== undefined &&
					detail.operatorNote !== existing.operatorNote;
				const briefChanged =
					record.clientScope !== existing.clientScope ||
					record.approvedAt !== existing.approvedAt ||
					record.revisions !== existing.revisions ||
					(record.briefLinks?.length ?? 0) !==
						(existing.briefLinks?.length ?? 0);
				// PON-207: a mirror written before the client model exists has
				// the old title and no project. Adoption is just a normal
				// update with the new shape, so migration needs no separate
				// pass and cannot create a duplicate.
				// PON-211: the queue position is rendered into the body, so it
				// has to count as a change like any other.
				const positionChanged =
					existing.queueRank !== record.queueRank ||
					existing.clientQueuePosition !== record.clientQueuePosition;
				// The description is DERIVED, so a deploy that changes how it
				// renders leaves every existing mirror stale — and, since a
				// mirror only rewrites on a state change, stale until the work
				// happens to move. Observed live: mirrors shipped without the
				// "work this with @…" line the release added, on exactly the
				// issues an operator was about to pick up. A render-version
				// stamp makes a rendering change behave like any other change.
				const renderChanged = existing.renderVersion !== DESCRIPTION_VERSION;
				const shapeChanged =
					existing.clientId !== record.clientId ||
					existing.mirrorTitle !== mirrorTitle ||
					positionChanged ||
					renderChanged;
				if (
					existing.state === record.state &&
					!detail?.note &&
					!noteChanged &&
					!briefChanged &&
					!shapeChanged
				)
					return; // nothing changed
				await this.gql(
					config.linearWorkspaceId,
					`mutation($id: String!, $input: IssueUpdateInput!) {
						issueUpdate(id: $id, input: $input) { success }
					}`,
					{
						id: existing.mirrorIssueId,
						input: {
							title: mirrorTitle,
							description,
							labelIds,
							...lifecycle,
							...project,
							...notify,
							...delegate,
						},
					},
				);
				record.mirrorTitle = mirrorTitle;
				record.mirrorTeamId = config.teamId;
				this.mirrors.set(issue.issueId, record);
			} else {
				const created = await this.gql<{
					issueCreate: { success: boolean; issue: { id: string } };
				}>(
					config.linearWorkspaceId,
					`mutation($input: IssueCreateInput!) {
						issueCreate(input: $input) { success issue { id } }
					}`,
					{
						input: {
							teamId: config.teamId,
							...project,
							title: mirrorTitle,
							description,
							labelIds,
							...lifecycle,
							...notify,
							...delegate,
						},
					},
				);
				record.mirrorIssueId = created.issueCreate.issue.id;
				// v3.1: no thread at birth. An app-created issue with no delegate
				// gets no agent session from Linear (probed live on CKP-26,
				// 2026-09-01), so the mirror sits at zero sessions until the
				// reviewer delegates it.
				record.mirrorTitle = mirrorTitle;
				record.mirrorTeamId = config.teamId;
				this.mirrors.set(issue.issueId, record);
			}
			this.logger.event("cockpit_mirror_upserted", {
				issueId: issue.issueId,
				issueIdentifier: record.issueIdentifier,
				state: record.state,
				client: client.id,
				lifecycleColumn: stateId ? COCKPIT_STATUS_NAMES[state] : "none",
			});
			await this.deps.persist();
			// PON-173: every transition can change the fair order. Awaited so
			// a transition's ordering effect is visible when its chain step
			// resolves; the in-flight guard collapses concurrent chains'
			// calls into a trailing rerun.
			await this.resyncOperatorOrdering();
		});
	}

	/** Ordering resync serialization (PON-173): one at a time, trailing rerun. */
	private orderingInFlight = false;
	private orderingQueued = false;

	/**
	 * Recompute the round-robin operator order (PON-173) and write it as
	 * Linear sortOrder on every mirror whose rank changed. Fire-and-forget
	 * from transitions; serialized against itself with a trailing rerun so
	 * a burst of transitions converges on the final order.
	 */
	async resyncOperatorOrdering(): Promise<void> {
		if (this.orderingInFlight) {
			this.orderingQueued = true;
			return;
		}
		this.orderingInFlight = true;
		try {
			do {
				this.orderingQueued = false;
				const config = this.guardedConfig();
				if (!config) return;
				// PON-207: order is per CLIENT, weighted by lanes. A client
				// with two teams is one queue; a client with two lanes takes
				// two turns per cycle, which is what they bought.
				const items = [...this.mirrors.entries()].map(
					([issueId, record], seq) => {
						const client = this.deps.resolveClient(
							record.tenantWorkspaceId,
							record.teamKey,
						);
						return {
							issueId,
							tenantWorkspaceId: record.tenantWorkspaceId,
							stateRank: stateRankOf(record.state),
							seq,
							clientId: client.id,
							lanes: client.lanes,
						};
					},
				);
				const order = computeRoundRobinOrder(items);
				let changed = 0;
				for (let rank = 0; rank < order.length; rank++) {
					const record = this.mirrors.get(order[rank] as string);
					if (!record?.mirrorIssueId) continue;
					if (record.sortOrder === rank) continue;
					await this.gql(
						config.linearWorkspaceId,
						`mutation($id: String!, $input: IssueUpdateInput!) {
							issueUpdate(id: $id, input: $input) { success }
						}`,
						{ id: record.mirrorIssueId, input: { sortOrder: rank } },
					);
					record.sortOrder = rank;
					changed++;
				}
				// PON-211: the order was computed and written as sortOrder, and
				// then never said out loud. Record each waiting mirror's place
				// so the description can state it: the client's own queue
				// position (theirs to set) and the cross-client rank (whose
				// turn it is). Two numbers because they are two different
				// facts — collapsing them would misreport both.
				// Only ask who has claimed what when something could actually be
				// waiting. An empty or fully-active board asks nobody.
				const anyWaiting = [...this.mirrors.values()].some((r) =>
					WAITING_STATES.has(r.state.replace(/ \(#\d+\)$/, "")),
				);
				const claimed = anyWaiting
					? await this.claimedMirrorIds(config.linearWorkspaceId)
					: new Set<string>();
				let waitingRank = 0;
				// TENANT ISOLATION: the per-position counter is keyed by the
				// tenant WORKSPACE, not by a global counter — a mirror is
				// numbered only against its own tenant's waiting work. After
				// this loop, perTenant.get(ws) is that tenant's total (the M).
				const perTenant = new Map<string, number>();
				for (const issueId of order) {
					const record = this.mirrors.get(issueId);
					if (!record?.mirrorIssueId) continue;
					const base = record.state.replace(/ \(#\d+\)$/, "");
					// A claim takes an in-verification or needs-info mirror out of
					// the order: that reviewer holds it. It does NOT take queued
					// or rework work out — under Harold's ruling (2026-09-02) the
					// claimant is exactly the one whose delegation starts it, so
					// the claimed queued mirror is the one to mark next up. Live
					// on CKP-24/CKP-25: both claimed, neither ranked, no marker.
					const waiting =
						WAITING_STATES.has(base) &&
						(base === "queued" ||
							base === "rework" ||
							!claimed.has(record.mirrorIssueId));
					if (!waiting) {
						if (record.queueRank !== undefined) changed++;
						record.queueRank = undefined;
						record.clientQueuePosition = undefined;
						record.tenantQueueTotal = undefined;
						continue;
					}
					const within = (perTenant.get(record.tenantWorkspaceId) ?? 0) + 1;
					perTenant.set(record.tenantWorkspaceId, within);
					waitingRank += 1;
					if (
						record.queueRank !== waitingRank ||
						record.clientQueuePosition !== within
					) {
						changed++;
					}
					record.queueRank = waitingRank;
					record.clientQueuePosition = within;
				}
				// v3.1 (requirement B): exactly one startable mirror is next up
				// (the global suggestion); a gated one says why in its OWN
				// tenant's terms; no cross-tenant "behind" is ever written.
				// Surfaced natively — the next-up LABEL renders in list views —
				// and in the description, which is rewritten here when the
				// order changed rather than waiting for the next transition.
				let nextUpAssigned = false;
				const rewrite: SerializedCockpitMirror[] = [];
				for (const issueId of order) {
					const record = this.mirrors.get(issueId);
					if (!record?.mirrorIssueId) continue;
					const base = record.state.replace(/ \(#\d+\)$/, "");
					// A delivered mirror is finished business: its labels and
					// description are left exactly as they were (CKP-22 stays
					// untouched through this migration).
					if (base === "delivered") continue;
					const startable =
						record.queueRank !== undefined &&
						(base === "queued" || base === "rework");
					let nextUp = false;
					let gatedBy: string | undefined;
					if (startable) {
						const wip = this.clientWorkInFlight(issueId);
						if (wip.inFlight.length >= wip.limit) {
							const client = this.deps.resolveClient(
								record.tenantWorkspaceId,
								record.teamKey,
							);
							const held = wip.inFlight
								.map(
									(i) =>
										`${i.issueIdentifier ?? "another issue"} ${i.state.replace(/-/g, " ")}`,
								)
								.join(", ");
							gatedBy = `${client.displayName ?? client.id} has ${held} (one build at a time)`;
						} else if (!nextUpAssigned) {
							nextUp = true;
							nextUpAssigned = true;
						}
					}
					// TENANT ISOLATION: the M in "N of M" — this tenant's own
					// waiting total; no cross-tenant "behind" is ever written.
					const tenantQueueTotal =
						record.queueRank !== undefined
							? perTenant.get(record.tenantWorkspaceId)
							: undefined;
					if (
						record.nextUp !== nextUp ||
						record.gatedBy !== gatedBy ||
						record.behind !== undefined ||
						record.tenantQueueTotal !== tenantQueueTotal ||
						(record.labelsVersion ?? 0) < LABELS_VERSION
					) {
						record.nextUp = nextUp;
						record.gatedBy = gatedBy;
						record.behind = undefined;
						record.tenantQueueTotal = tenantQueueTotal;
						changed++;
						rewrite.push(record);
					}
				}
				for (const record of rewrite) {
					try {
						const client = this.deps.resolveClient(
							record.tenantWorkspaceId,
							record.teamKey,
						);
						const labelIds = await this.markerLabelIds(
							config,
							client.id,
							record,
						);
						await this.gql(
							config.linearWorkspaceId,
							`mutation($id: String!, $input: IssueUpdateInput!) {
								issueUpdate(id: $id, input: $input) { success }
							}`,
							{
								id: record.mirrorIssueId,
								input: {
									labelIds,
									description: this.renderDescription(
										record,
										record.tenantWorkspaceId,
									),
								},
							},
						);
						record.labelsVersion = LABELS_VERSION;
						if (record.nextUp) {
							this.logger.event("cockpit_next_up", {
								issueId: record.issueIdentifier,
								mirrorIssueId: record.mirrorIssueId,
							});
						}
					} catch (error) {
						this.logger.warn(
							`[cockpit] could not write the working order on ${record.issueIdentifier}: ${String(error)}`,
						);
					}
				}
				if (changed > 0) {
					this.logger.event("cockpit_ordering_resynced", {
						mirrors: order.length,
						changed,
						waiting: waitingRank,
					});
					await this.deps.persist();
				}
			} while (this.orderingQueued);
		} catch (error) {
			this.logger.error("[cockpit] ordering resync failed:", error);
		} finally {
			this.orderingInFlight = false;
		}
	}

	/**
	 * Record the session's internal reading on the mirror (PON-169). The
	 * mirror keeps its current state and labels — only the description
	 * gains (or replaces) the reading.
	 *
	 * PON-219: this no longer creates a mirror. The note is recorded before
	 * the client is even asked to approve, so creating one here was the
	 * earliest way unapproved work reached the board. The reading is written
	 * to the scope record either way — that record is authoritative, and it is
	 * carried onto the mirror when the client approves.
	 */
	setOperatorNote(
		issue: CockpitIssueRef,
		tenantWorkspaceId: string,
		note: string,
		clientScope?: string,
	): Promise<void> {
		const existing = this.mirrors.get(issue.issueId);
		// Preserve the current state; strip a queued-position suffix — the
		// next queue sync re-adds it. Anything unrecognised falls back to
		// active rather than inventing a label.
		const baseState = (existing?.state ?? "active").replace(/ \(#\d+\)$/, "");
		const state = (COCKPIT_STATES as readonly string[]).includes(baseState)
			? (baseState as CockpitState)
			: "active";
		return this.upsert(issue, tenantWorkspaceId, state, {
			operatorNote: note,
			...(clientScope !== undefined ? { brief: { clientScope } } : {}),
		});
	}

	/**
	 * Close the mirror (client issue finished: session ended, issue terminal,
	 * or unassigned). Moves it to the cockpit team's completed state and
	 * forgets it, so the tracking map stays bounded.
	 */
	close(issueId: string, reason: string): Promise<void> {
		return this.chain(issueId, async () => {
			const existing = this.mirrors.get(issueId);
			if (!existing?.mirrorIssueId) return;
			const config = this.configFor(existing.tenantWorkspaceId);
			if (!config) return;
			const setup = await this.ensureTeamSetup(config);
			if (!setup?.completedStateId) return;
			// A cancelled issue is not a delivered one. The mirror used to close
			// everything into the completed state, so work the client abandoned
			// read as work we shipped — on the operator's own board, which is
			// the one place that has to be true.
			//
			// Linear's terminal notification deliberately does not say WHICH
			// terminal state (see IssueStateChangeMessage), so the only honest
			// source is the client issue itself. One read on a path that is
			// already writing; a failure falls back to completed, which is the
			// previous behaviour rather than a new guess.
			//
			// PON-219 sharpened this. Reconcile also closes a mirror simply
			// because it is no longer live — and once mirrors exist only for
			// approved work, an unapproved one gets discarded that way with
			// its client issue still wide open. Defaulting to completed made
			// that read as DELIVERED on the operator's board: a positive claim
			// about work that was never delivered. Caught live on CKP-11.
			//
			// So completed is now the narrow case, not the default: the client
			// closed it as done, or we actually delivered it and they have not
			// closed their issue yet. Everything else — abandoned, discarded,
			// reconciled away — is cancelled.
			const clientState = await this.clientIssueStateType(
				existing.tenantWorkspaceId,
				issueId,
			);
			// v3.1: a client issue that is GONE (deleted, or unreadable) is not
			// a delivery either. `issue_terminal` arrives for a deletion as
			// well as for Done, and the lookup answers undefined for both a
			// deleted issue and a failed read; the CKP-11 rule — completed is
			// the narrow case, never the default — decides the tie.
			const closeStateId =
				clientState === "completed"
					? setup.completedStateId
					: clientState === "canceled" ||
							(clientState === undefined && reason === "issue_terminal") ||
							DISCARD_REASONS.has(reason)
						? (setup.canceledStateId ?? setup.completedStateId)
						: setup.completedStateId;

			// PON-207: a mirror left behind in a previous cockpit team cannot
			// take this team's Done state. It was closed when the cockpit
			// moved; forgetting it is the whole job.
			if (!(await this.mirrorLivesInTeam(existing, config))) {
				this.mirrors.delete(issueId);
				this.logger.event("cockpit_mirror_closed", {
					issueId,
					issueIdentifier: existing.issueIdentifier,
					reason: `${reason} (left behind in a previous cockpit team)`,
				});
				await this.deps.persist();
				return;
			}

			await this.gql(
				config.linearWorkspaceId,
				`mutation($id: String!, $input: IssueUpdateInput!) {
					issueUpdate(id: $id, input: $input) { success }
				}`,
				{
					id: existing.mirrorIssueId,
					input: {
						stateId: closeStateId,
						labelIds: [],
						description: this.renderDescription(
							{ ...existing, state: `done (${reason})` },
							existing.tenantWorkspaceId,
						),
					},
				},
			);
			this.mirrors.delete(issueId);
			this.logger.event("cockpit_mirror_closed", {
				issueId,
				issueIdentifier: existing.issueIdentifier,
				reason,
			});
			await this.deps.persist();
			// PON-173: a departure re-ranks what remains.
			await this.resyncOperatorOrdering();
		});
	}

	/**
	 * Refresh the queued positions for one tenant workspace's mirrors after
	 * any queue change (enqueue elsewhere, dequeue, reorder, removal).
	 */
	async syncQueuePositions(
		tenantWorkspaceId: string,
		queued: Array<{ issue: CockpitIssueRef; position: number }>,
	): Promise<void> {
		try {
			for (const entry of queued) {
				await this.upsert(entry.issue, tenantWorkspaceId, "queued", {
					position: entry.position,
				});
			}
		} catch (error) {
			this.logger.error("[cockpit] queue sync failed:", error);
		}
	}

	/**
	 * Boot reconciliation: make the mirror match reality. Everything live is
	 * upserted; every tracked mirror with no live counterpart is closed. A
	 * restart repairs drift rather than preserving it.
	 */
	async reconcile(live: {
		active: Array<{ issue: CockpitIssueRef; tenantWorkspaceId: string }>;
		queued: Array<{
			issue: CockpitIssueRef;
			tenantWorkspaceId: string;
			position: number;
		}>;
		/** Completed work awaiting operator approval (PON-152) */
		inVerification?: Array<{
			issue: CockpitIssueRef;
			tenantWorkspaceId: string;
		}>;
		/**
		 * Approved work whose implementation is parked until the reviewer
		 * starts it (PON-224). No lane entry, no session, no held delivery —
		 * the queued mirror is the only live trace, so reconcile must count
		 * it or every boot closes it as an orphan.
		 */
		parked?: Array<{
			issue: CockpitIssueRef;
			tenantWorkspaceId: string;
		}>;
		/**
		 * Delivered work the client is reviewing, and work they asked to
		 * change (PON-233). The same trap as `parked` with a much longer
		 * fuse: an item can sit in client review for days, and reconcile
		 * closes anything it cannot see — into CANCELED, because
		 * "reconciled" is a discard reason. Without these categories the
		 * first restart after a delivery destroys the record of it.
		 */
		inClientReview?: Array<{
			issue: CockpitIssueRef;
			tenantWorkspaceId: string;
		}>;
		rework?: Array<{
			issue: CockpitIssueRef;
			tenantWorkspaceId: string;
		}>;
		/** Waiting on the client mid-work (v3.1): keeps its mirror on restart. */
		needsInfo?: Array<{
			issue: CockpitIssueRef;
			tenantWorkspaceId: string;
		}>;
	}): Promise<void> {
		try {
			if (!this.deps.getConfig()) return;
			// The persisted map is not the only place mirrors exist: Linear
			// is. A lost map (corrupt state file, rollback whose save dropped
			// the field) would otherwise mint DUPLICATE mirror issues while
			// the originals sit open with live-looking labels forever. So
			// adopt what Linear already holds before upserting, and close
			// what Linear holds that matches nothing live.
			await this.adoptAndPruneLinearMirrors([
				...live.active.map((e) => e.issue),
				...live.queued.map((e) => e.issue),
				...(live.inVerification ?? []).map((e) => e.issue),
				...(live.parked ?? []).map((e) => e.issue),
				...(live.inClientReview ?? []).map((e) => e.issue),
				...(live.rework ?? []).map((e) => e.issue),
			]);
			// PON-209: "live" here means "our machinery still thinks this is
			// open" — a scope record, a lane entry, a held delivery. None of
			// those hear about a client cancelling while we are down, so the
			// mirror comes back every boot, in a live-looking state, forever.
			// Observed: three mirrors of long-cancelled issues sitting in
			// "Awaiting scope", surviving being closed by hand.
			//
			// Linear is the authority on whether the client's issue is over.
			// Ask it, once per tenant, and treat a terminal client issue as
			// not live no matter what our records say.
			const terminal = await this.terminalClientIssues([
				...live.queued,
				...live.active,
				...(live.inVerification ?? []),
				...(live.parked ?? []),
				...(live.inClientReview ?? []),
				...(live.rework ?? []),
			]);
			const liveIds = new Set<string>();
			// PON-224: parked before queued — a lane-derived entry for the same
			// issue carries a position and should win the final write.
			for (const entry of live.parked ?? []) {
				if (terminal.has(entry.issue.issueId)) continue;
				liveIds.add(entry.issue.issueId);
				await this.upsert(entry.issue, entry.tenantWorkspaceId, "queued");
			}
			for (const entry of live.queued) {
				if (terminal.has(entry.issue.issueId)) continue;
				liveIds.add(entry.issue.issueId);
				await this.upsert(entry.issue, entry.tenantWorkspaceId, "queued", {
					position: entry.position,
				});
			}
			for (const entry of live.active) {
				if (terminal.has(entry.issue.issueId)) continue;
				liveIds.add(entry.issue.issueId);
				await this.upsert(entry.issue, entry.tenantWorkspaceId, "active");
			}
			for (const entry of live.inVerification ?? []) {
				if (terminal.has(entry.issue.issueId)) continue;
				liveIds.add(entry.issue.issueId);
				await this.upsert(
					entry.issue,
					entry.tenantWorkspaceId,
					"in-verification",
				);
			}
			for (const entry of live.inClientReview ?? []) {
				if (terminal.has(entry.issue.issueId)) continue;
				liveIds.add(entry.issue.issueId);
				await this.upsert(
					entry.issue,
					entry.tenantWorkspaceId,
					"in-client-review",
				);
			}
			for (const entry of live.rework ?? []) {
				if (terminal.has(entry.issue.issueId)) continue;
				liveIds.add(entry.issue.issueId);
				await this.upsert(entry.issue, entry.tenantWorkspaceId, "rework");
			}
			for (const entry of live.needsInfo ?? []) {
				if (terminal.has(entry.issue.issueId)) continue;
				liveIds.add(entry.issue.issueId);
				await this.upsert(entry.issue, entry.tenantWorkspaceId, "needs-info");
			}
			for (const issueId of [...this.mirrors.keys()]) {
				if (!liveIds.has(issueId)) {
					await this.close(issueId, "reconciled");
				}
			}
			this.logger.event("cockpit_reconciled", {
				live: liveIds.size,
				tracked: this.mirrors.size,
			});
			// PON-173: boot re-ranks the surviving mirrors.
			await this.resyncOperatorOrdering();
		} catch (error) {
			this.logger.error("[cockpit] reconcile failed:", error);
		}
	}

	/**
	 * Fetch the cockpit team's OPEN issues that look like mirrors (mirror
	 * title shape AND carrying a cockpit state label; project-scoped when a
	 * project is configured). Adopt those matching a live client issue into
	 * the map (so upserts update instead of duplicating); close the rest.
	 * Tracked mirrors are left to the map-based stale pass.
	 */
	private async adoptAndPruneLinearMirrors(
		liveIssues: CockpitIssueRef[],
	): Promise<void> {
		const config = this.deps.getConfig();
		if (!config) return;
		const setup = await this.ensureTeamSetup(config);
		if (!setup) return;
		const stateLabelIds = new Set(Object.values(setup.labelIds));

		const data = await this.gql<{
			team: {
				issues: {
					nodes: Array<{
						id: string;
						title: string;
						labels: { nodes: Array<{ id: string; name?: string }> };
						project: { id: string } | null;
					}>;
				};
			};
		}>(
			config.linearWorkspaceId,
			`query($teamId: String!) {
				team(id: $teamId) {
					issues(
						first: 200,
						filter: { state: { type: { neq: "completed" } } }
					) {
						nodes {
							id
							title
							labels(first: 10) { nodes { id name } }
							project { id }
						}
					}
				}
			}`,
			{ teamId: config.teamId },
		);

		const trackedMirrorIds = new Set(
			[...this.mirrors.values()].map((m) => m.mirrorIssueId),
		);
		const byIdentifier = new Map<string, CockpitIssueRef>();
		for (const issue of liveIssues) {
			if (issue.issueIdentifier) {
				byIdentifier.set(issue.issueIdentifier, issue);
			}
		}
		const liveTracked = new Set(
			[...this.mirrors.entries()]
				.filter(([issueId]) =>
					liveIssues.some((issue) => issue.issueId === issueId),
				)
				.map(([, m]) => m.mirrorIssueId),
		);

		const anyStateLabels = stateLabelIds.size > 0;
		for (const node of data.team.issues.nodes) {
			if (config.projectId && node.project?.id !== config.projectId) continue;
			const match = MIRROR_TITLE_PATTERN.exec(node.title);
			if (!match) continue;
			// Recognition: a state label when labels exist; otherwise —
			// labels being unavailable to app tokens — the mirror title
			// shape inside the DEDICATED project is the marker. Without a
			// project configured AND without labels, adoption stays off
			// rather than guessing against a mixed team.
			// Group 1 is the old `[DVV-12] …` shape, group 2 the client-first
			// one. Both must resolve, or a boot mid-migration sees half its
			// mirrors as strangers.
			const identifier = match[1] ?? match[2];
			const liveIssue = identifier ? byIdentifier.get(identifier) : undefined;
			const stateLabeled = node.labels.nodes.some((label) =>
				stateLabelIds.has(label.id),
			);
			// v3.1: mirrors carry the tenant label, not a state — so a title
			// that names a LIVE issue, on an issue that carries any label at
			// all, is ours. An orphan (no live match) still needs the legacy
			// state label or the dedicated project before it is touched.
			const tenantLabeled =
				liveIssue !== undefined && node.labels.nodes.length > 0;
			const labeled = stateLabeled || tenantLabeled;
			if (!labeled && !(anyStateLabels === false && config.projectId)) {
				continue;
			}
			if (trackedMirrorIds.has(node.id)) continue; // map already knows it
			if (liveIssue && !liveTracked.has(node.id)) {
				const alreadyAdopted = this.mirrors.get(liveIssue.issueId);
				if (!alreadyAdopted) {
					// Adopt: the upsert that follows updates THIS issue
					// instead of creating a duplicate. State left empty so
					// the first upsert always writes.
					this.mirrors.set(liveIssue.issueId, {
						mirrorIssueId: node.id,
						tenantWorkspaceId: "",
						state: "",
						issueIdentifier: liveIssue.issueIdentifier,
					});
					this.logger.event("cockpit_mirror_adopted", {
						issueId: liveIssue.issueId,
						issueIdentifier: liveIssue.issueIdentifier,
						mirrorIssueId: node.id,
					});
					continue;
				}
			}
			// PON-207 migration safety: while any tracked mirror is still on
			// the pre-client shape, this boot ADOPTS only and closes nothing.
			// The first boot after the model lands sees old titles it has not
			// re-written yet, and "looks unfamiliar" must never be grounds
			// for closing a live in-verification delivery.
			if (this.hasUnmigratedMirrors()) {
				this.logger.info(
					`[cockpit] orphan close skipped for "${node.title.slice(0, 60)}" — migration boot, adoption only`,
				);
				continue;
			}
			// An open mirror-looking issue matching nothing live: orphaned by
			// a lost map. Close it directly.
			if (setup.completedStateId) {
				await this.gql(
					config.linearWorkspaceId,
					`mutation($id: String!, $input: IssueUpdateInput!) {
						issueUpdate(id: $id, input: $input) { success }
					}`,
					{
						id: node.id,
						input: { stateId: setup.completedStateId, labelIds: [] },
					},
				);
				this.logger.event("cockpit_mirror_orphan_closed", {
					mirrorIssueId: node.id,
					title: node.title.slice(0, 60),
				});
			}
		}
	}

	/**
	 * Does this mirror issue still live in the team we are writing to?
	 *
	 * Recorded on every write, so the common path is a field comparison. A
	 * record from before the field existed is asked once, and the answer is
	 * remembered — that single query is the whole cost of moving the cockpit
	 * to its own team.
	 */
	private async mirrorLivesInTeam(
		record: SerializedCockpitMirror,
		config: { linearWorkspaceId: string; teamId: string },
	): Promise<boolean> {
		if (record.mirrorTeamId) return record.mirrorTeamId === config.teamId;
		try {
			const data = await this.gql<{
				issue: { team: { id: string } } | null;
			}>(
				config.linearWorkspaceId,
				`query($id: String!) { issue(id: $id) { team { id } } }`,
				{ id: record.mirrorIssueId },
			);
			const teamId = data.issue?.team?.id;
			if (!teamId) return false;
			record.mirrorTeamId = teamId;
			if (teamId !== config.teamId) {
				this.logger.info(
					`[event:cockpit_mirror_left_behind] ${record.issueIdentifier ?? record.mirrorIssueId} was mirrored in another team; creating a fresh mirror in the current one`,
				);
			}
			return teamId === config.teamId;
		} catch {
			// Unknown: treat as usable rather than duplicating on a blip.
			return true;
		}
	}

	/**
	 * Is any tracked mirror still on the pre-PON-207 shape?
	 *
	 * A mirror gets `clientId` the first time it is written under the client
	 * model. Until every tracked mirror has one, this boot is a migration
	 * boot: adoption runs, closing does not.
	 */
	private hasUnmigratedMirrors(): boolean {
		for (const record of this.mirrors.values()) {
			if (!record.clientId) return true;
		}
		return false;
	}

	/**
	 * Which client issue a mirror issue stands for (PON-152). This resolves
	 * the TARGET of a human action taken on a mirror — it never reads mirror
	 * state as a source of truth.
	 */
	/**
	 * This instance's own agent handle in the cockpit workspace (PON-211).
	 *
	 * Resolved once from `viewer` — with an app token, the viewer IS the app
	 * user. Cached because it cannot change without a reinstall, and left
	 * undefined on failure so the mirror omits the line rather than printing
	 * a guess: a wrong handle sends the operator to the wrong agent, which is
	 * the exact failure this line exists to prevent.
	 */
	private agentHandle: string | undefined;
	/** Resolved once per process — success or failure. */
	private agentHandleResolved = false;

	private async resolveAgentHandle(workspaceId: string): Promise<void> {
		if (this.agentHandleResolved) return;
		// Set BEFORE the await: a token that cannot answer this would
		// otherwise be re-asked on every single mirror write, forever. The
		// answer cannot change without a reinstall, and a reinstall restarts
		// us — so one attempt is the right number.
		this.agentHandleResolved = true;
		try {
			const data = await this.gql<{ viewer: { displayName?: string } }>(
				workspaceId,
				`query { viewer { displayName } }`,
				{},
			);
			this.agentHandle = data?.viewer?.displayName || undefined;
		} catch (error) {
			this.logger.warn(
				`[cockpit] could not resolve the agent handle: ${String(error)}`,
			);
		}
	}

	/**
	 * Which mirrors a reviewer has already claimed (PON-211).
	 *
	 * Claimed means "has an assignee" — since PON-211 the mirror never writes
	 * that field, so anything set there was set by a human taking the work.
	 * They come out of the queue immediately, not when they finish: next-up
	 * answers "what should the next free reviewer take", and pointing it at
	 * something already in someone's hands is how two people end up on one
	 * issue.
	 *
	 * A failure returns empty — the queue then shows a claimed item as
	 * waiting, which is noisy but honest. Silently treating everything as
	 * claimed would empty the queue and hide real work.
	 */
	private async claimedMirrorIds(workspaceId: string): Promise<Set<string>> {
		const claimed = new Set<string>();
		try {
			const config = this.deps.getConfig();
			if (!config) return claimed;
			const data = await this.gql<{
				issues: {
					nodes: Array<{ id: string; assignee: { id: string } | null }>;
				};
			}>(
				workspaceId,
				`query($teamId: ID!) {
					issues(filter: { team: { id: { eq: $teamId } } }, first: 250) {
						nodes { id assignee { id } }
					}
				}`,
				{ teamId: config.teamId },
			);
			for (const node of data.issues.nodes) {
				if (node.assignee) claimed.add(node.id);
			}
		} catch (error) {
			this.logger.warn(`[cockpit] could not read claims: ${String(error)}`);
		}
		return claimed;
	}

	/**
	 * Which of these client issues are already over (PON-209)?
	 *
	 * One query per tenant, on boot only. A failure returns empty — the
	 * mirrors then stay open, which is the behaviour we already had; treating
	 * an unreachable tenant's issues as terminal would close live work.
	 */
	private async terminalClientIssues(
		entries: Array<{ issue: CockpitIssueRef; tenantWorkspaceId: string }>,
	): Promise<Set<string>> {
		const terminal = new Set<string>();
		const byWorkspace = new Map<string, string[]>();
		for (const entry of entries) {
			const list = byWorkspace.get(entry.tenantWorkspaceId) ?? [];
			list.push(entry.issue.issueId);
			byWorkspace.set(entry.tenantWorkspaceId, list);
		}
		for (const [workspaceId, ids] of byWorkspace) {
			try {
				const data = await this.gql<{
					issues: {
						nodes: Array<{ id: string; state: { type: string } | null }>;
					};
				}>(
					workspaceId,
					`query($ids: [ID!]) {
						issues(filter: { id: { in: $ids } }, first: 250) {
							nodes { id state { type } }
						}
					}`,
					{ ids },
				);
				for (const node of data.issues.nodes) {
					if (
						node.state?.type === "completed" ||
						node.state?.type === "canceled"
					) {
						terminal.add(node.id);
					}
				}
			} catch (error) {
				this.logger.warn(
					`[cockpit] could not check client issue states for ${workspaceId}: ${String(error)}`,
				);
			}
		}
		if (terminal.size > 0) {
			this.logger.event("cockpit_terminal_clients_found", {
				count: terminal.size,
			});
		}
		return terminal;
	}

	/** Did the client cancel this issue, rather than finish it? */
	/**
	 * The client issue's workflow-state type, or undefined if unreadable.
	 * Public so the scope-record prune (PON-219) can ask the same question
	 * without a second GraphQL client and a second token lookup.
	 */
	/**
	 * The labels a mirror carries (v3.1): the tenant, and `next-up` on the
	 * one queued mirror to start next. Never a state — the statuses are the
	 * state. Labels are found or created once per name and cached; the app
	 * token can create labels in the cockpit team (probed live 2026-09-01).
	 */
	private markerLabelCache = new Map<string, string>();
	/** One denied create is enough: the token cannot make labels here. */
	private markerLabelCreateDenied = false;
	private async ensureLabelId(
		config: { linearWorkspaceId: string; teamId: string },
		name: string,
	): Promise<string | undefined> {
		const cached = this.markerLabelCache.get(name);
		if (cached) return cached;
		try {
			const found = await this.gql<{
				team: { labels: { nodes: Array<{ id: string; name: string }> } };
			}>(
				config.linearWorkspaceId,
				`query($teamId: String!, $name: String!) {
					team(id: $teamId) { labels(filter: { name: { eq: $name } }, first: 1) { nodes { id name } } }
				}`,
				{ teamId: config.teamId, name },
			);
			let id = found?.team?.labels?.nodes?.[0]?.id;
			if (!id && this.markerLabelCreateDenied) return undefined;
			if (!id) {
				const created = await this.gql<{
					issueLabelCreate: { issueLabel: { id: string } };
				}>(
					config.linearWorkspaceId,
					`mutation($input: IssueLabelCreateInput!) {
						issueLabelCreate(input: $input) { success issueLabel { id } }
					}`,
					{ input: { teamId: config.teamId, name } },
				);
				id = created.issueLabelCreate.issueLabel.id;
			}
			if (id) this.markerLabelCache.set(name, id);
			return id;
		} catch (error) {
			this.markerLabelCreateDenied = true;
			this.logger.warn(
				`[cockpit] could not resolve label ${name}: ${String(error)} — mirrors carry no labels from here on`,
			);
			return undefined;
		}
	}

	private async markerLabelIds(
		config: { linearWorkspaceId: string; teamId: string },
		clientId: string,
		record: { nextUp?: boolean },
	): Promise<string[]> {
		const ids: string[] = [];
		if (clientId && clientId !== "unassigned") {
			const tenant = await this.ensureLabelId(config, clientId);
			if (tenant) ids.push(tenant);
		}
		if (record.nextUp) {
			const nextUp = await this.ensureLabelId(config, NEXT_UP_LABEL);
			if (nextUp) ids.push(nextUp);
		}
		return ids;
	}

	async clientIssueStateType(
		tenantWorkspaceId: string,
		issueId: string,
	): Promise<string | undefined> {
		try {
			const data = await this.gql<{
				issue: { state: { type: string } | null } | null;
			}>(
				tenantWorkspaceId,
				`query($id: String!) { issue(id: $id) { state { type } } }`,
				{ id: issueId },
			);
			return data?.issue?.state?.type ?? undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Who has claimed this mirror (PON-225).
	 *
	 * The mirror never writes `assigneeId` — claiming is a human act and
	 * nothing here undoes it (PON-211) — which is exactly what makes it a
	 * trustworthy signal of intent. It is read for one decision: whether the
	 * work on a queued mirror may be started. Sessions on a mirror are often
	 * created by machinery (the narration thread at birth, the re-delegation
	 * recovery), and the creator of those carries no human meaning; the
	 * assignee does.
	 */
	async assigneeIdFor(clientIssueId: string): Promise<string | undefined> {
		const config = this.deps.getConfig();
		const mirrorIssueId = this.mirrors.get(clientIssueId)?.mirrorIssueId;
		if (!config || !mirrorIssueId) return undefined;
		try {
			const data = await this.gql<{
				issue: { assignee: { id: string } | null } | null;
			}>(
				config.linearWorkspaceId,
				`query($id: String!) { issue(id: $id) { assignee { id } } }`,
				{ id: mirrorIssueId },
			);
			return data?.issue?.assignee?.id ?? undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * How much of a client's work is in flight, and how much they bought
	 * (PON-234).
	 *
	 * Work-in-progress is a property of the LIFECYCLE, not of a session. The
	 * lane holds a session and is released the moment a human becomes the
	 * blocker — correctly, so a client's other issues are not stuck behind
	 * someone's inbox — which makes it structurally unable to express "one
	 * piece of work at a time, from start to merge". This counts states
	 * instead: it is derived, so a restart cannot lose it, and a stale
	 * mirror is repaired by the same reconcile that repairs everything else.
	 *
	 * Bends the module's own "nothing reads a mirror to make a decision"
	 * rule, and says so out loud rather than quietly, as `stateFor` and
	 * `assigneeIdFor` already do.
	 *
	 * Keyed on the client, falling back to the workspace: `resolveClient`
	 * returns the literal "unassigned" for every workspace with no registry
	 * entry, so keying on the id alone would serialise every unconfigured
	 * tenant against each other as though they were one company.
	 */
	clientWorkInFlight(clientIssueId: string): {
		inFlight: Array<{ issueIdentifier?: string; state: string }>;
		limit: number;
	} {
		const IN_FLIGHT = new Set([
			"active",
			"needs-info",
			"in-verification",
			"in-client-review",
			"rework",
		]);
		const subject = this.mirrors.get(clientIssueId);
		const keyOf = (record: SerializedCockpitMirror): string =>
			!record.clientId || record.clientId === "unassigned"
				? record.tenantWorkspaceId
				: record.clientId;
		if (!subject) return { inFlight: [], limit: 1 };
		const subjectKey = keyOf(subject);

		const inFlight: Array<{ issueIdentifier?: string; state: string }> = [];
		for (const [issueId, record] of this.mirrors) {
			if (issueId === clientIssueId) continue;
			if (keyOf(record) !== subjectKey) continue;
			const state = bareCockpitState(record.state);
			if (IN_FLIGHT.has(state))
				inFlight.push({ issueIdentifier: record.issueIdentifier, state });
		}
		// What they bought, not a hard 1: a client paying for two lanes must
		// be allowed two in flight.
		const client = this.deps.resolveClient(
			subject.tenantWorkspaceId,
			teamKeyOf(subject.issueIdentifier),
		);
		return { inFlight, limit: Math.max(1, client.lanes ?? 1) };
	}

	clientIssueIdFor(mirrorIssueId: string): string | undefined {
		for (const [clientIssueId, record] of this.mirrors) {
			if (record.mirrorIssueId === mirrorIssueId) return clientIssueId;
		}
		return undefined;
	}

	/**
	 * The mirror issue standing for a client issue (PON-208) — the forward
	 * direction of the lookup above. Read only to ADDRESS the operator's own
	 * surface (the working thread, its links); mirror state is still never a
	 * source of truth about the work.
	 */
	/**
	 * An agent session that already exists on a mirror issue (PON-212).
	 *
	 * Creating a mirror issue as the app yields an agent session on its own —
	 * the issue's `createdAt` and the session's are identical — so calling
	 * `createAgentSession` afterwards produced a SECOND thread, and the
	 * reviewer got a mirror showing two where the narration only went to one.
	 * Adopt what is already there; create only when there is genuinely nothing.
	 */
	async existingSessionOnMirror(
		mirrorIssueId: string,
	): Promise<string | undefined> {
		const config = this.guardedConfig();
		if (!config) return undefined;
		try {
			const data = await this.gql<{
				issue: { agentSessions: { nodes: Array<{ id: string }> } } | null;
			}>(
				config.linearWorkspaceId,
				`query($id: String!) {
					issue(id: $id) { agentSessions(first: 5) { nodes { id } } }
				}`,
				{ id: mirrorIssueId },
			);
			return data?.issue?.agentSessions?.nodes?.[0]?.id;
		} catch {
			return undefined;
		}
	}

	/** The mirror's narration thread for a client issue (PON-212), if open. */
	narrationSessionIdFor(clientIssueId: string): string | undefined {
		return this.mirrors.get(clientIssueId)?.narrationSessionId;
	}

	mirrorIssueIdFor(clientIssueId: string): string | undefined {
		return this.mirrors.get(clientIssueId)?.mirrorIssueId;
	}

	/**
	 * The state last written for a client issue's mirror (PON-221).
	 *
	 * Lets a caller tell "no held work because it is still being built" from
	 * "no held work at all" — two situations that read identically from the
	 * verification gate and mean opposite things to a reviewer.
	 */
	stateFor(clientIssueId: string): string | undefined {
		return this.mirrors.get(clientIssueId)?.state;
	}

	/**
	 * Post a comment on a client issue's mirror (PON-152 escalation: the
	 * assignee is a subscriber, so a comment is the second, louder
	 * notification). Never throws.
	 */
	async commentOnMirror(clientIssueId: string, body: string): Promise<void> {
		try {
			const record = this.mirrors.get(clientIssueId);
			if (!record?.mirrorIssueId) return;
			const config = this.configFor(record.tenantWorkspaceId);
			if (!config) return;
			await this.gql(
				config.linearWorkspaceId,
				`mutation($input: CommentCreateInput!) {
					commentCreate(input: $input) { success }
				}`,
				{ input: { issueId: record.mirrorIssueId, body } },
			);
		} catch (error) {
			this.logger.error("[cockpit] mirror comment failed:", error);
		}
	}

	serialize(): Record<string, SerializedCockpitMirror> {
		return Object.fromEntries(
			[...this.mirrors.entries()].map(([id, m]) => [id, { ...m }]),
		);
	}

	restore(records: Record<string, SerializedCockpitMirror> | undefined): void {
		this.mirrors.clear();
		if (!records) return;
		for (const [issueId, record] of Object.entries(records)) {
			this.mirrors.set(issueId, { ...record });
		}
	}

	get size(): number {
		return this.mirrors.size;
	}

	// ─────────────────────────────────────────────────────────────────────

	/** Serialize writes per issue and swallow every failure. */
	private chain(issueId: string, work: () => Promise<void>): Promise<void> {
		const previous = this.writeChains.get(issueId) ?? Promise.resolve();
		const next = previous
			.then(work)
			.catch((error) => {
				this.logger.error(
					`[cockpit] mirror write failed for ${issueId}:`,
					error,
				);
			})
			.finally(() => {
				if (this.writeChains.get(issueId) === next) {
					this.writeChains.delete(issueId);
				}
			});
		this.writeChains.set(issueId, next);
		return next;
	}

	private ensureTeamSetup(config: {
		linearWorkspaceId: string;
		teamId: string;
	}): Promise<TeamSetup | undefined> {
		const cached = this.setupByTeam.get(config.teamId);
		if (cached) return cached;
		// A failed setup stays failed for a while: without the cooldown every
		// mirror event launches a fresh failing team query, forever.
		const failedAt = this.setupFailedAt.get(config.teamId);
		if (failedAt && Date.now() - failedAt < SETUP_FAILURE_COOLDOWN_MS) {
			return Promise.resolve(undefined);
		}
		const setup = (async (): Promise<TeamSetup | undefined> => {
			try {
				const data = await this.gql<{
					team: {
						states: {
							nodes: Array<{ id: string; name: string; type: string }>;
						};
						labels: { nodes: Array<{ id: string; name: string }> };
					};
				}>(
					config.linearWorkspaceId,
					`query($teamId: String!, $labelNames: [String!]!) {
						team(id: $teamId) {
							states(first: 50) { nodes { id name type } }
							labels(filter: { name: { in: $labelNames } }, first: 10) {
								nodes { id name }
							}
						}
					}`,
					{ teamId: config.teamId, labelNames: [...COCKPIT_STATES] },
				);
				// v3.1: state labels are no longer created or applied — the
				// statuses are the state. Existing ones are still looked up so
				// they can be stripped from mirrors that carry them.
				const labelIds: Record<string, string> = {};
				for (const label of data.team.labels.nodes) {
					labelIds[label.name] = label.id;
				}
				const completedStateId = data.team.states.nodes.find(
					(state) => state.type === "completed",
				)?.id;
				const canceledStateId = data.team.states.nodes.find(
					(state) => state.type === "canceled",
				)?.id;

				// PON-207: adopt the lifecycle statuses by name. All six or
				// none — a half-configured team would scatter mirrors across
				// two schemes, which is worse than the labels we started with.
				const byName = new Map(
					data.team.states.nodes.map((state) => [state.name, state.id]),
				);
				const stateIds = {} as Record<CockpitState, string>;
				const missing: string[] = [];
				for (const key of COCKPIT_STATES) {
					const wanted = COCKPIT_STATUS_NAMES[key];
					const id = byName.get(wanted);
					if (id) stateIds[key] = id;
					else missing.push(wanted);
				}
				if (
					missing.length > 0 &&
					this.lastStatusSetupLogged !== config.teamId
				) {
					this.lastStatusSetupLogged = config.teamId;
					this.logger.warn(
						`[cockpit] the cockpit team has no lifecycle columns yet — mirrors keep state in labels and land in the team's default status. Create these statuses on the cockpit team, in this order, to get the board: ${Object.values(
							COCKPIT_STATUS_NAMES,
						).join(" → ")}. Missing: ${missing.join(", ")}.`,
					);
				}

				this.setupFailedAt.delete(config.teamId);
				return {
					labelIds,
					teamLabelIds: {},
					completedStateId,
					canceledStateId,
					...(missing.length === 0 ? { stateIds } : {}),
				};
			} catch (error) {
				this.logger.error("[cockpit] team setup failed:", error);
				this.setupByTeam.delete(config.teamId);
				this.setupFailedAt.set(config.teamId, Date.now());
				return undefined;
			}
		})();
		this.setupByTeam.set(config.teamId, setup);
		return setup;
	}

	private renderDescription(
		record: SerializedCockpitMirror,
		tenantWorkspaceId: string,
	): string {
		const tenant =
			this.deps.getWorkspaceName(tenantWorkspaceId) ?? tenantWorkspaceId;
		const clientLink = record.issueUrl
			? `[${record.issueIdentifier ?? "client issue"}](${record.issueUrl})`
			: (record.issueIdentifier ?? "the client issue");
		return [
			`Derived view of ${clientLink} in **${tenant}**. The client's issue is authoritative.`,
			// PON-211: name the agent, on the mirror, in the operator's own
			// words. Several agents can be installed in one workspace, so a
			// mirror is mentionable by all of them and only one of them can
			// answer — the others have no idea what this issue is and will ask
			// which repository to use. Rendered from THIS instance's own app
			// user, so it cannot drift from whoever is actually serving it.
			this.agentHandle
				? `**Work this with @${this.agentHandle}** — delegate it, or just say what you want changed. Other agents installed in this workspace cannot see this work.`
				: "",
			"",
			// PON-211 / TENANT ISOLATION: say the place out loud, scoped to
			// this tenant. The cross-client order is written as sortOrder (row
			// order in the operator's view) and drives the single "suggested
			// next" marker — a suggestion, never a queue that anything waits
			// on. The number shown is this mirror's position in its OWN
			// tenant's queue (#N of M); a gated one names only its own tenant's
			// reason. A mirror never names another tenant's work.
			record.clientQueuePosition
				? `**In this client's queue:** #${record.clientQueuePosition}${
						record.tenantQueueTotal ? ` of ${record.tenantQueueTotal}` : ""
					}${record.gatedBy ? ` — waiting: ${record.gatedBy}` : ""}.${
						record.nextUp
							? " ▶ **Suggested next** across clients — a suggestion, not a queue; nothing waits on it. Assign yourself and delegate to start."
							: ""
					}`
				: "",
			// PON-221: an age the reviewer can act on, measured from this
			// mirror's own transition. The ISO stamp this replaced was
			// regenerated on every write, so it told you when the body was
			// last rewritten — never how long the work had been waiting.
			(() => {
				const age = record.stateSince
					? formatMirrorAge(record.stateSince, Date.now())
					: "";
				return age
					? `**State:** ${record.state} · for ${age}`
					: `**State:** ${record.state}`;
			})(),
			// PON-221: it used to say the PR and preview links live on the
			// client's thread. They no longer do until release — that was the
			// leak, not a description of it.
			`**Client issue:** ${record.issueUrl ?? "(no url recorded)"} — their session thread. The links below stay here until you release the work.`,
			// The operator brief (PON-170): what the client approved, when,
			// after how many revisions. Renders on every re-render, so a
			// later transition never erases it.
			...(record.clientScope
				? ["", "## Client scope", "", record.clientScope]
				: []),
			...(record.approvedAt
				? [
						"",
						// PON-221: the approval is the mirror's birth, so it is
						// the one client-side timestamp that IS true for the
						// mirror's life — shown as an age like everything else
						// here, rather than as a raw ISO string.
						(() => {
							const age = record.approvedAt
								? formatMirrorAge(record.approvedAt, Date.now())
								: "";
							return `**Approved:** ${age ? `${age} ago` : record.approvedAt} · **Revisions:** ${record.revisions ?? 0}`;
						})(),
					]
				: []),
			// The internal reading (PON-169).
			...(record.operatorNote
				? ["", "## Internal reading", "", record.operatorNote]
				: []),
			...(record.briefLinks?.length
				? ["", "## Links", "", ...record.briefLinks.map((link) => `- ${link}`)]
				: []),
		].join("\n");
	}

	private async gql<T = unknown>(
		cockpitWorkspaceId: string,
		query: string,
		variables: Record<string, unknown>,
	): Promise<T> {
		const token = this.deps.getToken(cockpitWorkspaceId);
		if (!token) throw new Error("cockpit workspace token unavailable");
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// The raw token form is what the workspace OAuth tokens in
				// config accept (same as every other direct GraphQL caller
				// on this box).
				Authorization: token,
			},
			body: JSON.stringify({ query, variables }),
		});
		const payload = (await response.json()) as {
			data?: T;
			errors?: unknown[];
		};
		if (!response.ok || payload.errors?.length || !payload.data) {
			throw new Error(
				`Linear GraphQL error (${response.status}): ${JSON.stringify(payload.errors ?? payload).slice(0, 400)}`,
			);
		}
		return payload.data;
	}
}
