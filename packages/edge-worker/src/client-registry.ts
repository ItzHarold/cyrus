/**
 * Who a piece of work is FOR (PON-207).
 *
 * The cockpit's problem was never rendering — it was that nothing in the
 * system knew what a client was. Tenants were Linear workspaces, order was
 * computed per workspace, and identity came from an issue prefix that two
 * clients can share. This module is the missing noun: a commercial entity
 * that owns lanes, holds one or more workspaces, works in one or more teams,
 * and has a name of its own that no Linear rename can take away.
 *
 * Pure resolution. It reads config and answers questions; it writes nothing.
 */

export interface ClientConfig {
	id: string;
	displayName: string;
	workspaces: string[];
	teams?: string[];
	lanes?: number;
	reviewerId?: string;
	cockpitProjectId?: string;
	/**
	 * Does the OPERATOR's own GitHub account have write access to this
	 * client's repository (PON-208, R8)?
	 *
	 * Not derivable and not guessable. The app pushes with its own
	 * installation token, so nothing the platform holds can answer whether a
	 * human at Ponte Digital can clone the repo — a real client's repository
	 * lives in the client's org, where the operator is a stranger. Captured
	 * at onboarding; `undefined` means nobody has said, and the cockpit hedges
	 * rather than printing a checkout command that will fail.
	 */
	operatorRepoAccess?: boolean;
}

/** A resolved client, with the defaults applied. */
export interface ResolvedClient {
	id: string;
	displayName: string;
	/** Lanes bought — the client's share of the operator's attention. */
	lanes: number;
	reviewerId?: string;
	cockpitProjectId?: string;
	/** See ClientConfig.operatorRepoAccess — undefined means "unknown". */
	operatorRepoAccess?: boolean;
	/** True when this client works in more than one team. */
	multiTeam: boolean;
}

/**
 * The bucket for work whose client we cannot name.
 *
 * Deliberately still mirrored. An unconfigured workspace is an operator
 * oversight, and the cost of a mirror labelled "Unassigned" is a moment of
 * confusion; the cost of silently not mirroring is work nobody can see.
 */
export const UNASSIGNED_CLIENT: ResolvedClient = {
	id: "unassigned",
	displayName: "Unassigned client",
	lanes: 1,
	multiTeam: false,
};

export class ClientRegistry {
	private byId = new Map<string, ClientConfig>();
	/** workspaceId → clients holding it, in config order. */
	private byWorkspace = new Map<string, ClientConfig[]>();

	constructor(clients: ClientConfig[] | undefined) {
		for (const client of clients ?? []) {
			this.byId.set(client.id, client);
			for (const workspaceId of client.workspaces) {
				const list = this.byWorkspace.get(workspaceId) ?? [];
				list.push(client);
				this.byWorkspace.set(workspaceId, list);
			}
		}
	}

	/** Is any client configured at all? Absent = pre-PON-207 behaviour. */
	get configured(): boolean {
		return this.byId.size > 0;
	}

	get all(): ResolvedClient[] {
		return [...this.byId.values()].map((c) => this.resolve(c));
	}

	/**
	 * Which client owns this work?
	 *
	 * Resolution is (workspace, team) rather than workspace alone, because one
	 * workspace can host more than one client's teams — and because a client
	 * with several teams must still resolve to one client. A team-scoped
	 * entry wins over a workspace-wide one: the specific declaration is the
	 * one the operator meant.
	 */
	resolveFor(workspaceId: string, teamKey?: string): ResolvedClient {
		const candidates = this.byWorkspace.get(workspaceId) ?? [];
		if (candidates.length === 0) return UNASSIGNED_CLIENT;

		if (teamKey) {
			const scoped = candidates.find((c) => c.teams?.includes(teamKey));
			if (scoped) return this.resolve(scoped);
		}
		// No team match: only a client that claims the WHOLE workspace can
		// answer. If several teams-scoped clients share the workspace and none
		// matched, the honest answer is that we do not know.
		const wholeWorkspace = candidates.find(
			(c) => !c.teams || c.teams.length === 0,
		);
		return wholeWorkspace ? this.resolve(wholeWorkspace) : UNASSIGNED_CLIENT;
	}

	byClientId(clientId: string): ResolvedClient | undefined {
		const client = this.byId.get(clientId);
		return client ? this.resolve(client) : undefined;
	}

	private resolve(client: ClientConfig): ResolvedClient {
		return {
			id: client.id,
			displayName: client.displayName,
			lanes: client.lanes ?? 1,
			multiTeam: (client.teams?.length ?? 0) > 1,
			...(client.reviewerId ? { reviewerId: client.reviewerId } : {}),
			...(client.cockpitProjectId
				? { cockpitProjectId: client.cockpitProjectId }
				: {}),
			...(client.operatorRepoAccess !== undefined
				? { operatorRepoAccess: client.operatorRepoAccess }
				: {}),
		};
	}
}

/**
 * The mirror's title.
 *
 * Client first, always: it is the one thing the operator needs before
 * anything else, and it is the thing the issue key cannot supply. The team
 * appears only when the client has more than one — a chip that says "ACM" to
 * someone with a single team is noise.
 *
 *   Acme Corp · ACM-13 — Dashboard feels slow
 *   Acme Corp · ACMOPS · ACMOPS-4 — Rotate the staging keys
 */
export function buildMirrorTitle(input: {
	client: ResolvedClient;
	issueIdentifier?: string;
	teamKey?: string;
	title?: string;
}): string {
	const parts = [input.client.displayName];
	if (input.client.multiTeam && input.teamKey) parts.push(input.teamKey);
	if (input.issueIdentifier) parts.push(input.issueIdentifier);
	return `${parts.join(" · ")} — ${input.title ?? "(untitled)"}`;
}

/** The team key an issue identifier carries, e.g. "ACM-13" → "ACM". */
export function teamKeyOf(issueIdentifier?: string): string | undefined {
	const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec(issueIdentifier ?? "");
	return match?.[1];
}
