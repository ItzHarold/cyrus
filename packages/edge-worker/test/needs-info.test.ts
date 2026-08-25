import { describe, expect, it } from "vitest";
import { findClientContentViolations } from "../src/client-content-policy.js";
import { NeedsInfoStore } from "../src/NeedsInfoStore.js";
import {
	buildNeedsInfoRuleBlock,
	isNeedsInfoQuestion,
	NEEDS_INFO_HEADER,
} from "../src/needs-info.js";

describe("needs-info (PON-172)", () => {
	describe("recognition", () => {
		it("recognises the ask by its exact canonical header", () => {
			expect(
				isNeedsInfoQuestion({
					question: "To finish the export you'll receive, I need: …",
					header: NEEDS_INFO_HEADER,
					options: [],
					multiSelect: false,
				} as never),
			).toBe(true);
			// Case/whitespace tolerant, like the scope gate's labels.
			expect(
				isNeedsInfoQuestion({
					question: "q",
					header: " missing info ",
					options: [],
					multiSelect: false,
				} as never),
			).toBe(true);
		});

		it("does not recognise other questions — exact header only", () => {
			expect(
				isNeedsInfoQuestion({
					question: "q",
					header: "Scope",
					options: [],
					multiSelect: false,
				} as never),
			).toBe(false);
			expect(
				isNeedsInfoQuestion({
					question: "q",
					header: "Missing information",
					options: [],
					multiSelect: false,
				} as never),
			).toBe(false);
		});
	});

	describe("rule block", () => {
		it("carries the canonical header, the one-ask rule, and deliverable framing", () => {
			const block = buildNeedsInfoRuleBlock();
			expect(block).toContain("<needs_info_rules>");
			expect(block).toContain(NEEDS_INFO_HEADER);
			expect(block).toContain("Ask once");
			expect(block).toContain("deliverable");
			expect(block).toContain("</needs_info_rules>");
		});

		it("defers to the scope gate before approval", () => {
			expect(buildNeedsInfoRuleBlock()).toContain("scope-confirmation flow");
		});

		it("is clean under the client content policy", () => {
			expect(
				findClientContentViolations(buildNeedsInfoRuleBlock()).filter(
					(violation) => violation.rule !== "model-family-word",
				),
			).toEqual([]);
		});
	});

	describe("NeedsInfoStore", () => {
		it("records an ask and answers it exactly once", () => {
			const store = new NeedsInfoStore();
			store.recordAsked("issue-1", {
				question: "I need the sender address",
				sessionId: "s-1",
				workspaceId: "ws-1",
				issueIdentifier: "DVV-12",
			});
			expect(store.isAwaiting("issue-1")).toBe(true);
			expect(store.get("issue-1")?.question).toBe("I need the sender address");

			expect(store.recordAnswered("issue-1")).toBe(true);
			expect(store.recordAnswered("issue-1")).toBe(false); // replay
			expect(store.isAwaiting("issue-1")).toBe(false);
			expect(store.get("issue-1")?.answeredAt).toBeDefined();
		});

		it("an answer with no open ask records nothing", () => {
			const store = new NeedsInfoStore();
			expect(store.recordAnswered("issue-1")).toBe(false);
			expect(store.get("issue-1")).toBeUndefined();
		});

		it("a re-ask re-opens the record and keeps firstAskedAt", () => {
			const store = new NeedsInfoStore();
			store.recordAsked("issue-1", { question: "first" });
			const first = store.get("issue-1")?.firstAskedAt;
			store.recordAnswered("issue-1");
			store.recordAsked("issue-1", { question: "second" });
			expect(store.isAwaiting("issue-1")).toBe(true);
			expect(store.get("issue-1")?.question).toBe("second");
			expect(store.get("issue-1")?.firstAskedAt).toBe(first);
		});

		it("lists only awaiting records", () => {
			const store = new NeedsInfoStore();
			store.recordAsked("issue-1", { question: "a" });
			store.recordAsked("issue-2", { question: "b" });
			store.recordAnswered("issue-2");
			expect(store.listAwaiting().map((entry) => entry.issueId)).toEqual([
				"issue-1",
			]);
		});

		it("round-trips through serialize/restore", () => {
			const store = new NeedsInfoStore();
			store.recordAsked("issue-1", { question: "a", workspaceId: "ws-1" });
			const restored = new NeedsInfoStore();
			restored.restore(store.serialize());
			expect(restored.isAwaiting("issue-1")).toBe(true);
			expect(restored.get("issue-1")?.workspaceId).toBe("ws-1");
			restored.restore(undefined);
			expect(restored.size).toBe(0);
		});

		it("remove clears the record (terminal issue)", () => {
			const store = new NeedsInfoStore();
			store.recordAsked("issue-1", { question: "a" });
			expect(store.remove("issue-1")).toBe(true);
			expect(store.remove("issue-1")).toBe(false);
		});
	});
});
