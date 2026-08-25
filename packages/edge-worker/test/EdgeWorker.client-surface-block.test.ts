import { describe, expect, it, vi } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("R2 intrinsic block", () => {
	it("every new session's system prompt carries the client-surface rules", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const worker = createTestWorker([]);
		const result = await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession({ issueId: "i1", workspace: { path: "/t" }, metadata: {} })
			.withIssue({ id: "i1", identifier: "T-1", title: "t", description: "d" })
			.withRepository({ id: "r1", path: "/t" })
			.withUserComment("")
			.withLabels()
			.build();
		expect(result.systemPrompt).toContain("<client_surface_rules>");
	});
});
