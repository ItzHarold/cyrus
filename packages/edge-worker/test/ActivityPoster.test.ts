import type { IIssueTrackerService, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPoster } from "../src/ActivityPoster.js";

describe("ActivityPoster", () => {
	let createAgentActivity: ReturnType<typeof vi.fn>;
	let poster: ActivityPoster;

	beforeEach(() => {
		createAgentActivity = vi.fn().mockResolvedValue({
			success: true,
			agentActivity: Promise.resolve({ id: "activity-1" }),
		});

		poster = new ActivityPoster(
			new Map([
				[
					"workspace-1",
					{ createAgentActivity } as unknown as IIssueTrackerService,
				],
			]),
			new Map(),
			{
				debug: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				info: vi.fn(),
			} as unknown as ILogger,
		);
	});

	it("adds a sudo guidance hint to repo setup hook sudo failures", async () => {
		await poster.postRepoSetupHookActivity("session-1", "workspace-1", {
			status: "failed",
			issueIdentifier: "ENG-97",
			scriptName: "cyrus-setup.sh",
			repositoryName: "test-repo",
			durationMs: 1_200,
			exitCode: 1,
			errorMessage: "Script exited with code 1",
			stderrTail: "sudo: a password is required",
			truncated: false,
		});

		const result = createAgentActivity.mock.calls[0][0].content.result;
		expect(result).toContain("sudo: a password is required");
		expect(result).toContain(
			"The setup script does not run with sudo privileges.",
		);
		expect(result).toContain("Settings > Packages (`/settings/packages`)");
		expect(result).toContain("self-hosted Cyrus");
	});

	it("does not add sudo guidance to non-sudo repo setup hook failures", async () => {
		await poster.postRepoSetupHookActivity("session-1", "workspace-1", {
			status: "failed",
			issueIdentifier: "ENG-97",
			scriptName: "cyrus-setup.sh",
			repositoryName: "test-repo",
			durationMs: 1_200,
			exitCode: 42,
			errorMessage: "Script exited with code 42",
			stderrTail: "missing package @fake/missing",
			truncated: false,
		});

		const result = createAgentActivity.mock.calls[0][0].content.result;
		expect(result).toContain("missing package @fake/missing");
		expect(result).not.toContain("sudo privileges");
		expect(result).not.toContain("/settings/packages");
	});

	// PON-112: Linear only delivers `prompted` webhooks for sessions where the
	// agent has yielded its turn. A queued session that posts a thought and
	// then goes silent holds its turn forever, so client replies — including
	// the reorder the acknowledgment explicitly invites — are recorded by
	// Linear but never pushed to us. Every lane message on a session that
	// STAYS queued must therefore be an elicitation (status: awaitingInput).
	describe("lane messages keep queued sessions able to receive replies (PON-112)", () => {
		const contentOf = () => createAgentActivity.mock.calls[0]![0].content;

		it("posts the queued acknowledgment as an elicitation, not a thought", async () => {
			await poster.postQueuedAcknowledgment("session-1", "workspace-1", 2);
			expect(contentOf().type).toBe("elicitation");
			expect(contentOf().body).toContain("position #2");
		});

		it("posts queue position updates as elicitations", async () => {
			await poster.postQueuePositionUpdate("session-1", "workspace-1", 1);
			expect(contentOf().type).toBe("elicitation");
		});

		it("posts reorder confirmations as elicitations", async () => {
			await poster.postQueueReorderConfirmation(
				"session-1",
				"workspace-1",
				false,
			);
			expect(contentOf().type).toBe("elicitation");
		});

		it("posts queued-context acknowledgments as elicitations", async () => {
			await poster.postQueueContextAcknowledgment(
				"session-1",
				"workspace-1",
				3,
			);
			expect(contentOf().type).toBe("elicitation");
		});

		it("posts the grace-release notice as an elicitation (it invites a reply)", async () => {
			await poster.postLaneGraceReleaseNotice("session-1", "workspace-1");
			expect(contentOf().type).toBe("elicitation");
		});

		it("posts the removal notice as a response — the session leaves the queue", async () => {
			await poster.postQueueRemovedNotice("session-1", "workspace-1");
			expect(contentOf().type).toBe("response");
		});
	});
});
