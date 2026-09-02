import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { buildClientLifecyclePlan } from "../src/client-messages.js";

/**
 * v3.1: Linear renders an agent session's `plan` as a numbered step list at
 * the top of the thread. The model's internal task list must never land there
 * on a CLIENT session — that is the reviewer's surface, kept on the mirror. A
 * client session shows only the code-maintained lifecycle plan, whose status
 * is driven by the state machine and never by the model.
 *
 * `clientQuietSession` already excludes operator/mirror sessions (PON-208), so
 * it is the exact "is this a client surface" predicate the plan reuses.
 */

const SESSION = "sess-plan";
const MODEL_TASK = "Refactor OrdersTable and delete the dead filter path";

function makeManager(clientQuiet: boolean) {
	const updateSessionSurface = vi.fn().mockResolvedValue(true);
	const manager = new AgentSessionManager(
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		updateSessionSurface,
		() => clientQuiet,
	);
	manager.createCyrusAgentSession(
		SESSION,
		"issue-1",
		{
			id: "issue-1",
			identifier: "ACM-1",
			title: "t",
			description: "d",
			branchName: "b",
		},
		{ path: "/tmp/worktrees/ACM-1", isGitWorktree: false },
	);
	manager.setActivitySink(SESSION, {
		postActivity: vi.fn(),
		createAgentSession: vi.fn(),
	} as never);
	return { manager, updateSessionSurface };
}

const planCalls = (fn: ReturnType<typeof vi.fn>) =>
	fn.mock.calls.filter((c: unknown[]) => (c[1] as { plan?: unknown })?.plan);

describe("v3.1 — the model's task plan never reaches a client session", () => {
	it("a client session publishes NO model task plan", async () => {
		const { manager, updateSessionSurface } = makeManager(true);
		const p = manager as unknown as Record<string, any>;
		p.planTrackers.get(SESSION).addTask("1", MODEL_TASK);
		await p.publishPlan(SESSION);
		expect(planCalls(updateSessionSurface)).toHaveLength(0);
	});

	it("a mirror/operator session KEEPS the detailed model plan", async () => {
		const { manager, updateSessionSurface } = makeManager(false);
		const p = manager as unknown as Record<string, any>;
		p.planTrackers.get(SESSION).addTask("1", MODEL_TASK);
		await p.publishPlan(SESSION);
		const calls = planCalls(updateSessionSurface);
		expect(calls).toHaveLength(1);
		expect((calls[0][1] as any).plan[0].content).toBe(MODEL_TASK);
	});

	it("publishSessionPlan publishes the code-maintained lifecycle plan, no internal text", async () => {
		const { manager, updateSessionSurface } = makeManager(true);
		await manager.publishSessionPlan(
			SESSION,
			buildClientLifecyclePlan("building"),
		);
		const calls = planCalls(updateSessionSurface);
		expect(calls).toHaveLength(1);
		const plan = (calls[0][1] as any).plan;
		expect(plan.map((s: { content: string }) => s.content)).toEqual([
			"Scope agreed",
			"In development",
			"Ready for your review",
			"Merged",
		]);
		expect(plan[1].status).toBe("inProgress");
		expect(JSON.stringify(plan)).not.toContain("OrdersTable");
	});

	it("the lifecycle plan status is state-driven across phases", () => {
		expect(buildClientLifecyclePlan("agreed").map((s) => s.status)).toEqual([
			"completed",
			"pending",
			"pending",
			"pending",
		]);
		expect(buildClientLifecyclePlan("review").map((s) => s.status)).toEqual([
			"completed",
			"completed",
			"inProgress",
			"pending",
		]);
		expect(buildClientLifecyclePlan("merged").map((s) => s.status)).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
		]);
	});
});
