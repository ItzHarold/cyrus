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
				{ content: "Read the failing test", status: "completed" as const },
				{ content: "Fix the bucketing", status: "inProgress" as const },
				{ content: "Open a PR", status: "pending" as const },
			];
			const ok = await service.updateAgentSession("sess-1", { plan });

			expect(ok).toBe(true);
			expect(variables().input.plan).toEqual(plan);
		});

		// The API types `plan` as JSONObject and validates it as an ARRAY of
		// `{ content, status }`. Until 2026-09-01 this method wrapped the steps
		// as `{ steps: [{ label, status }] }` — and the previous version of the
		// test above pinned that wrapper as the expected payload, so the suite
		// was green while every live update was refused with "Invalid agent
		// session plan: []: expected array, received object" (prod journal,
		// FRO-65, 2026-09-01T19:41:09Z). The checklist never rendered once.
		it("sends the plan as a bare array of { content, status } — the shape the platform validates", async () => {
			await service.updateAgentSession("sess-1", {
				plan: [{ content: "Open a PR", status: "pending" }],
			});

			const sent = variables().input.plan;
			expect(Array.isArray(sent)).toBe(true);
			expect(sent).toEqual([{ content: "Open a PR", status: "pending" }]);
			expect(sent[0]).not.toHaveProperty("label");
			expect(variables().input).not.toHaveProperty("steps");
		});

		// `plan` is typed JSONObject server-side: a bad step is accepted and then
		// ignored, so the checklist silently never appears. Validate here or not
		// at all.
		it("refuses a step with an unknown status rather than sending it", async () => {
			const ok = await service.updateAgentSession("sess-1", {
				plan: [{ content: "Do it", status: "done" as never }],
			});

			expect(ok).toBe(false);
			expect(rawRequest).not.toHaveBeenCalled();
			expect(errors.join(" ")).toMatch(/malformed plan/i);
		});

		it("refuses a step with empty content", async () => {
			const ok = await service.updateAgentSession("sess-1", {
				plan: [{ content: "", status: "pending" }],
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
					plan: [{ content: "Step", status: "pending" }],
				}),
			).resolves.toBe(false);
			expect(errors.join(" ")).toMatch(/Failed to update agent session/);
		});

		it("returns false when the platform reports no success", async () => {
			rawRequest.mockResolvedValue({ data: { agentSessionUpdate: {} } });

			await expect(
				service.updateAgentSession("sess-1", {
					plan: [{ content: "Step", status: "pending" }],
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
