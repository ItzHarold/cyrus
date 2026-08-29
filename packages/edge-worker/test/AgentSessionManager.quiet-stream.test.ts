import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { CLIENT_MESSAGES } from "../src/client-messages.js";

/**
 * Client-quiet activity stream (PON-179). On a gated workspace the Linear
 * activity stream is a CLIENT surface: working narration (thought/action
 * activities — including tool-call renderings, which can carry internal
 * paths and even the operator note's parameters) must not post. Liveness
 * comes from the ack, the per-invocation analyzing thought, ONE generic
 * status, elicitations, and the final response.
 */

const SESSION_ID = "agent-session-quiet-1";

function makeManager(quiet: boolean) {
	const manager = new AgentSessionManager(
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		() => quiet,
	);
	manager.createCyrusAgentSession(
		SESSION_ID,
		"issue-1",
		{
			id: "issue-1",
			identifier: "FRO-99",
			title: "t",
			description: "d",
			branchName: "b",
		},
		{
			path: "/root/.cyrus-community/worktrees/ws-1/FRO-99",
			isGitWorktree: false,
		},
	);
	const postActivity = vi.fn().mockResolvedValue({ activityId: "a-1" });
	manager.setActivitySink(SESSION_ID, {
		postActivity,
		createAgentSession: vi.fn(),
	} as never);
	return { manager, postActivity };
}

describe("AgentSessionManager - client-quiet stream (PON-179)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("suppresses narration on a quiet session: one generic status, then silence", async () => {
		const { manager, postActivity } = makeManager(true);

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createActionActivity(
			SESSION_ID,
			"Edit",
			"/root/.cyrus-community/worktrees/ws-1/FRO-99/SUPPORT.md",
		);
		await manager.createThoughtActivity(SESSION_ID, "Now writing the file…");

		expect(postActivity).toHaveBeenCalledTimes(1);
		const [, content] = postActivity.mock.calls[0] as [
			string,
			{ body: string },
		];
		expect(content.body).toBe(CLIENT_MESSAGES.workingStatus());
	});

	it("tool-call action renderings never post on a quiet session (the operator-note leak)", async () => {
		const { manager, postActivity } = makeManager(true);
		await manager.createThoughtActivity(SESSION_ID, "warm up"); // consumes the status slot
		postActivity.mockClear();

		await manager.createActionActivity(
			SESSION_ID,
			"mcp__cyrus-tools__record_operator_note",
			'{"cwd":"/root/.cyrus-community/worktrees/ws-1/FRO-99","note":"## Internal reading — approach, risks"}',
		);

		expect(postActivity).not.toHaveBeenCalled();
	});

	it("the analyzing thought passes through and re-arms the status for the next invocation", async () => {
		const { manager, postActivity } = makeManager(true);

		await manager.createThoughtActivity(SESSION_ID, "narration 1"); // → status
		await manager.createThoughtActivity(SESSION_ID, "narration 2"); // suppressed
		await manager.postAnalyzingThought(SESSION_ID); // allowed + re-arm
		await manager.createThoughtActivity(SESSION_ID, "narration 3"); // → status again

		const bodies = postActivity.mock.calls.map(
			(call) => (call[1] as { body: string }).body,
		);
		expect(bodies).toEqual([
			CLIENT_MESSAGES.workingStatus(),
			"Analyzing your request…",
			CLIENT_MESSAGES.workingStatus(),
		]);
	});

	it("a non-quiet session posts narration verbatim — non-gated workspaces unchanged", async () => {
		const { manager, postActivity } = makeManager(false);

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createActionActivity(SESSION_ID, "Bash", "pnpm test");

		expect(postActivity).toHaveBeenCalledTimes(2);
		expect((postActivity.mock.calls[0]?.[1] as { body: string }).body).toBe(
			"Reading the repo…",
		);
	});

	it("the STREAMED-entries path is gated too — the main narration artery (live FRO-55 finding)", async () => {
		const { manager, postActivity } = makeManager(true);
		const sync = (
			manager as unknown as {
				syncEntryToActivitySink: (
					entry: Record<string, unknown>,
					sessionId: string,
				) => Promise<void>;
			}
		).syncEntryToActivitySink.bind(manager);

		// Assistant text → thought; tool call → action: the formatter output
		// that leaked on FRO-55.
		await sync(
			{ type: "assistant", content: "Scope: single PR — appending a line." },
			SESSION_ID,
		);
		await sync(
			{
				type: "assistant",
				content: "/root/.cyrus-community/worktrees/ws-1/FRO-99/README.md",
				metadata: {
					toolUseId: "t1",
					toolName: "Read",
					toolInput: JSON.stringify({
						file_path: "/root/.cyrus-community/worktrees/ws-1/FRO-99/README.md",
					}),
				},
			},
			SESSION_ID,
		);
		await sync({ type: "assistant", content: "Now editing…" }, SESSION_ID);

		// Exactly one post: the generic status. No narration, no paths.
		expect(postActivity).toHaveBeenCalledTimes(1);
		const posted = JSON.stringify(postActivity.mock.calls[0]?.[1]);
		expect(posted).toContain(CLIENT_MESSAGES.workingStatus());
		expect(posted).not.toContain("/root/");
	});

	it("one status across BOTH paths — the shared set spans funnel and stream", async () => {
		const { manager, postActivity } = makeManager(true);
		await manager.createThoughtActivity(SESSION_ID, "funnel narration");
		const sync = (
			manager as unknown as {
				syncEntryToActivitySink: (
					entry: Record<string, unknown>,
					sessionId: string,
				) => Promise<void>;
			}
		).syncEntryToActivitySink.bind(manager);
		await sync(
			{ type: "assistant", content: "streamed narration" },
			SESSION_ID,
		);

		expect(postActivity).toHaveBeenCalledTimes(1);
	});

	it("the elicitation body goes through the sanitizer (source wiring)", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const handler = readFileSync(
			join(__dirname, "..", "src", "AskUserQuestionHandler.ts"),
			"utf8",
		);
		expect(handler).toContain("sanitizeClientText?.(");
		const worker = readFileSync(
			join(__dirname, "..", "src", "EdgeWorker.ts"),
			"utf8",
		);
		expect(worker).toContain("sanitizeClientSurfaceText(");
	});

	it("sanitizeClientSurfaceText: full policy on quiet, path floor on non-quiet (PON-182)", () => {
		const quiet = makeManager(true).manager;
		const sanitized = quiet.sanitizeClientSurfaceText(
			SESSION_ID,
			"elicitation",
			"Should I update /root/.cyrus-community/worktrees/ws-1/FRO-99/app/page.tsx?",
		);
		expect(sanitized).toBe("Should I update app/page.tsx?");

		// Non-quiet: paths are STILL sanitized (unconditional floor) — but
		// names are left alone (dogfood narration says package names).
		const loud = makeManager(false).manager;
		const floored = loud.sanitizeClientSurfaceText(
			SESSION_ID,
			"elicitation",
			"Update cyrus-edge-worker config at /root/.cyrus-community/worktrees/ws-1/FRO-99/app/page.tsx?",
		);
		expect(floored).toBe("Update cyrus-edge-worker config at app/page.tsx?");
	});

	// PON-182: the unconditional path floor on NON-quiet sessions.
	it("non-quiet narration posts, but never with a box path — both posting paths", async () => {
		const { manager, postActivity } = makeManager(false);

		await manager.createActionActivity(
			SESSION_ID,
			"Edit",
			"/root/.cyrus-community/worktrees/ws-1/FRO-99/SUPPORT.md",
		);
		const sync = (
			manager as unknown as {
				syncEntryToActivitySink: (
					entry: Record<string, unknown>,
					sessionId: string,
				) => Promise<void>;
			}
		).syncEntryToActivitySink.bind(manager);
		await sync(
			{
				type: "assistant",
				content:
					"Reading /root/.cyrus-community/worktrees/ws-1/FRO-99/README.md now",
			},
			SESSION_ID,
		);

		expect(postActivity).toHaveBeenCalledTimes(2);
		const all = JSON.stringify(postActivity.mock.calls);
		expect(all).not.toContain("/root/");
		expect(all).toContain("SUPPORT.md");
		expect(all).toContain("Reading README.md now");
	});
});

/**
 * PON-212: quiet meant the narration was DELETED, so the operator lost it
 * too — a 389-message session left four activities on the client thread and
 * nothing anywhere else. Quiet must mean quiet on the CLIENT's surface and
 * loud on the operator's.
 */
describe("AgentSessionManager - narration is redirected, not dropped (PON-212)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("sends suppressed narration to the operator's thread instead", async () => {
		const { manager, postActivity } = makeManager(true);
		const shadow = vi.fn().mockResolvedValue({ activityId: "s-1" });
		manager.setShadowSink(SESSION_ID, {
			sink: { postActivity: shadow, createAgentSession: vi.fn() } as never,
			targetSessionId: "mirror-session-1",
		});

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createThoughtActivity(
			SESSION_ID,
			"Found the bug in page.tsx",
		);
		await manager.createActionActivity(SESSION_ID, "Edit", "src/page.tsx");
		await settle();

		// The client still gets exactly one generic status and no detail.
		const clientBodies = postActivity.mock.calls.map((c) =>
			JSON.stringify(c[1]),
		);
		expect(clientBodies).toHaveLength(1);
		expect(clientBodies[0]).not.toContain("page.tsx");

		// The operator gets everything that was suppressed, addressed to the
		// mirror's thread.
		expect(shadow.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(shadow.mock.calls.every((c) => c[0] === "mirror-session-1")).toBe(
			true,
		);
		expect(JSON.stringify(shadow.mock.calls)).toContain("page.tsx");
	});

	it("redirects the STREAMED narration artery too, not just the funnel", async () => {
		// Two separate suppression sites feed the client surface; fixing one
		// and not the other would silently lose most of the transcript, since
		// the streamed path carries the formatter output (tool calls, edits).
		const { manager } = makeManager(true);
		const shadow = vi.fn().mockResolvedValue({ activityId: "s-1" });
		manager.setShadowSink(SESSION_ID, {
			sink: { postActivity: shadow, createAgentSession: vi.fn() } as never,
			targetSessionId: "mirror-session-1",
		});
		const sync = (
			manager as unknown as {
				syncEntryToActivitySink: (
					entry: Record<string, unknown>,
					sessionId: string,
				) => Promise<void>;
			}
		).syncEntryToActivitySink.bind(manager);

		// First one becomes the generic status; the rest must be redirected.
		await sync({ type: "assistant", content: "first" }, SESSION_ID);
		await sync({ type: "assistant", content: "editing page.tsx" }, SESSION_ID);
		await sync({ type: "assistant", content: "running the build" }, SESSION_ID);
		await settle();

		expect(shadow.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(shadow.mock.calls)).toContain("page.tsx");
	});

	it("still drops nothing on the client when no operator thread exists", async () => {
		// A cockpit-less install keeps the old behaviour rather than erroring.
		const { manager, postActivity } = makeManager(true);
		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createThoughtActivity(SESSION_ID, "More detail");
		await settle();
		expect(postActivity).toHaveBeenCalledTimes(1);
	});

	it("a failing operator thread never breaks the client session", async () => {
		const { manager, postActivity } = makeManager(true);
		manager.setShadowSink(SESSION_ID, {
			sink: {
				postActivity: vi.fn().mockRejectedValue(new Error("cockpit down")),
				createAgentSession: vi.fn(),
			} as never,
			targetSessionId: "mirror-session-1",
		});

		await manager.createThoughtActivity(SESSION_ID, "one");
		await expect(
			manager.createThoughtActivity(SESSION_ID, "two"),
		).resolves.not.toThrow();
		await settle();
		expect(postActivity).toHaveBeenCalledTimes(1);
	});
});

/**
 * PON-216: the shadow was attached at session CREATION only, so a resumed
 * session narrated nowhere — and a restart resumes everything.
 *
 * Live effect on ACM-19: the mirror showed the scope investigation and none
 * of the implementation that followed approval, which is what made the
 * pre-consent half read as work already done.
 */
describe("AgentSessionManager - the shadow survives a resume (PON-216)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("keeps narrating after the sink is re-registered", async () => {
		const { manager } = makeManager(true);
		const shadow = vi.fn().mockResolvedValue({ activityId: "s-1" });
		manager.setShadowSink(SESSION_ID, {
			sink: { postActivity: shadow, createAgentSession: vi.fn() } as never,
			targetSessionId: "mirror-1",
		});
		await manager.createThoughtActivity(SESSION_ID, "before");
		await manager.createThoughtActivity(SESSION_ID, "editing page.tsx");

		// A restart drops in-memory state; the resume path re-attaches.
		manager.setShadowSink(SESSION_ID, undefined);
		manager.setShadowSink(SESSION_ID, {
			sink: { postActivity: shadow, createAgentSession: vi.fn() } as never,
			targetSessionId: "mirror-1",
		});
		await manager.createThoughtActivity(SESSION_ID, "after the restart");
		await new Promise((r) => setTimeout(r, 0));

		expect(JSON.stringify(shadow.mock.calls)).toContain("after the restart");
	});

	it("stops narrating when the shadow is cleared", async () => {
		// The failure the fix addresses: no shadow means the work is invisible,
		// not merely delayed.
		const { manager } = makeManager(true);
		const shadow = vi.fn().mockResolvedValue({ activityId: "s-1" });
		manager.setShadowSink(SESSION_ID, {
			sink: { postActivity: shadow, createAgentSession: vi.fn() } as never,
			targetSessionId: "mirror-1",
		});
		await manager.createThoughtActivity(SESSION_ID, "first");
		manager.setShadowSink(SESSION_ID, undefined);
		await manager.createThoughtActivity(SESSION_ID, "lost work");
		await new Promise((r) => setTimeout(r, 0));

		expect(JSON.stringify(shadow.mock.calls)).not.toContain("lost work");
	});
});

/**
 * PON-216: the plan reaching the mirror before consent read as work already
 * done. The design call was to keep it and label it.
 */
describe("AgentSessionManager - a plan before consent reads as a proposal", () => {
	const settle = () => new Promise((r) => setTimeout(r, 0));
	const PLAN = "⏳ **Verify and open the pull request**";

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	const attach = (manager: AgentSessionManager, approved: () => boolean) => {
		const shadow = vi.fn().mockResolvedValue({ activityId: "s-1" });
		manager.setShadowSink(SESSION_ID, {
			sink: { postActivity: shadow, createAgentSession: vi.fn() } as never,
			targetSessionId: "mirror-1",
			preConsent: () => !approved(),
		});
		return shadow;
	};

	it("labels the checklist that triggered this", async () => {
		const { manager } = makeManager(true);
		const shadow = attach(manager, () => false);

		// The first narration of an invocation becomes the client's generic
		// status and never reaches the shadow, so the plan has to follow one.
		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createThoughtActivity(SESSION_ID, PLAN);
		await settle();

		const posted = JSON.stringify(shadow.mock.calls);
		expect(posted).toContain("nothing here has been done");
		// The plan itself survives — suppressing it was the option we rejected.
		expect(posted).toContain("Verify and open the pull request");
	});

	it("stops labelling once the client has approved", async () => {
		// The property that matters: the predicate is READ at post time. The
		// shadow is attached once at session creation and the gate opens later
		// in the same session, so a value captured at attach time would label
		// the whole implementation as an unapproved proposal.
		const { manager } = makeManager(true);
		let approved = false;
		const shadow = attach(manager, () => approved);

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createThoughtActivity(SESSION_ID, PLAN);
		approved = true;
		await manager.createThoughtActivity(SESSION_ID, "⏳ **Ship it**");
		await settle();

		const [before, after] = shadow.mock.calls.map((c) => JSON.stringify(c[1]));
		expect(before).toContain("not yet approved");
		expect(after).not.toContain("not yet approved");
	});

	it("leaves ordinary narration untouched before consent", async () => {
		const { manager } = makeManager(true);
		const shadow = attach(manager, () => false);

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createThoughtActivity(SESSION_ID, "Reading the orders table");
		await settle();

		expect(JSON.stringify(shadow.mock.calls)).not.toContain("not yet approved");
	});

	it("narrates anyway when the approval lookup throws", async () => {
		// Cosmetics on an operator surface sitting on the path of every
		// narrated activity: losing the label is a cost, losing the narration
		// is the bug we just fixed.
		const { manager } = makeManager(true);
		const shadow = vi.fn().mockResolvedValue({ activityId: "s-1" });
		manager.setShadowSink(SESSION_ID, {
			sink: { postActivity: shadow, createAgentSession: vi.fn() } as never,
			targetSessionId: "mirror-1",
			preConsent: () => {
				throw new Error("store unavailable");
			},
		});

		await manager.createThoughtActivity(SESSION_ID, "Reading the repo…");
		await manager.createThoughtActivity(SESSION_ID, PLAN);
		await settle();

		expect(JSON.stringify(shadow.mock.calls)).toContain(
			"Verify and open the pull request",
		);
	});
});
