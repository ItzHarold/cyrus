import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_MESSAGES } from "../src/client-messages.js";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Startup retry (PON-138). A session that dies in a transient API failure
 * having produced almost nothing (the 529 startup-death signature) replays
 * itself with bounded, jittered backoff; permanent errors fail fast; when
 * retries run out the CLIENT hears it — silence is the failure being fixed.
 */

const WS = "ws-retry";
const ISSUE_ID = "issue-retry-1";
const SESSION_ID = "agent-session-retry-1";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function setup() {
	const worker = createTestWorker([]);
	privates(worker).config.linearWorkspaces = { [WS]: { linearToken: "t" } };
	privates(worker).agentSessionManager.createCyrusAgentSession(
		SESSION_ID,
		ISSUE_ID,
		{
			id: ISSUE_ID,
			identifier: "RTY-1",
			title: "t",
			description: "d",
			branchName: "b",
		},
		{ path: "/test/repo", isGitWorktree: false },
	);
	// Simulate the capture initializeAgentRunner performs.
	privates(worker).startupRetryState.set(SESSION_ID, {
		args: [
			{ id: SESSION_ID, issue: { id: ISSUE_ID, identifier: "RTY-1" } },
			[{ id: "repo-1" }],
			WS,
			undefined,
			undefined,
			undefined,
			undefined,
		],
		attempts: 0,
	});
	return worker;
}

function stubResult(worker: EdgeWorker, error: string | null, entries = 4) {
	privates(worker).agentSessionManager.getLastResultError = vi
		.fn()
		.mockReturnValue(error);
	privates(worker).agentSessionManager.getEntryCount = vi
		.fn()
		.mockReturnValue(entries);
}

describe("EdgeWorker - startup retry (PON-138)", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("a 529 startup death schedules a retry and replays initializeAgentRunner", async () => {
		const worker = setup();
		stubResult(
			worker,
			"Claude Code returned an error result: API Error: 529 Overloaded",
		);
		const init = vi
			.spyOn(privates(worker), "initializeAgentRunner" as never)
			.mockResolvedValue(undefined as never);

		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(true);
		expect(privates(worker).startupRetryState.get(SESSION_ID)?.attempts).toBe(
			1,
		);

		await vi.advanceTimersByTimeAsync(60_000); // > base 30s + max jitter
		expect(init).toHaveBeenCalledTimes(1);
	});

	it("a permanent auth error fails fast — no retry, state cleared", () => {
		const worker = setup();
		stubResult(worker, "API Error: 401 invalid api key");

		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(false);
		expect(privates(worker).startupRetryState.has(SESSION_ID)).toBe(false);
	});

	it("a billing error never retries (standing rule)", () => {
		const worker = setup();
		stubResult(worker, "Your credit balance is too low");

		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(false);
	});

	it("permanent markers WIN over co-occurring transient ones — a billing 429 never retries", () => {
		const worker = setup();
		stubResult(
			worker,
			"429 too many requests: your credit balance is too low to continue",
		);

		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(false);
		expect(privates(worker).startupRetryState.has(SESSION_ID)).toBe(false);
	});

	it("a mid-work death does not retry — replays could repeat repo mutations", () => {
		const worker = setup();
		stubResult(worker, "API Error: 529 Overloaded", 57);

		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(false);
	});

	it("a clean result clears the state silently", () => {
		const worker = setup();
		stubResult(worker, null);

		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(false);
		expect(privates(worker).startupRetryState.has(SESSION_ID)).toBe(false);
	});

	it("exhausted retries tell the CLIENT and stop — silence is the fixed failure", () => {
		const worker = setup();
		privates(worker).startupRetryState.get(SESSION_ID).attempts = 4;
		stubResult(worker, "API Error: 529 Overloaded");
		const errorActivity = vi
			.spyOn(
				privates(worker).agentSessionManager,
				"createErrorActivity" as never,
			)
			.mockResolvedValue(undefined as never);

		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(false);
		expect(errorActivity).toHaveBeenCalledWith(
			SESSION_ID,
			CLIENT_MESSAGES.sessionStartFailed(),
		);
		expect(privates(worker).startupRetryState.has(SESSION_ID)).toBe(false);
	});

	it("attempts are bounded with exponential, jittered delays", () => {
		const worker = setup();
		stubResult(worker, "rate_limit_event: 429 too many requests");
		const delays: number[] = [];
		const spy = vi.spyOn(global, "setTimeout").mockImplementation(((
			_fn: () => void,
			ms?: number,
		) => {
			delays.push(ms ?? 0);
			return { unref() {} } as never;
		}) as never);

		for (let i = 0; i < 4; i++) {
			expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(true);
		}
		// Fifth: exhausted.
		vi.spyOn(
			privates(worker).agentSessionManager,
			"createErrorActivity" as never,
		).mockResolvedValue(undefined as never);
		expect(privates(worker).maybeScheduleStartupRetry(SESSION_ID)).toBe(false);

		spy.mockRestore();
		expect(delays).toHaveLength(4);
		const bases = [30_000, 60_000, 120_000, 240_000];
		delays.forEach((delay, i) => {
			expect(delay).toBeGreaterThanOrEqual(bases[i] as number);
			expect(delay).toBeLessThanOrEqual((bases[i] as number) * 1.25);
		});
	});

	it("a failed-attempt error summary held for verification is discarded, not delivered", () => {
		const worker = setup();
		stubResult(worker, "API Error: 529 Overloaded");
		privates(worker).verificationGate.recordPending(ISSUE_ID, {
			workspaceId: WS,
			issueIdentifier: "RTY-1",
			sessionId: SESSION_ID,
			summary: "API Error: 529 Overloaded",
			isError: true,
		});
		vi.spyOn(global, "setTimeout").mockImplementation((() => ({
			unref() {},
		})) as never);

		privates(worker).maybeScheduleStartupRetry(SESSION_ID);

		expect(privates(worker).verificationGate.isPending(ISSUE_ID)).toBe(false);
	});

	it("a retry never replays a session that was cleaned up (the PON-135 lesson)", async () => {
		const worker = setup();
		stubResult(worker, "API Error: 529 Overloaded");
		const init = vi
			.spyOn(privates(worker), "initializeAgentRunner" as never)
			.mockResolvedValue(undefined as never);
		privates(worker).maybeScheduleStartupRetry(SESSION_ID);
		privates(worker).agentSessionManager.getSession = vi
			.fn()
			.mockReturnValue(undefined);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(init).not.toHaveBeenCalled();
		expect(privates(worker).startupRetryState.has(SESSION_ID)).toBe(false);
	});
});
