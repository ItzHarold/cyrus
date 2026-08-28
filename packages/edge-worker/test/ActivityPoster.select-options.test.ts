import type { IIssueTrackerService, ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { ActivityPoster } from "../src/ActivityPoster.js";
import { sanitizeClientPaths } from "../src/client-content-policy.js";

/**
 * PON-194: select options are a client surface — the option label IS the
 * button the client clicks — and nothing sanitized them on any path, because
 * every sanitizer walked the activity `content` only.
 */

const WS = "workspace-1";
const SESSION = "session-1";

function setup() {
	const createAgentActivity = vi.fn().mockResolvedValue({
		success: true,
		agentActivity: Promise.resolve({ id: "a1" }),
	});
	const poster = new ActivityPoster(
		new Map([[WS, { createAgentActivity } as unknown as IIssueTrackerService]]),
		new Map(),
		{
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			event: vi.fn(),
		} as unknown as ILogger,
		{
			isQuiet: () => false,
			sanitize: (_s, _surface, text) =>
				sanitizeClientPaths(text, {
					stripPrefixes: ["/root/.cyrus-community/worktrees/ws/ACM-10"],
				}).text,
		},
	);
	return { poster, createAgentActivity };
}

describe("ActivityPoster - select options are sanitized (PON-194)", () => {
	it("rewrites an internal path in an option label", async () => {
		const { poster, createAgentActivity } = setup();
		await poster.postActivityDirect(
			{ createAgentActivity } as unknown as IIssueTrackerService,
			{
				agentSessionId: SESSION,
				content: { type: "elicitation", body: "Which one?" },
				signalMetadata: {
					options: [
						{
							value:
								"/root/.cyrus-community/worktrees/ws/ACM-10/src/app/page.tsx",
						},
						{ value: "Leave it" },
					],
				},
			} as never,
			"selection",
			"sanctioned",
			WS,
		);

		const posted = createAgentActivity.mock.calls[0][0];
		expect(posted.signalMetadata.options[0].value).toBe("src/app/page.tsx");
		// Untouched options keep their identity — a rewritten label the client
		// clicks must still resolve, so only what changed changes.
		expect(posted.signalMetadata.options[1].value).toBe("Leave it");
	});

	it("leaves clean options and the rest of signalMetadata alone", async () => {
		const { poster, createAgentActivity } = setup();
		await poster.postActivityDirect(
			{ createAgentActivity } as unknown as IIssueTrackerService,
			{
				agentSessionId: SESSION,
				content: { type: "elicitation", body: "Proceed?" },
				signalMetadata: {
					options: [{ value: "Approve scope" }, { value: "Cancel" }],
					extra: "kept",
				},
			} as never,
			"selection",
			"sanctioned",
			WS,
		);

		const posted = createAgentActivity.mock.calls[0][0];
		expect(
			posted.signalMetadata.options.map((o: { value: string }) => o.value),
		).toEqual(["Approve scope", "Cancel"]);
		expect(posted.signalMetadata.extra).toBe("kept");
	});
});
