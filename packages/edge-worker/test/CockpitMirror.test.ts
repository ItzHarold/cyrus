import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitMirror } from "../src/CockpitMirror.js";

/**
 * Operator-cockpit mirror (PON-151). The properties that matter: the mirror
 * only ever writes into the COCKPIT workspace, it fails silently (a broken
 * mirror must never break a client session), and reconciliation makes it
 * match reality.
 */

const COCKPIT_WS = "cockpit-ws";
const TENANT_WS = "tenant-ws";
const TEAM_ID = "team-1";

const issue = {
	issueId: "client-issue-1",
	issueIdentifier: "DVV-12",
	title: "Add CSV export",
	url: "https://linear.app/tenant/issue/DVV-12",
};

type GqlCall = { query: string; variables: Record<string, unknown> };

function makeLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		event: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as never;
}

describe("CockpitMirror", () => {
	let calls: GqlCall[];
	let persist: ReturnType<typeof vi.fn>;
	let mirror: CockpitMirror;
	let logger: ReturnType<typeof makeLogger>;

	/** Open mirror-looking issues returned to reconcile's adoption query. */
	let linearMirrorIssues: Array<{
		id: string;
		title: string;
		labels: { nodes: Array<{ id: string }> };
		project: { id: string } | null;
	}> = [];

	/** Team-setup response plus scripted per-mutation responses. */
	const respond = (call: GqlCall): unknown => {
		if (call.query.includes("issues(")) {
			return { team: { issues: { nodes: linearMirrorIssues } } };
		}
		if (call.query.includes("states(first: 50)")) {
			return {
				team: {
					states: {
						nodes: [
							{ id: "state-todo", type: "unstarted" },
							{ id: "state-done", type: "completed" },
						],
					},
					// "queued" exists already; the other two must be created.
					labels: { nodes: [{ id: "label-queued", name: "queued" }] },
				},
			};
		}
		if (call.query.includes("issueLabelCreate")) {
			const name = (call.variables.input as { name: string }).name;
			return {
				issueLabelCreate: {
					success: true,
					issueLabel: { id: `label-${name}` },
				},
			};
		}
		if (call.query.includes("issueCreate")) {
			issueCreateCounter++;
			return {
				issueCreate: {
					success: true,
					issue: { id: `mirror-${issueCreateCounter}` },
				},
			};
		}
		if (call.query.includes("issueUpdate")) {
			return { issueUpdate: { success: true } };
		}
		throw new Error(`unexpected query: ${call.query.slice(0, 60)}`);
	};

	const makeMirror = (
		config?: {
			linearWorkspaceId: string;
			workspaceName?: string;
			teamId: string;
			projectId?: string;
		},
		tokens: Record<string, string> = { [COCKPIT_WS]: "cockpit-token" },
	) => {
		const fullConfig = config
			? { workspaceName: "Cockpit", ...config }
			: undefined;
		logger = makeLogger();
		persist = vi.fn().mockResolvedValue(undefined);
		mirror = new CockpitMirror(
			{
				getConfig: () => fullConfig as never,
				getToken: (ws) => tokens[ws],
				getWorkspaceName: (ws) =>
					ws === TENANT_WS
						? "DVV Client"
						: ws === COCKPIT_WS
							? "Cockpit"
							: undefined,
				// PON-207: one single-team client, so these cases keep testing
				// the mirror rather than the client model (which has its own
				// suite).
				// One client per tenant workspace, which is the common shape.
				// The multi-workspace and multi-team cases have their own suite.
				resolveClient: (ws) => ({
					id: ws === TENANT_WS ? "devitaliteit" : `client-${ws}`,
					displayName:
						ws === TENANT_WS ? "DeVitaliteitVerrijkers" : `Client ${ws}`,
					lanes: 1,
					multiTeam: false,
				}),
				persist,
			},
			logger,
		);
		return mirror;
	};

	let issueCreateCounter = 0;

	beforeEach(() => {
		calls = [];
		linearMirrorIssues = [];
		issueCreateCounter = 0;
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

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("does nothing when no cockpit is configured", async () => {
		makeMirror(undefined);
		await mirror.upsert(issue, TENANT_WS, "active");
		expect(calls).toHaveLength(0);
	});

	it("never mirrors the cockpit's own workspace", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await mirror.upsert(issue, COCKPIT_WS, "active");
		expect(calls).toHaveLength(0);
	});

	it("does nothing when the cockpit workspace has no token", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID }, {});
		await mirror.upsert(issue, TENANT_WS, "active");
		expect(calls).toHaveLength(0);
	});

	it("creates the mirror with team setup: missing labels created, project set, title carries the client identifier", async () => {
		makeMirror({
			linearWorkspaceId: COCKPIT_WS,
			teamId: TEAM_ID,
			projectId: "proj-1",
		});
		await mirror.upsert(issue, TENANT_WS, "active");

		const labelCreates = calls.filter((c) =>
			c.query.includes("issueLabelCreate"),
		);
		expect(
			labelCreates.map((c) => (c.variables.input as { name: string }).name),
		).toEqual([
			"awaiting-scope-confirm",
			"active",
			"needs-info",
			"in-verification",
			"delivered",
		]);

		const create = calls.find((c) => c.query.includes("issueCreate"));
		const input = create?.variables.input as Record<string, unknown>;
		expect(input.teamId).toBe(TEAM_ID);
		expect(input.projectId).toBe("proj-1");
		// PON-207: client first, because the issue key is not identity.
		expect(input.title).toBe(
			"DeVitaliteitVerrijkers · DVV-12 — Add CSV export",
		);
		expect(input.labelIds).toEqual(["label-active"]);
		expect(String(input.description)).toContain(issue.url);
		expect(String(input.description)).toContain("DVV Client");
		expect(String(input.description)).toContain("authoritative");
		expect(persist).toHaveBeenCalled();
		expect(mirror.size).toBe(1);
	});

	it("updates on a state change and is a no-op when the state is unchanged", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await mirror.upsert(issue, TENANT_WS, "active");
		const before = calls.length;

		await mirror.upsert(issue, TENANT_WS, "active");
		expect(calls).toHaveLength(before); // unchanged state, no write

		await mirror.upsert(issue, TENANT_WS, "awaiting-scope-confirm");
		const update = calls
			.slice(before)
			.find((c) => c.query.includes("issueUpdate"));
		expect(update).toBeDefined();
		expect(
			(update?.variables.input as { labelIds: string[] }).labelIds,
		).toEqual(["label-awaiting-scope-confirm"]);
	});

	it("renders the queue position into the state", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await mirror.upsert(issue, TENANT_WS, "queued", { position: 2 });
		const create = calls.find((c) => c.query.includes("issueCreate"));
		expect(
			String((create?.variables.input as { description: string }).description),
		).toContain("queued (#2)");

		// Position change alone is a state change and writes.
		await mirror.upsert(issue, TENANT_WS, "queued", { position: 1 });
		expect(calls.some((c) => c.query.includes("issueUpdate"))).toBe(true);
	});

	it("close moves the mirror to the completed state and forgets it", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await mirror.upsert(issue, TENANT_WS, "active");
		await mirror.close(issue.issueId, "runner_complete");

		const update = calls.find(
			(c) =>
				c.query.includes("issueUpdate") &&
				(c.variables.input as { stateId?: string }).stateId !== undefined,
		);
		expect((update?.variables.input as { stateId: string }).stateId).toBe(
			"state-done",
		);
		expect(mirror.size).toBe(0);

		// Closing again is a no-op — the map stays bounded.
		const before = calls.length;
		await mirror.close(issue.issueId, "issue_terminal");
		expect(calls).toHaveLength(before);
	});

	it("swallows every write failure — a broken mirror never throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await expect(
			mirror.upsert(issue, TENANT_WS, "active"),
		).resolves.toBeUndefined();
		expect(
			(logger as never as { error: ReturnType<typeof vi.fn> }).error,
		).toHaveBeenCalled();
	});

	it("orders transitions per issue: a close issued after an upsert wins", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		const upsertPromise = mirror.upsert(issue, TENANT_WS, "active");
		const closePromise = mirror.close(issue.issueId, "runner_complete");
		await Promise.all([upsertPromise, closePromise]);
		expect(mirror.size).toBe(0);
		const last = calls[calls.length - 1];
		expect(last?.query).toContain("issueUpdate");
		expect((last?.variables.input as { stateId?: string }).stateId).toBe(
			"state-done",
		);
	});

	it("reconcile upserts everything live and closes stale mirrors", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		// A stale mirror from a previous boot.
		mirror.restore({
			"stale-issue": {
				mirrorIssueId: "mirror-stale",
				tenantWorkspaceId: TENANT_WS,
				state: "active",
				issueIdentifier: "DVV-9",
			},
		});

		await mirror.reconcile({
			active: [{ issue, tenantWorkspaceId: TENANT_WS }],
			queued: [
				{
					issue: { issueId: "queued-issue", issueIdentifier: "DVV-13" },
					tenantWorkspaceId: TENANT_WS,
					position: 1,
				},
			],
			awaitingScopeConfirm: [
				{
					issue: { issueId: "awaiting-issue", issueIdentifier: "DVV-14" },
					tenantWorkspaceId: TENANT_WS,
				},
			],
		});

		// Three live mirrors tracked, the stale one closed and forgotten.
		expect(mirror.size).toBe(3);
		expect(mirror.serialize()["stale-issue"]).toBeUndefined();
		const staleClose = calls.find(
			(c) =>
				c.query.includes("issueUpdate") &&
				(c.variables.id as string) === "mirror-stale" &&
				(c.variables.input as { stateId?: string }).stateId !== undefined,
		);
		expect((staleClose?.variables.input as { stateId: string }).stateId).toBe(
			"state-done",
		);
	});

	it("a renamed cockpit workspace keeps mirroring and says so once (PON-207)", async () => {
		// The name was an exact-match kill switch. A client renaming their
		// workspace then disabled the operator's entire view — punishing us
		// for something only they control. The guard keys on the id now.
		makeMirror({
			linearWorkspaceId: COCKPIT_WS,
			workspaceName: "Cockpit (old name)",
			teamId: TEAM_ID,
		});
		await mirror.upsert(issue, TENANT_WS, "active");
		expect(calls.length).toBeGreaterThan(0);
		const warns = (logger as never as { warn: ReturnType<typeof vi.fn> }).warn;
		const renameWarnings = warns.mock.calls.filter((c) =>
			String(c[0]).includes("cockpit_workspace_renamed"),
		);
		expect(renameWarnings).toHaveLength(1);

		// Advisory, so it says it once and never again.
		await mirror.upsert(issue, TENANT_WS, "queued", { position: 1 });
		expect(
			warns.mock.calls.filter((c) =>
				String(c[0]).includes("cockpit_workspace_renamed"),
			),
		).toHaveLength(1);
	});

	it("an unconfigured cockpit workspace id still disables mirroring loudly", async () => {
		// The check that actually protects a client: an id we cannot resolve
		// is an id we must not write to.
		makeMirror({
			linearWorkspaceId: "ws-not-configured",
			teamId: TEAM_ID,
		});
		await mirror.upsert(issue, TENANT_WS, "active");
		expect(calls).toHaveLength(0);
		const errors = (logger as never as { error: ReturnType<typeof vi.fn> })
			.error;
		expect(String(errors.mock.calls[0]![0])).toContain(
			"cockpit_disabled_misconfigured",
		);
	});

	it("a failed team setup cools down instead of retrying per event", async () => {
		let failures = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				failures++;
				throw new Error("linear down");
			}),
		);
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await mirror.upsert(issue, TENANT_WS, "active");
		expect(failures).toBe(1);
		// The next events inside the cooldown fire no API call at all.
		await mirror.upsert(issue, TENANT_WS, "queued", { position: 1 });
		await mirror.close(issue.issueId, "runner_complete");
		expect(failures).toBe(1);
	});

	it("reconcile adopts existing Linear mirrors instead of duplicating, and closes nothing mid-migration", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		linearMirrorIssues = [
			{
				// Matches a live issue — must be adopted, not duplicated.
				id: "mirror-existing",
				title: "DeVitaliteitVerrijkers · DVV-12 — Add CSV export",
				labels: { nodes: [{ id: "label-active" }] },
				project: null,
			},
			{
				// Matches nothing live — an orphan from a lost map. Closed.
				id: "mirror-orphan",
				title: "[DVV-99] Old thing",
				labels: { nodes: [{ id: "label-queued" }] },
				project: null,
			},
			{
				// No state label: not ours. Untouched.
				id: "unrelated-issue",
				title: "[DVV-98] Human-written issue",
				labels: { nodes: [] },
				project: null,
			},
		];

		await mirror.reconcile({
			active: [{ issue, tenantWorkspaceId: TENANT_WS }],
			queued: [],
			awaitingScopeConfirm: [],
		});

		// No issueCreate happened — the existing mirror was adopted and
		// updated in place.
		expect(calls.some((c) => c.query.includes("issueCreate"))).toBe(false);
		expect(mirror.serialize()[issue.issueId]?.mirrorIssueId).toBe(
			"mirror-existing",
		);
		// PON-207 migration safety: this boot ADOPTS and closes nothing. The
		// adopted mirror has no clientId yet, which is exactly the state a
		// first boot after the client model is in — and "I don't recognise
		// this title" must never be grounds for closing a live delivery.
		expect(
			calls.some((c) => (c.variables.id as string) === "mirror-orphan"),
		).toBe(false);
		expect(
			calls.some((c) => (c.variables.id as string) === "unrelated-issue"),
		).toBe(false);
	});

	it("closes orphans once every mirror carries the client model (PON-207)", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		// A fully migrated map: every tracked mirror knows its client.
		mirror.restore({
			[issue.issueId]: {
				mirrorIssueId: "mirror-existing",
				tenantWorkspaceId: TENANT_WS,
				state: "active",
				issueIdentifier: "DVV-12",
				clientId: "devitaliteit",
				mirrorTitle: "DeVitaliteitVerrijkers · DVV-12 — Add CSV export",
			},
		});
		linearMirrorIssues = [
			{
				id: "mirror-orphan",
				title: "DeVitaliteitVerrijkers · DVV-99 — Old thing",
				labels: { nodes: [{ id: "label-queued" }] },
				project: null,
			},
		];

		await mirror.reconcile({
			active: [{ issue, tenantWorkspaceId: TENANT_WS }],
			queued: [],
			awaitingScopeConfirm: [],
		});

		const orphanClose = calls.find(
			(c) =>
				c.query.includes("issueUpdate") &&
				(c.variables.id as string) === "mirror-orphan",
		);
		expect((orphanClose?.variables.input as { stateId: string }).stateId).toBe(
			"state-done",
		);
	});

	it("label creation denied: mirrors still work, state in description, one warning", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const call = JSON.parse(init.body) as GqlCall;
				calls.push(call);
				if (call.query.includes("issueLabelCreate")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							errors: [{ message: "not allowed to take action" }],
						}),
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ data: respond(call) }),
				};
			}),
		);
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await mirror.upsert(issue, TENANT_WS, "active");

		// One denied create stops further attempts; the mirror is created
		// with the labels that DID resolve ("queued" pre-existed).
		expect(
			calls.filter((c) => c.query.includes("issueLabelCreate")),
		).toHaveLength(1);
		const create = calls.find((c) => c.query.includes("issueCreate"));
		expect(create).toBeDefined();
		expect(
			(create?.variables.input as { labelIds: string[] }).labelIds,
		).toEqual([]);
		expect(
			String((create?.variables.input as { description: string }).description),
		).toContain("active");
		const labelWarnings = (
			logger as never as { warn: ReturnType<typeof vi.fn> }
		).warn.mock.calls.filter((c) =>
			String(c[0]).includes("cannot create state labels"),
		);
		expect(labelWarnings).toHaveLength(1);
		expect(mirror.size).toBe(1);
	});

	it("round-trips through serialize/restore", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		await mirror.upsert(issue, TENANT_WS, "active");
		const snapshot = mirror.serialize();

		const restored = makeMirror({
			linearWorkspaceId: COCKPIT_WS,
			teamId: TEAM_ID,
		});
		restored.restore(snapshot);
		expect(restored.size).toBe(1);
		expect(restored.serialize()[issue.issueId]?.mirrorIssueId).toBe("mirror-1");
	});

	// PON-169: the internal reading lands in the mirror description and
	// survives every later state transition.
	describe("operator note (PON-169)", () => {
		it("setOperatorNote writes the reading into the description, keeping the current state", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(issue, TENANT_WS, "active");
			await mirror.setOperatorNote(
				issue,
				TENANT_WS,
				"## Approach\nTouch api/export.ts; risk: pagination.",
			);

			const update = calls
				.filter(
					(c) =>
						c.query.includes("issueUpdate") &&
						(c.variables.input as { description?: string }).description !==
							undefined,
				)
				.pop();
			expect(update).toBeDefined();
			const input = (update?.variables as { input: { description: string } })
				.input;
			expect(input.description).toContain("## Internal reading");
			expect(input.description).toContain("Touch api/export.ts");
			// State unchanged: the active label stays on the mirror.
			expect((input as unknown as { labelIds: string[] }).labelIds).toContain(
				"label-active",
			);
		});

		it("a later state transition re-renders the description WITH the note", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(issue, TENANT_WS, "active");
			await mirror.setOperatorNote(issue, TENANT_WS, "internal reading text");
			await mirror.upsert(issue, TENANT_WS, "in-verification");

			const update = calls
				.filter(
					(c) =>
						c.query.includes("issueUpdate") &&
						(c.variables.input as { description?: string }).description !==
							undefined,
				)
				.pop();
			const input = (update?.variables as { input: { description: string } })
				.input;
			expect(input.description).toContain("internal reading text");
			expect(input.description).toContain("in-verification");
		});

		it("creates the mirror as active when the note arrives before any mirror exists", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.setOperatorNote(issue, TENANT_WS, "early reading");

			const create = calls.find((c) => c.query.includes("issueCreate"));
			expect(create).toBeDefined();
			const input = (
				create?.variables as {
					input: { description: string; labelIds: string[] };
				}
			).input;
			expect(input.description).toContain("early reading");
			expect(input.labelIds).toContain("label-active");
		});

		it("the operator brief renders all sections and survives transitions (PON-170)", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(issue, TENANT_WS, "active");
			await mirror.setOperatorNote(
				issue,
				TENANT_WS,
				"internal reading",
				"**Outcome** — CSV export works.",
			);
			await mirror.upsert(issue, TENANT_WS, "active", {
				brief: { approvedAt: "2026-08-25T10:00:00.000Z", revisions: 2 },
			});
			await mirror.upsert(issue, TENANT_WS, "in-verification", {
				brief: { addLinks: ["https://github.com/x/y/pull/9"] },
			});

			const update = calls
				.filter(
					(c) =>
						c.query.includes("issueUpdate") &&
						(c.variables.input as { description?: string }).description !==
							undefined,
				)
				.pop();
			const description = (
				update?.variables as { input: { description: string } }
			).input.description;
			expect(description).toContain("## Client scope");
			expect(description).toContain("**Outcome** — CSV export works.");
			expect(description).toContain(
				"**Approved:** 2026-08-25T10:00:00.000Z · **Revisions:** 2",
			);
			expect(description).toContain("## Internal reading");
			expect(description).toContain("internal reading");
			expect(description).toContain("## Links");
			expect(description).toContain("- https://github.com/x/y/pull/9");
		});

		it("brief links union — a repeated link is not duplicated", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(issue, TENANT_WS, "active", {
				brief: { addLinks: ["https://a", "https://b"] },
			});
			await mirror.upsert(issue, TENANT_WS, "in-verification", {
				brief: { addLinks: ["https://b", "https://c"] },
			});
			expect(mirror.serialize()[issue.issueId]?.briefLinks).toEqual([
				"https://a",
				"https://b",
				"https://c",
			]);
		});

		it("a brief-only change on an unchanged state still writes", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(issue, TENANT_WS, "active");
			const before = calls.length;
			await mirror.upsert(issue, TENANT_WS, "active", {
				brief: { approvedAt: "2026-08-25T10:00:00.000Z" },
			});
			expect(calls.length).toBeGreaterThan(before);
		});

		it("transitions write the round-robin operator order as sortOrder (PON-173)", async () => {
			const TENANT_B = "tenant-ws-2";
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(
				{ issueId: "a1", issueIdentifier: "DVV-1" },
				TENANT_WS,
				"active",
			);
			await mirror.upsert(
				{ issueId: "b1", issueIdentifier: "GCD-1" },
				TENANT_B,
				"active",
			);
			await mirror.upsert(
				{ issueId: "a2", issueIdentifier: "DVV-2" },
				TENANT_WS,
				"in-verification",
			);

			// Within tenant A, in-verification outranks the older active; B
			// interleaves in the first cycle: a2, b1, a1.
			const snapshot = mirror.serialize();
			expect(snapshot.a2?.sortOrder).toBe(0);
			expect(snapshot.b1?.sortOrder).toBe(1);
			expect(snapshot.a1?.sortOrder).toBe(2);
		});

		it("an unchanged rank writes nothing on resync (PON-173)", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(issue, TENANT_WS, "active");
			await mirror.resyncOperatorOrdering();
			const before = calls.length;
			await mirror.resyncOperatorOrdering();
			expect(calls.length).toBe(before);
		});

		it("the note survives serialize/restore", async () => {
			makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
			await mirror.upsert(issue, TENANT_WS, "active");
			await mirror.setOperatorNote(issue, TENANT_WS, "persisted reading");
			const snapshot = mirror.serialize();
			expect(snapshot[issue.issueId]?.operatorNote).toBe("persisted reading");

			const restored = makeMirror({
				linearWorkspaceId: COCKPIT_WS,
				teamId: TEAM_ID,
			});
			restored.restore(snapshot);
			expect(restored.serialize()[issue.issueId]?.operatorNote).toBe(
				"persisted reading",
			);
		});
	});

	it("creates a fresh mirror instead of writing a status across teams", async () => {
		// Linear refuses a status from another team, and rightly. Moving the
		// cockpit to its own team must therefore be a migration, not a wedge:
		// the old mirror stays as history, the work gets a new one.
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		mirror.restore({
			[issue.issueId]: {
				mirrorIssueId: "mirror-in-old-team",
				tenantWorkspaceId: TENANT_WS,
				state: "active",
				issueIdentifier: "DVV-12",
				clientId: "devitaliteit",
				mirrorTeamId: "team-the-cockpit-used-to-use",
			},
		});

		await mirror.upsert(issue, TENANT_WS, "in-verification");

		// Nothing was written to the abandoned mirror.
		expect(
			calls.some((c) => (c.variables.id as string) === "mirror-in-old-team"),
		).toBe(false);
		// A new one exists, in the team we now use.
		const create = calls.find((c) => c.query.includes("issueCreate"));
		expect(create).toBeDefined();
		expect((create?.variables.input as { teamId: string }).teamId).toBe(
			TEAM_ID,
		);
		const record = mirror.serialize()[issue.issueId];
		expect(record?.mirrorIssueId).not.toBe("mirror-in-old-team");
		expect(record?.mirrorTeamId).toBe(TEAM_ID);
	});

	it("updates in place when the mirror is in the team we write to", async () => {
		makeMirror({ linearWorkspaceId: COCKPIT_WS, teamId: TEAM_ID });
		mirror.restore({
			[issue.issueId]: {
				mirrorIssueId: "mirror-here",
				tenantWorkspaceId: TENANT_WS,
				state: "active",
				issueIdentifier: "DVV-12",
				clientId: "devitaliteit",
				mirrorTeamId: TEAM_ID,
			},
		});

		await mirror.upsert(issue, TENANT_WS, "in-verification");

		expect(calls.some((c) => c.query.includes("issueCreate"))).toBe(false);
		expect(
			calls.some((c) => (c.variables.id as string) === "mirror-here"),
		).toBe(true);
	});
});
