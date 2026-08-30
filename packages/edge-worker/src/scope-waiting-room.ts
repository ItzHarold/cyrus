/**
 * Scope conversations still waiting on a client (PON-219).
 *
 * The cockpit contains only APPROVED work. Before approval the scope
 * conversation belongs to the client and the agent alone, so no mirror exists
 * — which removes the one place an operator could previously notice that a
 * conversation had stalled.
 *
 * ## Why this shape
 *
 * The requirement is "notice a stalled scope conversation, but not in the work
 * queue". Three options were live:
 *
 *   - A second board. Rejected outright: it recreates the problem one level
 *     up, and two boards means two places to forget to look.
 *   - A Linear custom view. Nothing to view — there are no issues to filter,
 *     which is the entire point of the change.
 *   - A digest, delivered somewhere.
 *
 * This is the digest, delivered as ONE issue in the cockpit team that is
 * deliberately NOT in the cockpit project. The board an operator works is the
 * project board, so this never appears in the queue; it is reachable by link,
 * and — the part that matters — a comment on it notifies whoever is
 * subscribed. It costs one row that exists only while something is actually
 * waiting, and closes itself when nothing is.
 *
 * ## Why it holds no state
 *
 * Everything it renders already lives in `ScopeApprovalStore`: which issues
 * have an outstanding reading, and when it was proposed. Giving this module a
 * store of its own would create a second copy of that truth which could drift
 * from the first — the exact failure this project has hit five times. It is a
 * pure function of `listPending()`, so a restart restores it for free and a
 * stale entry is impossible.
 */

import type { ILogger } from "cyrus-core";

/** One conversation waiting on a client, as the room needs it. */
export interface WaitingScope {
	issueId: string;
	issueIdentifier?: string;
	workspaceId?: string;
	proposedAt?: string;
	/** "awaiting" or "revised" — a revision is still the client's turn. */
	state?: string;
}

export interface ScopeWaitingRoomDeps {
	getConfig: () => { linearWorkspaceId: string; teamId: string } | undefined;
	getToken: (workspaceId: string) => string | undefined;
	/** Display name for a tenant workspace, so the list reads in client terms. */
	getClientName: (workspaceId: string | undefined) => string | undefined;
	/** Hours before a waiting conversation is called out. */
	stallAfterHours: () => number;
	now: () => number;
}

/**
 * The title is load-bearing: it must NOT match the mirror title shapes that
 * boot reconciliation adopts and closes (`[ACM-1] …` and `Client · ACM-1 — …`).
 * No bracketed identifier, no ` · IDENT — ` segment. Reconcile scans the team,
 * so a title that looked like a mirror would get closed as an orphan on the
 * next boot, silently.
 */
export const WAITING_ROOM_TITLE = "Scope conversations waiting on clients";

export function renderWaitingRoom(
	entries: WaitingScope[],
	opts: {
		now: number;
		stallAfterHours: number;
		clientName: (ws?: string) => string | undefined;
	},
): string {
	if (!entries.length)
		return "Nothing waiting. Every scope conversation has been answered.";

	const rows = entries
		.slice()
		.sort((a, b) => (a.proposedAt ?? "").localeCompare(b.proposedAt ?? ""))
		.map((e) => {
			const hours = hoursWaiting(e, opts.now);
			const stalled = hours !== undefined && hours >= opts.stallAfterHours;
			return `| ${stalled ? "⏳ " : ""}${e.issueIdentifier ?? e.issueId.slice(0, 8)} | ${
				opts.clientName(e.workspaceId) ?? "—"
			} | ${hours === undefined ? "—" : `${hours}h`} | ${
				e.state === "revised" ? "revision sent" : "awaiting reply"
			} |`;
		});

	return [
		"These issues are mid-scope-conversation with their client. **They are not work yet** — nothing has been approved, so nothing appears on the board.",
		"",
		"This list exists so a conversation that has gone quiet is noticeable. It updates itself and closes when nothing is waiting.",
		"",
		"| Issue | Client | Waiting | State |",
		"| -- | -- | -- | -- |",
		...rows,
		"",
		`⏳ marks a conversation waiting longer than ${opts.stallAfterHours}h.`,
	].join("\n");
}

export function hoursWaiting(
	entry: WaitingScope,
	now: number,
): number | undefined {
	if (!entry.proposedAt) return undefined;
	const at = Date.parse(entry.proposedAt);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, Math.floor((now - at) / 3_600_000));
}

/** Which entries have newly crossed the stall threshold. */
export function newlyStalled(
	entries: WaitingScope[],
	alreadyAnnounced: Set<string>,
	opts: { now: number; stallAfterHours: number },
): WaitingScope[] {
	return entries.filter((e) => {
		if (alreadyAnnounced.has(e.issueId)) return false;
		const hours = hoursWaiting(e, opts.now);
		return hours !== undefined && hours >= opts.stallAfterHours;
	});
}

export class ScopeWaitingRoom {
	private deps: ScopeWaitingRoomDeps;
	private logger: ILogger;
	/** The room's issue id, once created. */
	private issueId: string | undefined;
	/** Issues already called out, so a stall is announced once, not per tick. */
	private announced = new Set<string>();
	/**
	 * True until the first sync completes. A restart loses `announced`, and
	 * without this every boot re-comments on every conversation that was
	 * already quiet — which trains the operator to ignore the one surface
	 * built to be noticed. The row still carries its ⏳ and its age; only the
	 * notification is suppressed, because the notification marks a TRANSITION
	 * into stalled and nothing transitioned while we were down.
	 */
	private firstSync = true;
	/** Serializes writes: ticks and transitions both call sync(). */
	private chain: Promise<void> = Promise.resolve();
	private lastBody: string | undefined;

	constructor(deps: ScopeWaitingRoomDeps, logger: ILogger) {
		this.deps = deps;
		this.logger = logger;
	}

	/**
	 * Bring the room in line with the pending set. Never throws: this is an
	 * operator convenience and must never break a client's scope conversation.
	 */
	sync(entries: WaitingScope[]): Promise<void> {
		this.chain = this.chain
			.then(() => this.apply(entries))
			.catch((error) => {
				this.logger.debug(`Waiting room sync failed: ${String(error)}`);
			});
		return this.chain;
	}

	private async apply(entries: WaitingScope[]): Promise<void> {
		const config = this.deps.getConfig();
		if (!config) return;

		// Anything no longer waiting can be announced again if it comes back.
		const live = new Set(entries.map((e) => e.issueId));
		for (const id of [...this.announced])
			if (!live.has(id)) this.announced.delete(id);

		if (!entries.length) {
			if (this.issueId) {
				await this.closeRoom(config);
			}
			return;
		}

		const now = this.deps.now();
		const stallAfterHours = this.deps.stallAfterHours();
		const body = renderWaitingRoom(entries, {
			now,
			stallAfterHours,
			clientName: (ws) => this.deps.getClientName(ws),
		});

		if (!this.issueId) {
			// Look before creating. A restart loses the id, and minting a
			// second room would be the duplicate-mirror bug again: we shipped
			// an idempotency guard there on an assumed race and it did not
			// help, because the fix was to ADOPT what Linear already had
			// rather than to trust our own map.
			this.issueId = await this.findExistingRoom(config);
		}

		if (!this.issueId) {
			await this.createRoom(config, body);
		} else if (body !== this.lastBody) {
			await this.updateRoom(config, body);
		}
		this.lastBody = body;

		const stalled = newlyStalled(entries, this.announced, {
			now,
			stallAfterHours,
		});
		for (const entry of stalled) {
			this.announced.add(entry.issueId);
			if (!this.firstSync) await this.announce(config, entry, now);
		}
		this.firstSync = false;
	}

	/** An open issue in the cockpit team with the room's exact title, if any. */
	private async findExistingRoom(config: {
		linearWorkspaceId: string;
		teamId: string;
	}): Promise<string | undefined> {
		const data = await this.gql<{
			team: { issues: { nodes: Array<{ id: string; title: string }> } };
		}>(
			config.linearWorkspaceId,
			// Filtered by TITLE server-side, not scanned client-side. A
			// cockpit team accumulates delivered mirrors, and a room that
			// happened to fall outside the first page would be re-created —
			// duplicate rooms, each with a divergent list, only one of which
			// ever updates or closes.
			`query($id:String!,$title:String!){ team(id:$id){ issues(first:10, filter:{ title:{ eq:$title }, state:{ type:{ nin:["completed","canceled"] } } }){ nodes{ id title } } } }`,
			{ id: config.teamId, title: WAITING_ROOM_TITLE },
		);
		return data?.team?.issues?.nodes?.find(
			(i) => i.title === WAITING_ROOM_TITLE,
		)?.id;
	}

	private async createRoom(
		config: { linearWorkspaceId: string; teamId: string },
		body: string,
	): Promise<void> {
		const data = await this.gql<{
			issueCreate: { issue: { id: string } | null };
		}>(
			config.linearWorkspaceId,
			`mutation($input: IssueCreateInput!){ issueCreate(input:$input){ issue{ id } } }`,
			{
				input: {
					teamId: config.teamId,
					title: WAITING_ROOM_TITLE,
					description: body,
					// Deliberately no projectId: the project board is the work
					// queue, and this is not work.
				},
			},
		);
		this.issueId = data?.issueCreate?.issue?.id;
		this.logger.info(
			`[event:scope_waiting_room_opened] ${JSON.stringify({ issueId: this.issueId })}`,
		);
	}

	private async updateRoom(
		config: { linearWorkspaceId: string; teamId: string },
		body: string,
	): Promise<void> {
		await this.gql(
			config.linearWorkspaceId,
			`mutation($id:String!,$input: IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`,
			{ id: this.issueId, input: { description: body } },
		);
	}

	private async closeRoom(config: {
		linearWorkspaceId: string;
		teamId: string;
	}): Promise<void> {
		const states = await this.gql<{
			team: { states: { nodes: Array<{ id: string; type: string }> } };
		}>(
			config.linearWorkspaceId,
			`query($id:String!){ team(id:$id){ states(first:30){ nodes{ id type } } } }`,
			{ id: config.teamId },
		);
		const done = states?.team?.states?.nodes?.find(
			(s) => s.type === "completed",
		);
		if (done) {
			await this.gql(
				config.linearWorkspaceId,
				`mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }`,
				{ id: this.issueId, s: done.id },
			);
		}
		this.logger.info(
			`[event:scope_waiting_room_closed] ${JSON.stringify({ issueId: this.issueId })}`,
		);
		this.issueId = undefined;
		this.lastBody = undefined;
	}

	private async announce(
		config: { linearWorkspaceId: string; teamId: string },
		entry: WaitingScope,
		now: number,
	): Promise<void> {
		const hours = hoursWaiting(entry, now);
		await this.gql(
			config.linearWorkspaceId,
			`mutation($input: CommentCreateInput!){ commentCreate(input:$input){ success } }`,
			{
				input: {
					issueId: this.issueId,
					body: `**${entry.issueIdentifier ?? entry.issueId.slice(0, 8)}** has been waiting ${hours}h for the client to answer its scope. Worth a nudge, or worth asking whether the scope reading landed badly.`,
				},
			},
		);
		this.logger.info(
			`[event:scope_conversation_stalled] ${JSON.stringify({
				issueIdentifier: entry.issueIdentifier,
				hours,
			})}`,
		);
	}

	private async gql<T = unknown>(
		workspaceId: string,
		query: string,
		variables: Record<string, unknown>,
	): Promise<T | undefined> {
		const token = this.deps.getToken(workspaceId);
		if (!token) return undefined;
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: token },
			body: JSON.stringify({ query, variables }),
		});
		const json = (await response.json()) as { data?: T; errors?: unknown };
		if (json.errors) {
			this.logger.debug(
				`Waiting room GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`,
			);
			return undefined;
		}
		return json.data;
	}
}
