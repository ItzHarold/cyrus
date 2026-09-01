import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinearIssueTrackerService } from "../src/LinearIssueTrackerService.js";

/**
 * `agentSessionUpdate` carries the session plan and the PR/preview link
 * buttons. Both are cosmetic, and both are issued while real client work is in
 * flight — so the contract these tests pin is mostly about what must NOT
 * happen: no throwing into the session path, and no malformed plan reaching an
 * API that accepts anything and silently ignores what it cannot read.
 */
describe("LinearIssueTrackerService.updateAgentSession", () => {
	let service: LinearIssueTrackerService;
	let rawRequest: ReturnType<typeof vi.fn>;
	let errors: string[];

	beforeEach(() => {
		errors = [];
		rawRequest = vi.fn().mockResolvedValue({
			data: { agentSessionUpdate: { success: true } },
		});
		const logger = {
			info: () => {},
			warn: () => {},
			debug: () => {},
			error: (m: string) => errors.push(String(m)),
		};
		// Signature is (linearClient, oauthConfig?, logger?). Leaving oauthConfig
		// undefined also skips the 401-refresh patching of client.request, which
		// this test has no reason to exercise.
		service = new LinearIssueTrackerService(
			{ client: { rawRequest } } as never,
			undefined,
			logger as never,
		);
	});

	const variables = () => rawRequest.mock.calls[0]?.[1] as Record<string, any>;

	describe("plan", () => {
		it("sends every step, because the platform replaces rather than merges", async () => {
			const plan = [
				{ label: "Read the failing test", status: "completed" as const },
				{ label: "Fix the bucketing", status: "inProgress" as const },
				{ label: "Open a PR", status: "pending" as const },
			];
			const ok = await service.updateAgentSession("sess-1", { plan });

			expect(ok).toBe(true);
			expect(variables().input.plan).toEqual({ steps: plan });
		});

		// `plan` is typed JSONObject server-side: a bad step is accepted and then
		// ignored, so the checklist silently never appears. Validate here or not
		// at all.
		it("refuses a step with an unknown status rather than sending it", async () => {
			const ok = await service.updateAgentSession("sess-1", {
				plan: [{ label: "Do it", status: "done" as never }],
			});

			expect(ok).toBe(false);
			expect(rawRequest).not.toHaveBeenCalled();
			expect(errors.join(" ")).toMatch(/malformed plan/i);
		});

		it("refuses a step with an empty label", async () => {
			const ok = await service.updateAgentSession("sess-1", {
				plan: [{ label: "", status: "pending" }],
			});

			expect(ok).toBe(false);
			expect(rawRequest).not.toHaveBeenCalled();
		});
	});

	describe("external links", () => {
		it("sends url and label for each added link", async () => {
			const ok = await service.updateAgentSession("sess-1", {
				addedExternalUrls: [
					{ url: "https://github.com/o/r/pull/7", label: "Pull request" },
					{ url: "https://preview.example.com", label: "Preview" },
				],
			});

			expect(ok).toBe(true);
			expect(variables().input.addedExternalUrls).toHaveLength(2);
			expect(variables().input.addedExternalUrls[0].label).toBe("Pull request");
		});
	});

	describe("never interrupts the session", () => {
		it("returns false instead of throwing when the request fails", async () => {
			rawRequest.mockRejectedValue(new Error("502 Bad Gateway"));

			await expect(
				service.updateAgentSession("sess-1", {
					plan: [{ label: "Step", status: "pending" }],
				}),
			).resolves.toBe(false);
			expect(errors.join(" ")).toMatch(/Failed to update agent session/);
		});

		it("returns false when the platform reports no success", async () => {
			rawRequest.mockResolvedValue({ data: { agentSessionUpdate: {} } });

			await expect(
				service.updateAgentSession("sess-1", {
					plan: [{ label: "Step", status: "pending" }],
				}),
			).resolves.toBe(false);
		});

		it("does not call the API when there is nothing to update", async () => {
			await expect(service.updateAgentSession("sess-1", {})).resolves.toBe(
				false,
			);
			expect(rawRequest).not.toHaveBeenCalled();
		});
	});
});
