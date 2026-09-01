import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * A reviewer must be able to halt a runaway mirror session from its own
 * thread. Required before any real client: an operator session works the
 * CLIENT's repository on the client's credential, so a run that will not
 * stop spends their budget and can keep moving their branch.
 *
 * The mirror intercept used to return unconditionally before the stop check,
 * so the stop never reached its handler. Worse than a no-op: Linear's Stop
 * button sends an empty body, which `classifyMirrorIntent` reads as
 * `orient` — a CLAIM — so pressing Stop announced "I am taking this" and let
 * the session run on.
 */

const COCKPIT_WS = "ws-cockpit";
const MIRROR_ISSUE = "issue-ckp-22";
const MIRROR_SESSION = "sess-mirror";
const CLIENT_ISSUE = "issue-acm-21";
const HAROLD = "user-harold";

function privates(w: EdgeWorker): Record<string, any> {
	return w as never as Record<string, any>;
}

function onAMirror() {
	const w = createTestWorker([]);
	const p = privates(w);
	p.cockpitMirror.clientIssueIdFor = vi.fn().mockReturnValue(CLIENT_ISSUE);
	p.handleMirrorAction = vi.fn();
	p.handleStopSignal = vi.fn();
	p.handleQueuedSessionStop = vi.fn();
	p.laneManager.isQueued = vi.fn().mockReturnValue(false);
	return p;
}

const prompted = (body: string, signal?: string) =>
	({
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: COCKPIT_WS,
		agentSession: {
			id: MIRROR_SESSION,
			issue: { id: MIRROR_ISSUE, identifier: "CKP-22" },
			creator: undefined,
		},
		agentActivity: { content: { body }, userId: HAROLD, signal },
	}) as never;

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("stopping a runaway mirror session", () => {
	it("the Stop button halts it instead of reading as a claim", async () => {
		// The button sends signal=stop with an EMPTY body — the exact shape
		// `classifyMirrorIntent` treats as a bare delegation.
		const p = onAMirror();

		await p.handleUserPromptedAgentActivity(prompted("", "stop"));

		expect(p.handleStopSignal).toHaveBeenCalled();
		expect(p.handleMirrorAction).not.toHaveBeenCalled();
	});

	it('typing "stop" halts it instead of being sent in as work', async () => {
		const p = onAMirror();

		await p.handleUserPromptedAgentActivity(prompted("stop"));

		expect(p.handleStopSignal).toHaveBeenCalled();
		expect(p.handleMirrorAction).not.toHaveBeenCalled();
	});

	it("a queued mirror session leaves the queue rather than the runner", async () => {
		const p = onAMirror();
		p.laneManager.isQueued = vi.fn().mockReturnValue(true);

		await p.handleUserPromptedAgentActivity(prompted("", "stop"));

		expect(p.handleQueuedSessionStop).toHaveBeenCalled();
		expect(p.handleStopSignal).not.toHaveBeenCalled();
	});

	it("every other mirror message still reaches the operator actions", async () => {
		// The stop must not swallow the verbs the mirror exists for.
		const p = onAMirror();

		for (const body of [
			"approve: ship it",
			"reject: redo the summary",
			"mine",
		]) {
			p.handleMirrorAction.mockClear();
			await p.handleUserPromptedAgentActivity(prompted(body));
			expect(p.handleMirrorAction).toHaveBeenCalled();
		}
		expect(p.handleStopSignal).not.toHaveBeenCalled();
	});

	it("does not fire on a sentence that merely contains the word", async () => {
		const p = onAMirror();

		await p.handleUserPromptedAgentActivity(
			prompted("stop using the deprecated helper and switch to the new one"),
		);

		expect(p.handleStopSignal).not.toHaveBeenCalled();
		expect(p.handleMirrorAction).toHaveBeenCalled();
	});
});
