import {
	AgentActivitySignal,
	type AgentSessionCreatedWebhook,
	type AgentSessionPromptedWebhook,
	createLogger,
	type IIssueTrackerService,
	type ILogger,
	type RepositoryConfig,
	type Webhook,
} from "cyrus-core";
import { isForeignCockpitMirror } from "./CockpitMirror.js";
import { CLIENT_MESSAGES } from "./client-messages.js";

/**
 * Repository routing result types
 */
export type RepositoryRoutingResult =
	| {
			type: "selected";
			repositories: RepositoryConfig[];
			/** Per-repo base branch overrides from [repo=name#branch] syntax */
			baseBranchOverrides?: Map<string, string>;
			routingMethod:
				| "description-tag"
				| "label-based"
				| "project-based"
				| "team-based"
				| "workspace-fallback";
	  }
	// TENANT ISOLATION / repo routing (2026-09-02): the two no-single-repo
	// outcomes are DIFFERENT decisions and must not be conflated.
	//
	// `ambiguous` — one implicit mechanism (a team key or a project) matched
	// MORE THAN ONE repo. The mapping exists but does not resolve; the fix is a
	// routing label, so we ask (canonical elicitation among the candidates).
	//
	// `unmapped` — NOTHING matched. There is no mapping for this team yet, and
	// the agent must never guess one: it refuses in client language and
	// notifies the operator. This replaces the old `needs_selection`, which
	// asked the CLIENT to pick a repo from the whole workspace — leaking the
	// internal routing concept and, with a catch-all present, silently guessing.
	| {
			type: "ambiguous";
			candidates: RepositoryConfig[];
			routingMethod: "team-based" | "project-based";
	  }
	| { type: "unmapped"; workspaceRepos: RepositoryConfig[] }
	| { type: "none" };

/**
 * Pending repository selection data
 */
export interface PendingRepositorySelection {
	issueId: string;
	workspaceRepos: RepositoryConfig[];
}

/**
 * Repository router dependencies
 */
export interface RepositoryRouterDeps {
	/** Fetch issue labels for label-based routing */
	fetchIssueLabels: (issueId: string, workspaceId: string) => Promise<string[]>;

	/** Fetch issue description for description-tag routing */
	fetchIssueDescription: (
		issueId: string,
		workspaceId: string,
	) => Promise<string | undefined>;

	/** Check if an issue has active sessions in a repository */
	hasActiveSession: (issueId: string, repositoryId: string) => boolean;

	/** Get issue tracker service for a workspace */
	getIssueTracker: (workspaceId: string) => IIssueTrackerService | undefined;
	/**
	 * PON-194: policy-sanitize text bound for a client surface. Optional —
	 * absent means post verbatim, as before.
	 */
	sanitizeClientText?: (sessionId: string, text: string) => string;

	/**
	 * Requirement 2a: notify the operator that an issue arrived from a team with
	 * no repository mapping (beyond the journal event). Optional and
	 * best-effort — the client refusal and the journal event fire regardless.
	 */
	notifyOperatorUnmapped?: (info: {
		teamKey: string;
		workspaceId: string;
		issueIdentifier?: string;
	}) => Promise<void>;
}

/**
 * RepositoryRouter handles all repository routing logic including:
 * - Multi-priority routing (labels, projects, teams)
 * - Issue-to-repository caching
 * - Repository selection UI via Linear elicitation
 * - Selection response handling
 *
 * This class was extracted from EdgeWorker to improve modularity and testability.
 */
export class RepositoryRouter {
	/** Cache mapping issue IDs to selected repository IDs (array for multi-repo) */
	private issueRepositoryCache = new Map<string, string[]>();

	/** Pending repository selections awaiting user response */
	private pendingSelections = new Map<string, PendingRepositorySelection>();

	private logger: ILogger;

	constructor(
		private deps: RepositoryRouterDeps,
		logger?: ILogger,
	) {
		this.logger = logger ?? createLogger({ component: "RepositoryRouter" });
	}

	/**
	 * Get cached repositories for an issue
	 *
	 * This is a simple cache lookup used by agentSessionPrompted webhooks (Branch 3).
	 * Per CLAUDE.md: "The repository will be retrieved from the issue-to-repository
	 * cache - no new routing logic is performed."
	 *
	 * @param issueId The Linear issue ID
	 * @param repositoriesMap Map of repository IDs to configurations
	 * @returns The cached repositories array, or null if not found
	 */
	getCachedRepositories(
		issueId: string,
		repositoriesMap: Map<string, RepositoryConfig>,
	): RepositoryConfig[] | null {
		const cachedRepositoryIds = this.issueRepositoryCache.get(issueId);
		if (!cachedRepositoryIds || cachedRepositoryIds.length === 0) {
			this.logger.debug(`No cached repository found for issue ${issueId}`);
			return null;
		}

		const resolvedRepos: RepositoryConfig[] = [];
		const invalidIds: string[] = [];

		for (const repoId of cachedRepositoryIds) {
			const repo = repositoriesMap.get(repoId);
			if (repo) {
				resolvedRepos.push(repo);
			} else {
				invalidIds.push(repoId);
			}
		}

		if (invalidIds.length > 0) {
			this.logger.warn(
				`Cached repositories [${invalidIds.join(", ")}] no longer exist, cleaning cache`,
			);
			if (resolvedRepos.length === 0) {
				this.issueRepositoryCache.delete(issueId);
				return null;
			}
			// Update cache to only contain valid IDs
			this.issueRepositoryCache.set(
				issueId,
				resolvedRepos.map((r) => r.id),
			);
		}

		this.logger.debug(
			`Using cached repositories [${resolvedRepos.map((r) => r.name).join(", ")}] for issue ${issueId}`,
		);
		return resolvedRepos;
	}

	/**
	 * Determine repositories for webhook using multi-priority routing:
	 * Priority 0: Existing active sessions
	 * Priority 1: Description tag (explicit [repo=...] in issue description)
	 * Priority 2: Routing labels
	 * Priority 3: Project-based routing
	 * Priority 4: Team-based routing (team key, then identifier prefix)
	 *
	 * Description-tag and label-based routing, when matched, skip lower-priority routing.
	 * An implicit mechanism (team/project) matching >1 repo returns `ambiguous`.
	 * If nothing matches, returns `unmapped` — the agent refuses and notifies
	 * the operator; it NEVER guesses a repo (there is no catch-all).
	 */
	async determineRepositoryForWebhook(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repos: RepositoryConfig[],
	): Promise<RepositoryRoutingResult> {
		const workspaceId = webhook.organizationId;
		if (!workspaceId) {
			// PON-112 hardening: never fall back to repos[0] for a webhook
			// without a workspace id. Linear always sends organizationId; a
			// payload without one must not route into an arbitrary repository.
			this.logger.warn(
				"Webhook without organizationId — refusing to route to a repository",
			);
			return { type: "none" };
		}

		// Extract issue information
		const { issueId, teamKey, issueIdentifier } =
			this.extractIssueInfo(webhook);

		// Filter repos by workspace. This happens BEFORE every routing
		// priority, including the active-session check: no routing path may
		// ever consider a repository belonging to another tenant, however it
		// matches (PON-189). Two tenants sharing a team key is normal — team
		// keys are workspace-local, and "ACM" in one client's Linear has
		// nothing to do with "ACM" in another's.
		const workspaceRepos = repos.filter(
			(repo) => repo.linearWorkspaceId === workspaceId,
		);
		// A workspace with NO repository footprint at all is a silent drop, as
		// before — it is almost certainly not a tenant we serve (an agent can be
		// @mentioned in any workspace it is installed in), so speaking to it
		// would be noise. The unmapped-team REFUSAL (2a) is reserved for the
		// case that actually matters: a served workspace that HAS repositories
		// but none is mapped to the team on this issue (handled at the end).
		if (workspaceRepos.length === 0) return { type: "none" };

		// Priority 0: Check for existing active sessions
		// TODO: Remove this priority check - existing session detection should not be a routing method
		if (issueId) {
			const activeRepos: RepositoryConfig[] = [];
			for (const repo of workspaceRepos) {
				if (this.deps.hasActiveSession(issueId, repo.id)) {
					activeRepos.push(repo);
				}
			}
			if (activeRepos.length > 0) {
				this.logger.info(
					`Repositories selected: [${activeRepos.map((r) => r.name).join(", ")}] (existing active session)`,
				);
				return {
					type: "selected",
					repositories: activeRepos,
					routingMethod: "workspace-fallback",
				};
			}
		}

		// Priority 1: Check description tags [repo=...] (supports multiple, with optional #branch)
		const descriptionTagResult = await this.findRepositoriesByDescriptionTag(
			issueId,
			workspaceRepos,
			workspaceId,
		);
		if (descriptionTagResult.repositories.length > 0) {
			this.logger.info(
				`Repositories selected: [${descriptionTagResult.repositories.map((r) => r.name).join(", ")}] (description-tag routing)`,
			);
			if (descriptionTagResult.baseBranchOverrides.size > 0) {
				const overrideEntries = Array.from(
					descriptionTagResult.baseBranchOverrides.entries(),
				)
					.map(([id, branch]) => `${id}→${branch}`)
					.join(", ");
				this.logger.info(
					`Base branch overrides from description tags: ${overrideEntries}`,
				);
			}
			return {
				type: "selected",
				repositories: descriptionTagResult.repositories,
				baseBranchOverrides:
					descriptionTagResult.baseBranchOverrides.size > 0
						? descriptionTagResult.baseBranchOverrides
						: undefined,
				routingMethod: "description-tag",
			};
		}

		// Priority 2: Check routing labels
		const labelMatchedRepos = await this.findRepositoriesByLabels(
			issueId,
			workspaceRepos,
			workspaceId,
		);
		if (labelMatchedRepos.length > 0) {
			this.logger.info(
				`Repositories selected: [${labelMatchedRepos.map((r) => r.name).join(", ")}] (label-based routing)`,
			);
			return {
				type: "selected",
				repositories: labelMatchedRepos,
				routingMethod: "label-based",
			};
		}

		// Priority 3: Check project-based routing. More than one repo claiming
		// the same project is ambiguous — the mapping exists but does not
		// resolve, so we ask rather than silently take the first (the old
		// `.find` behaviour was a hidden guess).
		if (issueId) {
			const projectMatchedRepos = await this.findRepositoriesByProject(
				issueId,
				workspaceRepos,
				workspaceId,
			);
			if (projectMatchedRepos.length === 1) {
				const repo = projectMatchedRepos[0] as RepositoryConfig;
				this.logger.info(
					`Repository selected: ${repo.name} (project-based routing)`,
				);
				return {
					type: "selected",
					repositories: [repo],
					routingMethod: "project-based",
				};
			}
			if (projectMatchedRepos.length > 1) {
				this.logger.warn(
					`Ambiguous project routing: [${projectMatchedRepos.map((r) => r.name).join(", ")}] all claim this project — asking for the routing label`,
				);
				return {
					type: "ambiguous",
					candidates: projectMatchedRepos,
					routingMethod: "project-based",
				};
			}
		}

		// Priority 4: Check team-based routing (team key on the issue, then the
		// team prefix parsed from its identifier). Same rule: two repos mapping
		// the same team key is ambiguous, not first-wins.
		const teamKeys = [teamKey, issueIdentifier?.split("-")[0]].filter(
			(k): k is string => Boolean(k),
		);
		for (const key of teamKeys) {
			const teamMatchedRepos = this.findRepositoriesByTeamKey(
				key,
				workspaceRepos,
			);
			if (teamMatchedRepos.length === 1) {
				const repo = teamMatchedRepos[0] as RepositoryConfig;
				this.logger.info(
					`Repository selected: ${repo.name} (team-based routing, key ${key})`,
				);
				return {
					type: "selected",
					repositories: [repo],
					routingMethod: "team-based",
				};
			}
			if (teamMatchedRepos.length > 1) {
				this.logger.warn(
					`Ambiguous team routing for ${key}: [${teamMatchedRepos.map((r) => r.name).join(", ")}] — asking for the routing label`,
				);
				return {
					type: "ambiguous",
					candidates: teamMatchedRepos,
					routingMethod: "team-based",
				};
			}
		}

		// Nothing matched. There is no mapping for this team — refuse and notify
		// the operator; NEVER guess a repo (the catch-all that used to route any
		// no-config repo here was removed with this change: repo routing must be
		// an explicit mapping — PON-223 tenant/routing invariant).
		this.logger.info(
			`[event:repo_unmapped] no repository is mapped for this issue among ${workspaceRepos.length} workspace repo(s) — refusing, operator notified`,
		);
		return { type: "unmapped", workspaceRepos };
	}

	/**
	 * Find all repositories matching routing labels
	 */
	private async findRepositoriesByLabels(
		issueId: string | undefined,
		repos: RepositoryConfig[],
		workspaceId: string,
	): Promise<RepositoryConfig[]> {
		if (!issueId) return [];

		const reposWithRoutingLabels = repos.filter(
			(repo) => repo.routingLabels && repo.routingLabels.length > 0,
		);

		if (reposWithRoutingLabels.length === 0) return [];

		try {
			const labels = await this.deps.fetchIssueLabels(issueId, workspaceId);

			const matched: RepositoryConfig[] = [];
			for (const repo of reposWithRoutingLabels) {
				if (
					repo.routingLabels?.some((routingLabel: string) =>
						labels.includes(routingLabel),
					)
				) {
					matched.push(repo);
				}
			}
			return matched;
		} catch (error) {
			this.logger.error(`Failed to fetch labels for routing:`, error);
		}

		return [];
	}

	/**
	 * Find all repositories matching description tags
	 *
	 * Parses the issue description for repo tags and matches against:
	 * - Repository GitHub URL (endsWith /repo-name)
	 * - Repository name
	 * - Repository ID
	 *
	 * Supported tag syntaxes:
	 * - [repo=my-repo-name] or [repo=my-repo-name#branch]
	 * - repo=frontend,backend#branch
	 * - repos=frontend,backend
	 */
	private async findRepositoriesByDescriptionTag(
		issueId: string | undefined,
		repos: RepositoryConfig[],
		workspaceId: string,
	): Promise<{
		repositories: RepositoryConfig[];
		baseBranchOverrides: Map<string, string>;
	}> {
		if (!issueId) return { repositories: [], baseBranchOverrides: new Map() };

		try {
			const description = await this.deps.fetchIssueDescription(
				issueId,
				workspaceId,
			);
			if (!description)
				return { repositories: [], baseBranchOverrides: new Map() };

			const repoTags = this.parseRepoTagsFromDescription(description);
			if (repoTags.length === 0)
				return { repositories: [], baseBranchOverrides: new Map() };

			this.logger.info(
				`Found repo tags in issue description: [${repoTags.map((t) => (t.branch ? `${t.repo}#${t.branch}` : t.repo)).join(", ")}]`,
			);

			const matched: RepositoryConfig[] = [];
			const matchedIds = new Set<string>();
			const baseBranchOverrides = new Map<string, string>();

			for (const repoTag of repoTags) {
				for (const repo of repos) {
					if (matchedIds.has(repo.id)) continue;

					let isMatch = false;

					// Match by GitHub/GitLab URL path segment (e.g., "org/repo-name" or "repo-name")
					// Use endsWith to avoid substring false positives (e.g., "cyrus" matching "cyrus-hosted")
					if (
						repo.githubUrl?.endsWith(`/${repoTag.repo}`) ||
						repo.githubUrl?.endsWith(`/${repoTag.repo}.git`) ||
						repo.gitlabUrl?.endsWith(`/${repoTag.repo}`) ||
						repo.gitlabUrl?.endsWith(`/${repoTag.repo}.git`)
					) {
						this.logger.debug(
							`Matched repo tag "${repoTag.repo}" to repository ${repo.name} via hosting URL`,
						);
						isMatch = true;
					}

					// Match by repository name (exact match, case-insensitive)
					if (
						!isMatch &&
						repo.name.toLowerCase() === repoTag.repo.toLowerCase()
					) {
						this.logger.debug(
							`Matched repo tag "${repoTag.repo}" to repository ${repo.name} via name`,
						);
						isMatch = true;
					}

					// Match by repository ID
					if (!isMatch && repo.id === repoTag.repo) {
						this.logger.debug(
							`Matched repo tag "${repoTag.repo}" to repository ${repo.name} via ID`,
						);
						isMatch = true;
					}

					if (isMatch) {
						matched.push(repo);
						matchedIds.add(repo.id);
						if (repoTag.branch) {
							baseBranchOverrides.set(repo.id, repoTag.branch);
							this.logger.debug(
								`Base branch override for ${repo.name}: ${repoTag.branch}`,
							);
						}
					}
				}
			}

			if (matched.length === 0) {
				this.logger.debug(
					`No repositories matched [repo=...] tags: [${repoTags.map((t) => t.repo).join(", ")}]`,
				);
			}
			return { repositories: matched, baseBranchOverrides };
		} catch (error) {
			this.logger.error(`Failed to fetch description for routing:`, error);
		}

		return { repositories: [], baseBranchOverrides: new Map() };
	}

	/**
	 * Parse repo tags from issue description
	 *
	 * Supported syntaxes:
	 * - `[repo=name]` or `[repo=name#branch]` — bracketed, single repo per tag
	 * - `repo=name,name2#branch` — unbracketed, comma-separated repos with optional branch
	 * - `repos=name,name2#branch` — same as above with plural "repos"
	 *
	 * Also handles escaped brackets (\\[repo=...\\]) which Linear may produce.
	 *
	 * Returns array of parsed tags with optional branch overrides.
	 */
	parseRepoTagsFromDescription(
		description: string,
	): { repo: string; branch?: string }[] {
		const tags: { repo: string; branch?: string }[] = [];

		// Pattern 1: Bracketed [repo=...] (existing syntax)
		// Matches: [repo=name], [repo=name#branch], \[repo=name\]
		const bracketRegex = /\\?\[repo=([a-zA-Z0-9_\-/.#]+)\\?\]/g;
		for (const match of description.matchAll(bracketRegex)) {
			if (match[1]) {
				tags.push(...this.parseRepoValue(match[1]));
			}
		}

		// Pattern 2: Unbracketed repos?=... (new syntax)
		// Matches: repo=name, repos=name,name2, repo=name,name2#branch
		// Must be at start of line or after whitespace to avoid matching inside URLs/paths
		const unbracketedRegex = /(?:^|[\s\n])repos?=([a-zA-Z0-9_\-/.#,]+)/gm;
		for (const match of description.matchAll(unbracketedRegex)) {
			if (match[1]) {
				tags.push(...this.parseRepoValue(match[1]));
			}
		}

		// Deduplicate by repo name (keep first occurrence)
		const seen = new Set<string>();
		return tags.filter((tag) => {
			if (seen.has(tag.repo)) return false;
			seen.add(tag.repo);
			return true;
		});
	}

	/**
	 * Parse a repo value that may contain commas (multiple repos) and #branch.
	 * The #branch suffix applies to all repos in a comma-separated list.
	 */
	private parseRepoValue(value: string): { repo: string; branch?: string }[] {
		// Split branch from the end: everything after the last # that follows a repo name
		const hashIndex = value.indexOf("#");
		let reposPart: string;
		let branch: string | undefined;

		if (hashIndex !== -1) {
			reposPart = value.slice(0, hashIndex);
			branch = value.slice(hashIndex + 1);
			if (!branch) branch = undefined;
		} else {
			reposPart = value;
		}

		// Split comma-separated repos
		const repos = reposPart
			.split(",")
			.map((r) => r.trim())
			.filter((r) => r.length > 0);

		return repos.map((repo) => (branch ? { repo, branch } : { repo }));
	}

	/**
	 * Find EVERY repository mapping a team key. Returns all matches so the
	 * caller can tell a clean 1:1 mapping from an ambiguous one (two repos
	 * claiming one team key) — the old single-repo `.find` hid the second.
	 */
	private findRepositoriesByTeamKey(
		teamKey: string,
		repos: RepositoryConfig[],
	): RepositoryConfig[] {
		return repos.filter((r) => r.teamKeys?.includes(teamKey));
	}

	/**
	 * Find EVERY repository whose projectKeys include the project on the issue.
	 * Returns all matches (see findRepositoriesByTeamKey for why).
	 */
	private async findRepositoriesByProject(
		issueId: string,
		repos: RepositoryConfig[],
		workspaceId: string,
	): Promise<RepositoryConfig[]> {
		const reposWithProjectKeys = repos.filter(
			(repo) => repo.projectKeys && repo.projectKeys.length > 0,
		);
		if (reposWithProjectKeys.length === 0) return [];

		try {
			const issueTracker = this.deps.getIssueTracker(workspaceId);
			if (!issueTracker) {
				this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
				return [];
			}
			// The project is a fact about the ISSUE, fetched once, then matched
			// against every repo — not re-fetched per repo as the old loop did.
			const fullIssue = await issueTracker.fetchIssue(issueId);
			const projectName = (await fullIssue?.project)?.name;
			if (!projectName) {
				this.logger.debug(`No project name found for issue ${issueId}`);
				return [];
			}
			return reposWithProjectKeys.filter((repo) =>
				repo.projectKeys?.includes(projectName),
			);
		} catch (error) {
			this.logger.debug(`Failed to fetch project for issue ${issueId}:`, error);
			return [];
		}
	}

	/**
	 * PON-211: a mirror belonging to ANOTHER agent in this workspace. Several
	 * agents can be installed in one Linear workspace and a cockpit team lives
	 * in one of them, so every agent there is mentionable on every mirror and
	 * all but one have no idea what the issue is. Recognise it by shape and
	 * refuse, loudly, naming who can answer — no session, no elicitation, no
	 * pending selection. Shared by both no-single-repo outcomes. Returns true
	 * when it handled the webhook (the caller must then stop).
	 */
	private async refuseForeignCockpitMirror(
		webhook: AgentSessionCreatedWebhook,
	): Promise<boolean> {
		const { issue } = webhook.agentSession;
		if (!issue || !isForeignCockpitMirror(issue.title)) return false;
		this.logger.warn(
			`Refusing ${issue.identifier}: it is another agent's cockpit mirror`,
		);
		const tracker = this.deps.getIssueTracker(webhook.organizationId);
		await tracker?.createAgentActivity?.({
			agentSessionId: webhook.agentSession.id,
			content: {
				type: "error",
				body: "This is another agent's cockpit mirror — I can't see the work behind it, so there's nothing here for me to do. The mirror names the agent that can: look for the \"Work this with @…\" line in the description and delegate it to that one instead.",
			},
		});
		return true;
	}

	/**
	 * Unmapped team (requirement 2a): NO repository is mapped for the team on
	 * this issue. Refuse in client language, notify the operator, and start
	 * nothing. Critically it opens NO pending selection: a missing mapping is
	 * an onboarding fact only the operator can fix — the client is never asked
	 * to pick a repository (that leaked the internal routing concept and, with
	 * the old catch-all, silently guessed). Best-effort throughout: a workspace
	 * we do not serve has no tracker, so the client post is a no-op and only the
	 * journal event fires.
	 */
	async refuseUnmappedRepository(
		webhook: AgentSessionCreatedWebhook,
		workspaceRepos: RepositoryConfig[],
	): Promise<void> {
		const { agentSession, organizationId } = webhook;
		const { issue } = agentSession;
		if (!issue) {
			this.logger.error("Cannot refuse unmapped repository without issue");
			return;
		}
		if (await this.refuseForeignCockpitMirror(webhook)) return;

		const { teamKey, issueIdentifier } = this.extractIssueInfo(webhook);
		const team = teamKey ?? issueIdentifier?.split("-")[0] ?? "(unknown)";
		this.logger.warn(
			`[event:repo_unmapped] team=${team} workspace=${organizationId} issue=${issue.identifier} repos_in_workspace=${workspaceRepos.length}`,
		);
		// Operator notification beyond the journal (best-effort — a cockpit
		// inbox comment naming the team to map). Never fails the refusal.
		try {
			await this.deps.notifyOperatorUnmapped?.({
				teamKey: team,
				workspaceId: organizationId,
				issueIdentifier: issue.identifier,
			});
		} catch (error) {
			this.logger.error("Failed to notify operator of unmapped team:", error);
		}

		const issueTracker = this.deps.getIssueTracker(organizationId);
		try {
			await issueTracker?.createAgentActivity?.({
				agentSessionId: agentSession.id,
				content: {
					type: "error",
					body: CLIENT_MESSAGES.repositoryNotConnected(),
				},
			});
		} catch (error) {
			this.logger.error("Failed to post unmapped-repository refusal:", error);
		}
	}

	/**
	 * Ambiguous route (requirement 2b): an implicit mechanism (a team key or a
	 * project) matched MORE THAN ONE repository. Ask, once, with a canonical
	 * Select among the candidates — the repo the client picks is effectively
	 * the routing label that resolves it. Reuses the pending-selection
	 * machinery; the reply is resolved in selectRepositoryFromResponse.
	 */
	async elicitAmbiguousRepository(
		webhook: AgentSessionCreatedWebhook,
		candidates: RepositoryConfig[],
	): Promise<void> {
		const { agentSession, organizationId } = webhook;
		const { issue } = agentSession;
		if (!issue) {
			this.logger.error("Cannot elicit repository selection without issue");
			return;
		}
		if (await this.refuseForeignCockpitMirror(webhook)) return;

		const agentSessionId = agentSession.id;
		this.logger.info(
			`Posting ambiguous-route elicitation for ${issue.identifier} (${candidates.length} candidates)`,
		);
		// Store pending selection (the candidate set, not the whole workspace).
		this.pendingSelections.set(agentSessionId, {
			issueId: issue.id,
			workspaceRepos: candidates,
		});

		const issueTracker = this.deps.getIssueTracker(organizationId);
		if (!issueTracker) {
			this.logger.error(
				`No issue tracker found for workspace ${organizationId}`,
			);
			return;
		}

		// The option value is the repository NAME (PON-142): the URL Linear
		// echoes back did not string-match config, so a click missed the lookup
		// and the router silently used the first repo. The name is what the
		// matcher resolves, so a click answers by construction. PON-194: a
		// select option is a client surface — sanitize the label.
		const options = candidates.map((repo) => ({
			value:
				this.deps.sanitizeClientText?.(agentSessionId, repo.name) ?? repo.name,
		}));

		try {
			await issueTracker.createAgentActivity({
				agentSessionId,
				content: {
					type: "elicitation",
					body: CLIENT_MESSAGES.repositoryAmbiguous(),
				},
				signal: AgentActivitySignal.Select,
				signalMetadata: { options },
			});
			this.logger.info(
				`Posted ambiguous-route elicitation with ${options.length} options`,
			);
		} catch (error) {
			this.logger.error("Failed to post ambiguous-route elicitation:", error);
			await this.postRepositorySelectionError(
				agentSessionId,
				issueTracker,
				error,
			);
			this.pendingSelections.delete(agentSessionId);
		}
	}

	/**
	 * Post error activity when repository selection fails
	 */
	private async postRepositorySelectionError(
		agentSessionId: string,
		issueTracker: IIssueTrackerService,
		error: unknown,
	): Promise<void> {
		const errorObj = error as Error;
		const errorMessage = errorObj?.message || String(error);
		// PON-194: the exception goes to the operator, never to the client. It
		// is whatever the SDK/GraphQL/undici threw one statement earlier —
		// stack text, payloads, sometimes request URLs — and the static sweep
		// cannot see an interpolation.
		this.logger.error(`[event:repository_selection_failed] ${errorMessage}`);

		try {
			await issueTracker.createAgentActivity({
				agentSessionId,
				content: {
					type: "error",
					body: CLIENT_MESSAGES.repositorySelectionUnavailable(),
				},
			});
			this.logger.info(
				`Posted error activity for repository selection failure`,
			);
		} catch (postError) {
			this.logger.error(
				`Failed to post error activity (may be due to same underlying issue):`,
				postError,
			);
		}
	}

	/**
	 * Select repository from user response
	 * Returns the selected repository or null if webhook should not be processed further
	 */
	async selectRepositoryFromResponse(
		agentSessionId: string,
		selectedRepositoryName: string,
	): Promise<RepositoryConfig | null> {
		const pendingData = this.pendingSelections.get(agentSessionId);
		if (!pendingData) {
			this.logger.debug(
				`No pending repository selection found for agent session ${agentSessionId}`,
			);
			return null;
		}

		// Resolve the answer (PON-142). Three tiers, most exact first:
		//   1. name  — what the options now carry, so a click matches here
		//   2. id    — future-proof, and unambiguous if ever used as a value
		//   3. URL, normalized — kept for one reason: a selection posted by a
		//      build that predates this fix replies with a URL, and a deploy in
		//      between must not strand that in-flight answer. Normalized because
		//      the mismatch that caused this whole defect was ".git" and case.
		const answer = selectedRepositoryName.trim();
		const normalizeUrl = (u: string | undefined): string | null =>
			u
				? u
						.trim()
						.toLowerCase()
						.replace(/\.git$/, "")
						.replace(/\/+$/, "")
				: null;
		const answerAsUrl = normalizeUrl(answer);
		const selectedRepo =
			pendingData.workspaceRepos.find((repo) => repo.name === answer) ??
			pendingData.workspaceRepos.find((repo) => repo.id === answer) ??
			pendingData.workspaceRepos.find(
				(repo) =>
					normalizeUrl(repo.githubUrl) === answerAsUrl ||
					normalizeUrl(repo.gitlabUrl) === answerAsUrl,
			);

		if (selectedRepo) {
			// Resolved — the selection is done; drop the pending entry.
			this.pendingSelections.delete(agentSessionId);
			this.logger.info(`User selected repository: ${selectedRepo.name}`);
			return selectedRepo;
		}

		// Nothing matched. This is an ambiguous-route ask (the only path that
		// opens a pending selection now), and the reply picked none of the
		// candidates. NEVER guess a candidate (the old code ran the first
		// configured repo — a silent misroute). Keep the pending selection alive
		// and return null; the caller re-posts the ask so a click still
		// resolves. A client who never picks simply never starts — correct: we
		// do not choose a tenant repository for them.
		this.logger.warn(
			`[event:repo_selection_unresolved] reply ${JSON.stringify(answer.slice(0, 120))} matched no offered repository (offered: ${pendingData.workspaceRepos.map((r) => r.name).join(", ")}); NOT guessing — re-asking`,
		);
		return null;
	}

	/**
	 * Re-post the pending ambiguous-route Select for a session whose last reply
	 * matched no candidate. Reads the retained pending candidates so the caller
	 * need not hold them. No-op if there is no pending selection.
	 */
	async repostPendingSelection(
		agentSessionId: string,
		workspaceId: string,
	): Promise<void> {
		const pending = this.pendingSelections.get(agentSessionId);
		if (!pending) return;
		const issueTracker = this.deps.getIssueTracker(workspaceId);
		if (!issueTracker) return;
		const options = pending.workspaceRepos.map((repo) => ({
			value:
				this.deps.sanitizeClientText?.(agentSessionId, repo.name) ?? repo.name,
		}));
		try {
			await issueTracker.createAgentActivity({
				agentSessionId,
				content: {
					type: "elicitation",
					body: CLIENT_MESSAGES.repositoryAmbiguous(),
				},
				signal: AgentActivitySignal.Select,
				signalMetadata: { options },
			});
		} catch (error) {
			this.logger.error(
				"Failed to re-post ambiguous-route elicitation:",
				error,
			);
		}
	}

	/**
	 * Check if there's a pending repository selection for this agent session
	 */
	hasPendingSelection(agentSessionId: string): boolean {
		return this.pendingSelections.has(agentSessionId);
	}

	/**
	 * Extract issue information from webhook
	 */
	private extractIssueInfo(webhook: Webhook): {
		issueId?: string;
		teamKey?: string;
		issueIdentifier?: string;
	} {
		// Handle agent session webhooks
		if (
			this.isAgentSessionCreatedWebhook(webhook) ||
			this.isAgentSessionPromptedWebhook(webhook)
		) {
			return {
				issueId: webhook.agentSession?.issue?.id,
				teamKey: webhook.agentSession?.issue?.team?.key,
				issueIdentifier: webhook.agentSession?.issue?.identifier,
			};
		}

		// Handle entity webhooks (e.g., Issue updates)
		if (this.isEntityWebhook(webhook)) {
			// For Issue entity webhooks, data contains the issue payload
			if (webhook.type === "Issue") {
				const issueData = webhook.data as {
					id?: string;
					identifier?: string;
					team?: { key?: string };
				};
				return {
					issueId: issueData?.id,
					teamKey: issueData?.team?.key,
					issueIdentifier: issueData?.identifier,
				};
			}
			// Other entity types don't have issue info
			return {};
		}

		// Handle notification webhooks (AppUserNotification)
		if ("notification" in webhook && webhook.notification) {
			return {
				issueId: webhook.notification?.issue?.id,
				teamKey: webhook.notification?.issue?.team?.key,
				issueIdentifier: webhook.notification?.issue?.identifier,
			};
		}

		return {};
	}

	/**
	 * Type guard for entity webhooks (Issue, Comment, etc.)
	 */
	private isEntityWebhook(
		webhook: Webhook,
	): webhook is Webhook & { data: unknown } {
		return "data" in webhook && webhook.data !== undefined;
	}

	/**
	 * Type guards
	 */
	private isAgentSessionCreatedWebhook(
		webhook: Webhook,
	): webhook is AgentSessionCreatedWebhook {
		return webhook.action === "created";
	}

	private isAgentSessionPromptedWebhook(
		webhook: Webhook,
	): webhook is AgentSessionPromptedWebhook {
		return webhook.action === "prompted";
	}

	/**
	 * Get issue repository cache for serialization
	 */
	getIssueRepositoryCache(): Map<string, string[]> {
		return this.issueRepositoryCache;
	}

	/**
	 * Restore issue repository cache from serialization.
	 * Handles migration from old format (Map<string, string>) by wrapping values in arrays.
	 */
	restoreIssueRepositoryCache(cache: Map<string, string | string[]>): void {
		this.issueRepositoryCache = new Map();
		for (const [issueId, value] of cache.entries()) {
			if (Array.isArray(value)) {
				this.issueRepositoryCache.set(issueId, value);
			} else {
				// Migration: wrap old single-string format in array
				this.issueRepositoryCache.set(issueId, [value]);
			}
		}
	}
}
