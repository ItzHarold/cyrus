import type {
	LinearAgentSessionCreatedWebhook,
	RepositoryConfig,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RepositoryRouter,
	type RepositoryRouterDeps,
} from "../src/RepositoryRouter.js";

/**
 * Tenant isolation of repository routing (PON-189).
 *
 * Team keys are workspace-local: "ACM" in one client's Linear has nothing to
 * do with "ACM" in another's, and two clients picking the same key is normal.
 * The property proven here is that NO routing path — active session, label,
 * project, team key, team prefix, catch-all — can reach a repository outside
 * the webhook's own workspace, because the candidate set is filtered by
 * workspace before any priority runs.
 *
 * This is the invariant that keeps one tenant's issue from being implemented
 * against another tenant's code.
 */

const ACME_WS = "workspace-acme";
const OTHER_WS = "workspace-other";

function repo(
	id: string,
	name: string,
	workspaceId: string,
	extra: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	return {
		id,
		name,
		repositoryPath: `/path/to/${id}`,
		baseBranch: "main",
		linearWorkspaceId: workspaceId,
		workspaceBaseDir: "/workspace",
		isActive: true,
		...extra,
	} as RepositoryConfig;
}

function webhook(
	workspaceId: string,
	teamKey: string,
	issueId = "issue-1",
	identifier = `${teamKey}-1`,
): LinearAgentSessionCreatedWebhook {
	return {
		action: "created",
		organizationId: workspaceId,
		agentSession: {
			id: "session-1",
			issue: { id: issueId, identifier, team: { key: teamKey } },
			comment: null,
		},
		guidance: [],
	} as unknown as LinearAgentSessionCreatedWebhook;
}

describe("RepositoryRouter - two tenants, one team key (PON-189)", () => {
	let deps: RepositoryRouterDeps;
	let router: RepositoryRouter;
	let activeSessions: Map<string, Set<string>>;

	// Both clients registered a team called ACM. Only the workspace tells
	// them apart.
	const acmeRepo = repo("repo-acme", "Acme-Metrics", ACME_WS, {
		teamKeys: ["ACM"],
	});
	const otherRepo = repo("repo-other", "Other-Client-App", OTHER_WS, {
		teamKeys: ["ACM"],
	});

	beforeEach(() => {
		activeSessions = new Map();
		deps = {
			fetchIssueLabels: vi.fn().mockResolvedValue([]),
			fetchIssueDescription: vi.fn().mockResolvedValue(undefined),
			hasActiveSession: vi
				.fn()
				.mockImplementation((issueId: string, repoId: string) =>
					Boolean(activeSessions.get(issueId)?.has(repoId)),
				),
			getIssueTracker: vi.fn().mockReturnValue({
				createAgentActivity: vi.fn().mockResolvedValue({}),
				fetchIssue: vi.fn().mockResolvedValue({ project: null }),
			}),
		} as unknown as RepositoryRouterDeps;
		router = new RepositoryRouter(deps);
	});

	it("routes each tenant's ACM issue to its OWN repository", async () => {
		const acme = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "ACM"),
			[acmeRepo, otherRepo],
		);
		expect(acme.type).toBe("selected");
		if (acme.type === "selected") {
			expect(acme.repositories.map((r) => r.id)).toEqual(["repo-acme"]);
		}

		const other = await router.determineRepositoryForWebhook(
			webhook(OTHER_WS, "ACM", "issue-2", "ACM-2"),
			[acmeRepo, otherRepo],
		);
		expect(other.type).toBe("selected");
		if (other.type === "selected") {
			expect(other.repositories.map((r) => r.id)).toEqual(["repo-other"]);
		}
	});

	it("never borrows the other tenant's repo when the workspace has none", async () => {
		// The ACM team key matches a repo — in the WRONG workspace. There must
		// be no result at all rather than a cross-tenant one.
		const result = await router.determineRepositoryForWebhook(
			webhook("workspace-with-no-repos", "ACM"),
			[acmeRepo, otherRepo],
		);
		expect(result.type).toBe("none");
	});

	it("does not cross tenants via a catch-all repository", async () => {
		const catchAll = repo("repo-catchall", "Other-Catch-All", OTHER_WS);
		const result = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "UNKNOWN"),
			[catchAll],
		);
		expect(result.type).toBe("none");
	});

	it("does not cross tenants via the team-prefix fallback", async () => {
		const result = await router.determineRepositoryForWebhook(
			// No team object, so routing falls back to the identifier prefix.
			{
				action: "created",
				organizationId: ACME_WS,
				agentSession: {
					id: "session-1",
					issue: { id: "issue-9", identifier: "ACM-9" },
					comment: null,
				},
				guidance: [],
			} as unknown as LinearAgentSessionCreatedWebhook,
			[otherRepo],
		);
		expect(result.type).toBe("none");
	});

	it("does not cross tenants via an active session on the same issue id", async () => {
		// Defense in depth: even if the session map claims another workspace's
		// repository is active for this issue, that repo is not a candidate.
		activeSessions.set("issue-1", new Set(["repo-other"]));
		const result = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "ACM"),
			[acmeRepo, otherRepo],
		);
		expect(result.type).toBe("selected");
		if (result.type === "selected") {
			expect(result.repositories.map((r) => r.id)).toEqual(["repo-acme"]);
			expect(result.routingMethod).toBe("team-based");
		}
	});

	it("does not cross tenants via routing labels", async () => {
		(deps.fetchIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
			"backend",
		]);
		const labelled = repo("repo-other-labelled", "Other-App", OTHER_WS, {
			routingLabels: ["backend"],
		});
		const result = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "ACM"),
			[labelled],
		);
		expect(result.type).toBe("none");
	});
});

/**
 * Routing invariant (2026-09-02, PON-223): the agent never selects a repository
 * without an EXPLICIT mapping, and never guesses. A team that maps to nothing
 * refuses (unmapped); a team that maps to more than one asks (ambiguous). This
 * is the second half of the tenant/routing invariant — the first half (never
 * crosses tenants) is proven above.
 */
describe("RepositoryRouter - never routes without an explicit mapping", () => {
	let deps: RepositoryRouterDeps;
	let router: RepositoryRouter;

	beforeEach(() => {
		deps = {
			fetchIssueLabels: vi.fn().mockResolvedValue([]),
			fetchIssueDescription: vi.fn().mockResolvedValue(undefined),
			hasActiveSession: vi.fn().mockReturnValue(false),
			getIssueTracker: vi.fn().mockReturnValue({
				createAgentActivity: vi.fn().mockResolvedValue({}),
				fetchIssue: vi.fn().mockResolvedValue({ project: null }),
			}),
		} as unknown as RepositoryRouterDeps;
		router = new RepositoryRouter(deps);
	});

	it("an unmapped team refuses (unmapped), even with repos present in the workspace", async () => {
		// The workspace HAS a repo, but it is mapped to a different team.
		const mapped = repo("repo-mapped", "Mapped", ACME_WS, {
			teamKeys: ["ACM"],
		});
		const result = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "WIDGET", "issue-w", "WIDGET-1"),
			[mapped],
		);
		expect(result.type).toBe("unmapped");
		if (result.type === "unmapped") {
			// It offers the operator the workspace's repos as context, but starts
			// nothing and picks nothing.
			expect(result.workspaceRepos.map((r) => r.id)).toEqual(["repo-mapped"]);
		}
	});

	it("a repo with NO routing config is never a catch-all — an unmatched team is unmapped", async () => {
		// The one repo in the workspace has zero teamKeys/labels/projectKeys.
		// The old catch-all would have routed here; now it refuses.
		const unconfigured = repo("repo-blank", "Blank", ACME_WS);
		const result = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "WIDGET", "issue-w", "WIDGET-1"),
			[unconfigured],
		);
		expect(result.type).toBe("unmapped");
	});

	it("a team mapping to MORE THAN ONE repo is ambiguous — it asks, never guesses", async () => {
		const a = repo("repo-a", "A", ACME_WS, { teamKeys: ["ACM"] });
		const b = repo("repo-b", "B", ACME_WS, { teamKeys: ["ACM"] });
		const result = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "ACM"),
			[a, b],
		);
		expect(result.type).toBe("ambiguous");
		if (result.type === "ambiguous") {
			expect(result.candidates.map((r) => r.id).sort()).toEqual([
				"repo-a",
				"repo-b",
			]);
			expect(result.routingMethod).toBe("team-based");
		}
	});

	it("the ambiguity is scoped to the tenant — a same-key repo in another workspace is not a candidate", async () => {
		const a = repo("repo-a", "A", ACME_WS, { teamKeys: ["ACM"] });
		const b = repo("repo-b", "B", ACME_WS, { teamKeys: ["ACM"] });
		const elsewhere = repo("repo-else", "Else", OTHER_WS, {
			teamKeys: ["ACM"],
		});
		const result = await router.determineRepositoryForWebhook(
			webhook(ACME_WS, "ACM"),
			[a, b, elsewhere],
		);
		expect(result.type).toBe("ambiguous");
		if (result.type === "ambiguous") {
			// repo-else (other tenant) must NOT appear among the candidates.
			expect(result.candidates.map((r) => r.id).sort()).toEqual([
				"repo-a",
				"repo-b",
			]);
		}
	});
});
