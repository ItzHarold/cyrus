import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";

/**
 * Work-in-progress links must not reach the client (PON-221).
 *
 * External URLs are attached to the agent session as a SURFACE update, not
 * posted as an activity, so they reach a client thread through neither the
 * client-quiet funnel nor the verification hold — both of which only ever see
 * activities. That is how a client watched a draft pull request button appear
 * while the work was still being reviewed.
 *
 * The fix holds them and releases them with the delivery, so the assertions
 * below come in pairs: nothing before release, everything after.
 */

const SESSION_ID = "agent-session-1";
const PR_URL = "https://github.com/acme/champions-box/pull/42";
const PREVIEW_URL =
	"https://champions-box-git-appuser-chb-27-abc-team.vercel.app";

function makeManager(opts: { held: boolean }) {
	const updateSessionSurface = vi.fn().mockResolvedValue(true);
	const manager = new AgentSessionManager(
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		updateSessionSurface,
		() => true, // client-quiet
	);
	manager.createCyrusAgentSession(
		SESSION_ID,
		"issue-1",
		{
			id: "issue-1",
			identifier: "CHB-27",
			title: "t",
			description: "d",
			branchName: "b",
		},
		{
			path: "/tmp/worktrees/CHB-27",
			isGitWorktree: false,
		},
	);
	const postActivity = vi.fn().mockResolvedValue({ activityId: "a-1" });
	manager.setActivitySink(SESSION_ID, {
		postActivity,
		createAgentSession: vi.fn(),
	} as never);
	manager.setLinkPublicationHold(() => opts.held);
	return { manager, updateSessionSurface, postActivity };
}

async function sendAssistantText(
	manager: AgentSessionManager,
	text: string,
): Promise<void> {
	await manager.handleClaudeMessage(SESSION_ID, {
		type: "assistant",
		session_id: "sdk-1",
		parent_tool_use_id: null,
		message: {
			id: "m1",
			type: "message",
			role: "assistant",
			model: "x",
			content: [{ type: "text", text }],
			stop_reason: null,
			stop_sequence: null,
			usage: {} as never,
		},
	} as never);
	// publishLinks is fire-and-forget from the message handler.
	await new Promise((r) => setTimeout(r, 10));
}

function urlsFrom(mock: ReturnType<typeof vi.fn>): string[] {
	return mock.mock.calls.flatMap(
		(call: unknown[]) =>
			(
				call[1] as { addedExternalUrls?: Array<{ url: string }> }
			).addedExternalUrls?.map((u) => u.url) ?? [],
	);
}

describe("work-in-progress links on a held session", () => {
	it("publishes NOTHING to the client while the delivery is held", async () => {
		const { manager, updateSessionSurface } = makeManager({ held: true });

		await sendAssistantText(
			manager,
			`Opened ${PR_URL} and the preview is at ${PREVIEW_URL}`,
		);

		expect(urlsFrom(updateSessionSurface)).toEqual([]);
	});

	it("attaches the held links once the work is released", async () => {
		const { manager, updateSessionSurface } = makeManager({ held: true });

		await sendAssistantText(
			manager,
			`Opened ${PR_URL} and the preview is at ${PREVIEW_URL}`,
		);
		expect(urlsFrom(updateSessionSurface)).toEqual([]);

		await manager.releaseHeldLinks(SESSION_ID);

		// Held, not dropped: the client gets both, with the delivery.
		expect(urlsFrom(updateSessionSurface)).toEqual([PR_URL, PREVIEW_URL]);
	});

	it("releases each link once, even if release runs twice", async () => {
		const { manager, updateSessionSurface } = makeManager({ held: true });

		await sendAssistantText(manager, `Opened ${PR_URL}`);
		await manager.releaseHeldLinks(SESSION_ID);
		await manager.releaseHeldLinks(SESSION_ID);

		expect(urlsFrom(updateSessionSurface)).toEqual([PR_URL]);
	});

	it("publishes immediately when the work is NOT held", async () => {
		const { manager, updateSessionSurface } = makeManager({ held: false });

		await sendAssistantText(
			manager,
			`Opened ${PR_URL} and the preview is at ${PREVIEW_URL}`,
		);

		// An ungated workspace has no release event to wait for — holding
		// there would strand the links forever.
		expect(urlsFrom(updateSessionSurface)).toEqual([PR_URL, PREVIEW_URL]);
	});

	it("does not invent links when the session never mentions one", async () => {
		const { manager, updateSessionSurface } = makeManager({ held: true });

		await sendAssistantText(manager, "Still working through the orders page.");
		await manager.releaseHeldLinks(SESSION_ID);

		expect(urlsFrom(updateSessionSurface)).toEqual([]);
	});
});

/**
 * Surviving a restart, and surviving a failed release (PON-221, adversarial
 * review).
 *
 * The record that RELEASES held links is persisted, so the links must be too:
 * a deploy between "the agent opened the PR" and "Harold approved" would
 * otherwise drop them silently — the client gets a summary with nothing to
 * click and nothing anywhere says why.
 */
describe("held links survive a restart", () => {
	it("serializes and restores what is held", async () => {
		const first = makeManager({ held: true });
		await sendAssistantText(
			first.manager,
			`Opened ${PR_URL} and the preview is at ${PREVIEW_URL}`,
		);

		const persisted = first.manager.serializeHeldLinks();
		expect(persisted[SESSION_ID]?.map((l) => l.url)).toEqual([
			PR_URL,
			PREVIEW_URL,
		]);

		// A new process comes up and the approval lands there.
		const second = makeManager({ held: true });
		second.manager.restoreHeldLinks(persisted);
		await second.manager.releaseHeldLinks(SESSION_ID);

		expect(urlsFrom(second.updateSessionSurface)).toEqual([
			PR_URL,
			PREVIEW_URL,
		]);
	});

	it("restores cleanly from a state file written before this existed", () => {
		const { manager } = makeManager({ held: true });
		expect(() => manager.restoreHeldLinks(undefined)).not.toThrow();
		expect(manager.serializeHeldLinks()).toEqual({});
	});

	it("keeps the links when the release write fails, so approving again retries", async () => {
		const { manager, updateSessionSurface } = makeManager({ held: true });
		await sendAssistantText(manager, `Opened ${PR_URL}`);

		// Linear refuses once.
		updateSessionSurface.mockResolvedValueOnce(false);
		await manager.releaseHeldLinks(SESSION_ID);
		expect(manager.serializeHeldLinks()[SESSION_ID]?.length).toBe(1);

		// The operator approves again; this time it lands. Both attempts sent
		// the same link — the first was refused, which is the point.
		await manager.releaseHeldLinks(SESSION_ID);
		expect(updateSessionSurface).toHaveBeenCalledTimes(2);
		expect(urlsFrom(updateSessionSurface)).toEqual([PR_URL, PR_URL]);
		expect(manager.serializeHeldLinks()[SESSION_ID]).toBeUndefined();
	});
});
