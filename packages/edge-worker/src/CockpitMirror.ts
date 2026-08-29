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
	"awaiting-scope-confirm",
	"queued",
	"active",
	"needs-info",
	"in-verification",
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
	"awaiting-scope-confirm": "Awaiting scope",
	queued: "Queued",
	active: "Active",
	"needs-info": "Needs info",
	"in-verification": "In verification",
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
	/** Persist EdgeWorker state (best-effort; failures already logged). */
	persist: () => Promise<void>;
}

interface TeamSetup {
	labelIds: Record<string, string>;
	completedStateId: string | undefined;
	/**
	 * Lifecycle status ids by state, when the cockpit team defines all six
	 * (PON-207). Undefined means the team has not been set up yet and the
	 * mirror falls back to labels — the pre-PON-207 behaviour.
	 */
	stateIds?: Record<CockpitState, string>;
	/** Team-identity labels (`team:ACM`), created lazily like state labels. */
	teamLabelIds: Record<string, string>;
}

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
			/** Assign the mirror (in-verification: assignment IS the notification) */
			assigneeId?: string;
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
			const client = this.deps.resolveClient(tenantWorkspaceId, teamKey);

			const existing = this.mirrors.get(issue.issueId);
			const mergedLinks = [
				...new Set([
					...(existing?.briefLinks ?? []),
					...(detail?.brief?.addLinks ?? []),
				]),
			];
			const record: SerializedCockpitMirror = {
				mirrorIssueId: existing?.mirrorIssueId ?? "",
				tenantWorkspaceId,
				state:
					detail?.position !== undefined
						? `${state} (#${detail.position})`
						: state,
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
			};
			const description =
				this.renderDescription(record, tenantWorkspaceId) +
				(detail?.note ? `\n\n${detail.note}` : "");
			const labelId = setup.labelIds[state];
			const labelIds = labelId ? [labelId] : [];
			// PON-207: the lifecycle is a board column when the team defines
			// the statuses; labels stay alongside so a half-migrated cockpit
			// still filters and nothing is lost if the statuses go away.
			const stateId = setup.stateIds?.[state];
			const lifecycle = stateId ? { stateId } : {};
			// The reviewer owns the client's lanes, so their avatar is on
			// every card of theirs — not only the ones already in review.
			const assigneeId = detail?.assigneeId ?? client.reviewerId;
			const assignee = assigneeId ? { assigneeId } : {};
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
				const shapeChanged =
					existing.clientId !== record.clientId ||
					existing.mirrorTitle !== mirrorTitle;
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
							...assignee,
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
							...assignee,
						},
					},
				);
				record.mirrorIssueId = created.issueCreate.issue.id;
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
				if (changed > 0) {
					this.logger.event("cockpit_ordering_resynced", {
						mirrors: order.length,
						changed,
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
	 * gains (or replaces) the reading. When no mirror exists yet, one is
	 * created as `active` (the note arrives from a running session).
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
						stateId: setup.completedStateId,
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
		awaitingScopeConfirm: Array<{
			issue: CockpitIssueRef;
			tenantWorkspaceId: string;
		}>;
		/** Completed work awaiting operator approval (PON-152) */
		inVerification?: Array<{
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
				...live.awaitingScopeConfirm.map((e) => e.issue),
				...(live.inVerification ?? []).map((e) => e.issue),
			]);
			const liveIds = new Set<string>();
			for (const entry of live.awaitingScopeConfirm) {
				liveIds.add(entry.issue.issueId);
				await this.upsert(
					entry.issue,
					entry.tenantWorkspaceId,
					"awaiting-scope-confirm",
				);
			}
			for (const entry of live.queued) {
				liveIds.add(entry.issue.issueId);
				await this.upsert(entry.issue, entry.tenantWorkspaceId, "queued", {
					position: entry.position,
				});
			}
			for (const entry of live.active) {
				liveIds.add(entry.issue.issueId);
				await this.upsert(entry.issue, entry.tenantWorkspaceId, "active");
			}
			for (const entry of live.inVerification ?? []) {
				liveIds.add(entry.issue.issueId);
				await this.upsert(
					entry.issue,
					entry.tenantWorkspaceId,
					"in-verification",
				);
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
						labels: { nodes: Array<{ id: string }> };
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
							labels(first: 10) { nodes { id } }
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
			const labeled = node.labels.nodes.some((label) =>
				stateLabelIds.has(label.id),
			);
			if (!labeled && !(anyStateLabels === false && config.projectId)) {
				continue;
			}
			if (trackedMirrorIds.has(node.id)) continue; // map already knows it

			// Group 1 is the old `[DVV-12] …` shape, group 2 the client-first
			// one. Both must resolve, or a boot mid-migration sees half its
			// mirrors as strangers.
			const identifier = match[1] ?? match[2];
			const liveIssue = identifier ? byIdentifier.get(identifier) : undefined;
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
	mirrorIssueIdFor(clientIssueId: string): string | undefined {
		return this.mirrors.get(clientIssueId)?.mirrorIssueId;
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
				const labelIds: Record<string, string> = {};
				for (const label of data.team.labels.nodes) {
					labelIds[label.name] = label.id;
				}
				// Label creation is BEST-EFFORT: agent-app tokens (scope
				// write,app:assignable,app:mentionable) are not allowed to
				// create labels. Existing labels are still found by name, so
				// an operator pre-creating the three state labels once gets
				// filterable state; without them the mirror still works —
				// state lives in the description.
				let labelCreateDenied = false;
				for (const state of COCKPIT_STATES) {
					if (labelIds[state] || labelCreateDenied) continue;
					try {
						const created = await this.gql<{
							issueLabelCreate: {
								success: boolean;
								issueLabel: { id: string };
							};
						}>(
							config.linearWorkspaceId,
							`mutation($input: IssueLabelCreateInput!) {
								issueLabelCreate(input: $input) { success issueLabel { id } }
							}`,
							{ input: { teamId: config.teamId, name: state } },
						);
						labelIds[state] = created.issueLabelCreate.issueLabel.id;
					} catch (error) {
						labelCreateDenied = true;
						this.logger.warn(
							`[cockpit] cannot create state labels in the cockpit team (agent tokens may lack permission) — mirrors carry state in the description only. Pre-create labels ${COCKPIT_STATES.join(", ")} in the team for filterable state. (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`,
						);
					}
				}
				const completedStateId = data.team.states.nodes.find(
					(state) => state.type === "completed",
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
			`Derived view of ${clientLink} in **${tenant}**. The client's issue is authoritative — state and links only, discussion happens there.`,
			"",
			`**State:** ${record.state} · ${new Date().toISOString()}`,
			`**Client issue:** ${record.issueUrl ?? "(no url recorded)"} — session thread, PR and preview links live there.`,
			// The operator brief (PON-170): what the client approved, when,
			// after how many revisions. Renders on every re-render, so a
			// later transition never erases it.
			...(record.clientScope
				? ["", "## Client scope", "", record.clientScope]
				: []),
			...(record.approvedAt
				? [
						"",
						`**Approved:** ${record.approvedAt} · **Revisions:** ${record.revisions ?? 0}`,
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
