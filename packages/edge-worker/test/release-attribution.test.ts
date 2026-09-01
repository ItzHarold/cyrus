import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { resolveMirrorActor } from "../src/operator-session.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-237: the reviewer could not release their own work.
 *
 * `approve:` typed into the mirror's implementation thread was refused with
 * "Only a configured reviewer can release work to the client" — said to the
 * reviewer, who was the mirror's assignee and whose claim the start check
 * had already accepted.
 *
 * The actor was never resolved. Linear puts the person who typed an activity
 * on the ACTIVITY (`userId`); `agentSession.creator` is documented as unset
 * when a session was "initiated via automation or by an agent user", and a
 * mirror's session is routinely created by our own re-delegation recovery —
 * so on exactly the threads the reviewer works in, it is unset by design.
 */

const COCKPIT_WS = "ws-cockpit";
const CLIENT_ISSUE = "issue-acm-21";
const MIRROR_ISSUE = "issue-ckp-22";
const MIRROR_SESSION = "sess-mirror";
const HAROLD = "user-harold";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function setup() {
	const worker = createTestWorker([]);
	const p = privates(worker);
	const posts: any[] = [];
	p.issueTrackers.set(COCKPIT_WS, {
		createAgentActivity: vi.fn(async (a: any) => {
			posts.push(a);
			return { success: true };
		}),
	});
	p.config.cockpit = {
		linearWorkspaceId: COCKPIT_WS,
		workspaceName: "Cockpit",
		teamId: "t",
		reviewers: [HAROLD],
	};
	p.cockpitMirror.clientIssueIdFor = vi.fn().mockReturnValue(CLIENT_ISSUE);
	p.deliverVerifiedWork = vi.fn(async () => "delivered");
	return { worker, p, posts };
}

/** A prompt typed by a person into an agent session thread. */
const promptedByPerson = (userId?: string) =>
	({
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: COCKPIT_WS,
		agentSession: {
			id: MIRROR_SESSION,
			issue: { id: MIRROR_ISSUE, identifier: "CKP-22" },
			// Unset, because our own recovery created this session.
			creator: undefined,
		},
		agentActivity: {
			content: { body: "approve: verified on the preview" },
			userId,
		},
	}) as never;

describe("who sent the approve", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("releases when the reviewer typed it, even with no session creator", async () => {
		const { p } = setup();

		await p.handleUserPromptedAgentActivity(promptedByPerson(HAROLD));

		expect(p.deliverVerifiedWork).toHaveBeenCalledWith(
			CLIENT_ISSUE,
			"verified on the preview",
		);
	});

	it("refuses HONESTLY when nobody can be attributed", async () => {
		// The failure that produced this issue. It must never read as "you
		// are not a reviewer" to the person who is one.
		const { p, posts } = setup();

		await p.handleUserPromptedAgentActivity(promptedByPerson(undefined));

		expect(p.deliverVerifiedWork).not.toHaveBeenCalled();
		const said = posts.at(-1).content.body;
		expect(said).toContain("couldn't verify who sent that");
		expect(said).not.toContain("Only a configured reviewer");
	});

	it("still refuses a real non-reviewer, and says so plainly", async () => {
		const { p, posts } = setup();

		await p.handleUserPromptedAgentActivity(promptedByPerson("user-stranger"));

		expect(p.deliverVerifiedWork).not.toHaveBeenCalled();
		expect(posts.at(-1).content.body).toContain("Only a configured reviewer");
	});
});

describe("exactly one delivery", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("a replayed approve does not deliver twice", async () => {
		const worker = createTestWorker([]);
		const p = privates(worker);
		p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
		p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: "ws",
			sessionId: "sess-client",
			summary: "done",
			isError: false,
		});
		p.verificationGate.markDelivered(CLIENT_ISSUE);

		const out = await p.deliverVerifiedWork(CLIENT_ISSUE);

		expect(out).toContain("Already delivered");
	});

	it("two approves arriving together deliver once", async () => {
		// The state guard catches a replay, but both would pass it before
		// either marks the record — and a client receiving their delivery
		// twice only ever happens in front of them.
		const worker = createTestWorker([]);
		const p = privates(worker);
		let running = 0;
		let maxConcurrent = 0;
		p.performDelivery = vi.fn(async () => {
			running += 1;
			maxConcurrent = Math.max(maxConcurrent, running);
			await new Promise((r) => setTimeout(r, 20));
			running -= 1;
			return "delivered";
		});
		p.verificationGate.recordPending(CLIENT_ISSUE, {
			workspaceId: "ws",
			sessionId: "sess-client",
			summary: "done",
			isError: false,
		});

		const [a, b] = await Promise.all([
			p.deliverVerifiedWork(CLIENT_ISSUE),
			p.deliverVerifiedWork(CLIENT_ISSUE),
		]);

		expect(p.performDelivery).toHaveBeenCalledTimes(1);
		expect(maxConcurrent).toBe(1);
		expect([a, b].filter((r) => r === "delivered")).toHaveLength(1);
	});
});

describe("resolveMirrorActor", () => {
	const HAROLD = "user-harold";

	it("prefers the activity's own user, names included", () => {
		expect(
			resolveMirrorActor({
				agentActivity: {
					userId: HAROLD,
					content: { user: { id: HAROLD, displayName: "Harold" } },
				},
				agentSession: { creator: { id: "someone-else", name: "Nope" } },
			}),
		).toEqual({ id: HAROLD, name: "Harold" });
	});

	it("falls back to the activity userId when that is all there is", () => {
		// The live CKP-22 shape: session created by our own recovery, so no
		// creator at all.
		expect(
			resolveMirrorActor({
				agentActivity: { userId: HAROLD },
				agentSession: { creator: undefined },
			}),
		).toEqual({ id: HAROLD, name: undefined });
	});

	it("borrows a name from a later source only when the id matches", () => {
		expect(
			resolveMirrorActor({
				agentActivity: { userId: HAROLD },
				agentSession: { creator: { id: HAROLD, name: "Harold" } },
			}),
		).toEqual({ id: HAROLD, name: "Harold" });

		// Two different people must never be spliced into one actor.
		expect(
			resolveMirrorActor({
				agentActivity: { userId: HAROLD },
				agentSession: { creator: { id: "someone-else", name: "Nope" } },
			}),
		).toEqual({ id: HAROLD, name: undefined });
	});

	it("reads the mentioning comment when a session carries no creator", () => {
		expect(
			resolveMirrorActor({
				agentSession: { comment: { user: { id: HAROLD, name: "Harold" } } },
			}),
		).toEqual({ id: HAROLD, name: "Harold" });
	});

	it("returns nobody rather than a name it cannot authorize", () => {
		expect(resolveMirrorActor({})).toEqual({});
		expect(
			resolveMirrorActor({
				agentActivity: { content: { user: { name: "X" } } },
			}),
		).toEqual({});
		expect(resolveMirrorActor({ agentActivity: "nonsense" })).toEqual({});
	});
});

describe("only agent-session events can release", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it.each([
		// What Linear actually sends, per the live journal at 15:52:47.801.
		{
			shape: "Comment/create",
			payload: {
				type: "Comment",
				action: "create",
				organizationId: COCKPIT_WS,
				data: {
					id: "comment-1",
					body: "approve: verified on the preview",
					issue: { id: MIRROR_ISSUE, identifier: "CKP-22" },
					user: { id: HAROLD, name: "Harold" },
				},
			},
		},
		// The notification shape the dispatch names explicitly.
		{
			shape: "AppUserNotification/issueNewComment",
			payload: {
				type: "AppUserNotification",
				action: "issueNewComment",
				organizationId: COCKPIT_WS,
				notification: {
					issue: { id: MIRROR_ISSUE, identifier: "CKP-22" },
					comment: { id: "comment-1", body: "approve: verified" },
					actor: { id: HAROLD, name: "Harold" },
				},
			},
		},
	])("a $shape on a mirror issue delivers nothing", async ({ payload }) => {
		// Typing `approve:` into the mirror's thread makes Linear emit BOTH a
		// comment webhook and a prompted AgentSessionEvent (live journal,
		// 15:52:47.801 then .948). If a comment path ever grew a mirror
		// listener, one gesture would deliver twice — to the client.
		const worker = createTestWorker([]);
		const p = privates(worker);
		p.config.cockpit = {
			linearWorkspaceId: COCKPIT_WS,
			workspaceName: "Cockpit",
			teamId: "t",
			reviewers: [HAROLD],
		};
		p.isKnownWorkspace = vi.fn().mockReturnValue(true);
		p.cockpitMirror.clientIssueIdFor = vi.fn().mockReturnValue(CLIENT_ISSUE);
		p.handleMirrorAction = vi.fn();
		p.deliverVerifiedWork = vi.fn();

		await p.handleWebhook(payload as never, []);

		expect(p.handleMirrorAction).not.toHaveBeenCalled();
		expect(p.deliverVerifiedWork).not.toHaveBeenCalled();
	});
});
