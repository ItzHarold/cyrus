import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitMirror } from "../src/CockpitMirror.js";
import type { ResolvedClient } from "../src/client-registry.js";

/**
 * Repo-routing follow-up (PON-223): the cockpit routing table in each client's
 * project description, and the "Needs operator" escalation on an unmapped team.
 * A self-contained gql harness — the shared CockpitMirror suite scripts a
 * different set of queries.
 */

const COCKPIT_WS = "cockpit-ws";
const TENANT_WS = "tenant-ws";

type GqlCall = { query: string; variables: Record<string, unknown> };

const CLIENT: ResolvedClient = {
	id: "acme",
	displayName: "Acme Corp",
	lanes: 1,
	multiTeam: false,
	reviewerId: "reviewer-1",
	cockpitProjectId: "proj-acme",
};

describe("CockpitMirror — routing table + Needs-operator escalation", () => {
	let calls: GqlCall[];
	// Scripted state for findOpenNeedsOperator: open issues in the cockpit team.
	let openIssues: Array<{ id: string; title: string }>;
	let projectsByTeam: Array<{ id: string; name: string }>;

	const respond = (call: GqlCall): unknown => {
		if (call.query.includes("projects(first: 100)")) {
			return { team: { projects: { nodes: projectsByTeam } } };
		}
		if (call.query.includes("projectCreate")) {
			return { projectCreate: { success: true, project: { id: "proj-new" } } };
		}
		if (call.query.includes("projectUpdate")) {
			return { projectUpdate: { success: true } };
		}
		if (call.query.includes("states(first: 50)")) {
			return {
				team: {
					states: {
						nodes: [
							{ id: "state-todo", name: "Todo", type: "unstarted" },
							{ id: "state-done", name: "Done", type: "completed" },
							{ id: "state-cancel", name: "Canceled", type: "canceled" },
						],
					},
					labels: { nodes: [] },
				},
			};
		}
		if (call.query.includes("title: { contains: $q }")) {
			return { issues: { nodes: openIssues } };
		}
		if (call.query.includes("title: { contains: $mark }")) {
			return { issues: { nodes: openIssues } };
		}
		if (call.query.includes("issueCreate")) {
			return { issueCreate: { success: true, issue: { id: "needsop-1" } } };
		}
		if (call.query.includes("issueUpdate")) {
			return { issueUpdate: { success: true } };
		}
		throw new Error(`unexpected query: ${call.query.slice(0, 70)}`);
	};

	const makeMirror = () =>
		new CockpitMirror(
			{
				getConfig: () => ({
					linearWorkspaceId: COCKPIT_WS,
					workspaceName: "Cockpit",
					teamId: "team-ckp",
				}),
				getToken: (ws) => (ws === COCKPIT_WS ? "cockpit-token" : undefined),
				getWorkspaceName: () => "Cockpit",
				resolveClient: () => CLIENT,
				persist: vi.fn().mockResolvedValue(undefined),
			},
			{
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				event: vi.fn(),
				withContext: () => ({
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
					event: vi.fn(),
				}),
			} as never,
		);

	beforeEach(() => {
		calls = [];
		openIssues = [];
		projectsByTeam = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const call = JSON.parse(init.body) as GqlCall;
				calls.push(call);
				return {
					ok: true,
					status: 200,
					json: async () => ({ data: respond(call) }),
				};
			}),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	const projectUpdate = () =>
		calls.find((c) => c.query.includes("projectUpdate"));
	const issueCreate = () => calls.find((c) => c.query.includes("issueCreate"));
	const issueUpdate = () => calls.find((c) => c.query.includes("issueUpdate"));

	it("writes the team→repo routing table into the client's project description", async () => {
		const mirror = makeMirror();
		await mirror.syncClientRoutingTables([
			{
				client: CLIENT,
				tenantWorkspaceId: TENANT_WS,
				rows: [
					{ team: "ACM", repo: "acme-metrics" },
					{ team: "label: infra", repo: "acme-infra" },
				],
			},
		]);
		const up = projectUpdate();
		expect(up).toBeDefined();
		expect(up?.variables.id).toBe("proj-acme"); // the client's configured project
		const desc = (up?.variables.input as { content: string }).content;
		expect(desc).toContain("## Routing");
		expect(desc).toContain("do not edit by hand");
		expect(desc).toContain("| ACM | acme-metrics |");
		expect(desc).toContain("| label: infra | acme-infra |");
	});

	it("renders the empty-mapping case as an explicit refusal note", async () => {
		const mirror = makeMirror();
		await mirror.syncClientRoutingTables([
			{ client: CLIENT, tenantWorkspaceId: TENANT_WS, rows: [] },
		]);
		const desc = (projectUpdate()?.variables.input as { content: string })
			.content;
		expect(desc).toContain("No repository is mapped for **Acme Corp** yet");
		expect(desc).not.toContain("| Team");
	});

	it("raises a Needs-operator issue in the project, assigned, linking the client issue", async () => {
		const mirror = makeMirror();
		await mirror.raiseNeedsOperator({
			clientIssueIdentifier: "WID-3",
			clientIssueUrl: "https://linear.app/acme/issue/WID-3",
			clientDisplayName: "Acme Corp",
			teamKey: "WID",
			tenantWorkspaceId: TENANT_WS,
			client: CLIENT,
			assigneeId: "reviewer-1",
		});
		const create = issueCreate();
		expect(create).toBeDefined();
		const input = create?.variables.input as {
			teamId: string;
			projectId: string;
			title: string;
			description: string;
			assigneeId: string;
		};
		expect(input.teamId).toBe("team-ckp");
		expect(input.projectId).toBe("proj-acme");
		expect(input.assigneeId).toBe("reviewer-1");
		expect(input.title).toBe("Needs operator — WID not mapped (WID-3)");
		expect(input.description).toContain("WID-3");
		expect(input.description).toContain("map team `WID`");
		expect(input.description).toContain("https://linear.app/acme/issue/WID-3");
	});

	it("does not raise a second Needs-operator issue when one is already open", async () => {
		const mirror = makeMirror();
		openIssues = [
			{
				id: "needsop-existing",
				title: "Needs operator — WID not mapped (WID-3)",
			},
		];
		await mirror.raiseNeedsOperator({
			clientIssueIdentifier: "WID-3",
			clientDisplayName: "Acme Corp",
			teamKey: "WID",
			tenantWorkspaceId: TENANT_WS,
			client: CLIENT,
		});
		expect(issueCreate()).toBeUndefined(); // idempotent — nothing created
	});

	it("resolveNeedsOperator is a no-op (no query) when nothing is open for the issue", async () => {
		const mirror = makeMirror();
		await mirror.resolveNeedsOperator({
			clientIssueIdentifier: "WID-3",
			tenantWorkspaceId: TENANT_WS,
		});
		expect(calls).toHaveLength(0); // returned before any Linear call
	});

	it("closes the Needs-operator issue to Done once it was raised and the issue re-routes", async () => {
		const mirror = makeMirror();
		// Raise puts WID-3 in the open set...
		openIssues = [];
		await mirror.raiseNeedsOperator({
			clientIssueIdentifier: "WID-3",
			clientDisplayName: "Acme Corp",
			teamKey: "WID",
			tenantWorkspaceId: TENANT_WS,
			client: CLIENT,
		});
		// ...now Linear has it open; a re-delegation resolves it.
		openIssues = [
			{ id: "needsop-1", title: "Needs operator — WID not mapped (WID-3)" },
		];
		calls = [];
		await mirror.resolveNeedsOperator({
			clientIssueIdentifier: "WID-3",
			tenantWorkspaceId: TENANT_WS,
		});
		const up = issueUpdate();
		expect(up).toBeDefined();
		expect(up?.variables.id).toBe("needsop-1");
		expect((up?.variables.input as { stateId: string }).stateId).toBe(
			"state-done",
		);
	});

	it("ensureClientProject prefers config, then find-by-name, then create", async () => {
		// config id wins → no project query at all
		const m1 = makeMirror();
		await m1.syncClientRoutingTables([
			{ client: CLIENT, tenantWorkspaceId: TENANT_WS, rows: [] },
		]);
		expect(calls.some((c) => c.query.includes("projects(first: 100)"))).toBe(
			false,
		);
		expect(projectUpdate()?.variables.id).toBe("proj-acme");

		// no config id → find an existing team project by name
		calls = [];
		projectsByTeam = [{ id: "proj-found", name: "Acme Corp" }];
		const noProjClient = { ...CLIENT, cockpitProjectId: undefined };
		const m2 = makeMirror();
		await m2.syncClientRoutingTables([
			{ client: noProjClient, tenantWorkspaceId: TENANT_WS, rows: [] },
		]);
		expect(projectUpdate()?.variables.id).toBe("proj-found");

		// no config id, none by name → create one
		calls = [];
		projectsByTeam = [];
		const m3 = makeMirror();
		await m3.syncClientRoutingTables([
			{ client: noProjClient, tenantWorkspaceId: TENANT_WS, rows: [] },
		]);
		expect(calls.some((c) => c.query.includes("projectCreate"))).toBe(true);
		expect(projectUpdate()?.variables.id).toBe("proj-new");
	});
});
