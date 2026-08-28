import type { AskUserQuestion } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	buildScopeConfirmGateBlock,
	interpretCanonicalScopeAnswer,
	interpretScopeConfirmAnswer,
	isScopeConfirmQuestion,
	SCOPE_APPROVE_LABEL,
	SCOPE_CANCEL_LABEL,
	SCOPE_REVISE_LABEL,
} from "../src/scope-confirm-gate.js";

const confirmQuestion: AskUserQuestion = {
	question: "Proceed with the scope as posted?",
	header: "Scope",
	options: [
		{ label: SCOPE_APPROVE_LABEL, description: "Start implementing" },
		{ label: SCOPE_REVISE_LABEL, description: "Ask for a revised reading" },
		{ label: SCOPE_CANCEL_LABEL, description: "Stop here" },
	],
	multiSelect: false,
};

const ambiguityQuestion: AskUserQuestion = {
	question: "Which environment should this target?",
	header: "Environment",
	options: [
		{ label: "Staging", description: "The staging deployment" },
		{ label: "Production", description: "The production deployment" },
	],
	multiSelect: false,
};

describe("scope-confirm-gate (PON-150)", () => {
	describe("buildScopeConfirmGateBlock", () => {
		it("carries the canonical labels the machinery recognises", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("<scope_confirm_gate>");
			expect(block).toContain(SCOPE_APPROVE_LABEL);
			expect(block).toContain(SCOPE_REVISE_LABEL);
			expect(block).toContain(SCOPE_CANCEL_LABEL);
			expect(block).toContain("</scope_confirm_gate>");
		});

		it("declares precedence over proceed-without-waiting instructions", () => {
			// The same system prompt carries PON-114's "state your reading and
			// proceed" guidance; without an explicit supersede line the model
			// gets two contradictory always-on instructions (review finding).
			expect(buildScopeConfirmGateBlock()).toContain("supersedes");
		});

		// PON-169: deliverable framing — the internal reading goes to the
		// operator, the client confirms what they will receive.
		it("instructs the operator note BEFORE the client-facing confirmation", () => {
			const block = buildScopeConfirmGateBlock();
			const noteStep = block.indexOf("record_operator_note");
			// PON-191: the client-facing scope IS the recorded client_scope —
			// the machinery comments it on the issue — so the step that used to
			// say "post the DELIVERABLE-framed comment" now says client_scope
			// carries it. The ordering it guards is unchanged.
			const clientStep = block.indexOf("client_scope text you recorded");
			expect(noteStep).toBeGreaterThan(-1);
			expect(clientStep).toBeGreaterThan(-1);
			expect(noteStep).toBeLessThan(clientStep);
		});

		it("tells the session NOT to post the scope itself — the machinery does", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("Do not post it yourself");
		});

		it("requires the ask to stand alone, not lean on surrounding text", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("must stand on their own");
			expect(block).toContain("no surrounding text");
		});

		it("frames the client comment as the deliverable and bans implementation detail", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("**Outcome**");
			expect(block).toContain("**You will receive**");
			expect(block).toContain("**Interpreted**");
			expect(block).toContain("No implementation detail");
			expect(block).toContain("no file names");
		});

		it("a revision updates the operator note too, not just the client text", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("update the operator note");
		});
	});

	describe("isScopeConfirmQuestion", () => {
		it("recognises the confirmation ask by its exact canonical Approve option", () => {
			expect(isScopeConfirmQuestion(confirmQuestion)).toBe(true);
		});

		it("does not mistake an ambiguity elicitation for the gate", () => {
			expect(isScopeConfirmQuestion(ambiguityQuestion)).toBe(false);
		});

		it("an approve-PREFIXED option is not the gate — exact label only", () => {
			// "Approve deletion of old rows?" must never be mistaken for the
			// gate: its answer would stamp the SLA clock (review finding).
			const deletionQuestion: AskUserQuestion = {
				question: "Delete the 400 stale rows?",
				header: "Cleanup",
				options: [
					{ label: "Approve deletion", description: "delete them" },
					{ label: "Keep them", description: "leave the rows" },
				],
				multiSelect: false,
			};
			expect(isScopeConfirmQuestion(deletionQuestion)).toBe(false);
		});
	});

	describe("interpretScopeConfirmAnswer", () => {
		it("approves only on the Approve-labelled option", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, SCOPE_APPROVE_LABEL),
			).toBe("approved");
		});

		it("matches case-insensitively and ignores surrounding whitespace", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, "  approve scope "),
			).toBe("approved");
		});

		it("returns revision for the Revise-labelled option", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, SCOPE_REVISE_LABEL),
			).toBe("revision");
		});

		it("Cancel closes the gate — a distinct verdict, never an approval", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, SCOPE_CANCEL_LABEL),
			).toBe("canceled");
		});

		it("a matched but non-canonical option never approves", () => {
			const question: AskUserQuestion = {
				question: "Proceed?",
				header: "Scope",
				options: [
					{ label: SCOPE_APPROVE_LABEL, description: "go" },
					{ label: "Approve partially", description: "partial" },
				],
				multiSelect: false,
			};
			expect(interpretScopeConfirmAnswer(question, "Approve partially")).toBe(
				"other",
			);
		});

		it("free text is never an approval — resolve by the answer, not by fallback", () => {
			expect(
				interpretScopeConfirmAnswer(
					confirmQuestion,
					"sounds good but what about X",
				),
			).toBe("other");
		});

		it("a partial approve prefix that matches no option is not an approval", () => {
			expect(interpretScopeConfirmAnswer(confirmQuestion, "Approve")).toBe(
				"other",
			);
		});
	});

	describe("interpretCanonicalScopeAnswer (restart fallback)", () => {
		it("approves on the exact canonical label only", () => {
			expect(interpretCanonicalScopeAnswer("Approve scope")).toBe("approved");
			expect(interpretCanonicalScopeAnswer("approve scope")).toBe("approved");
			expect(interpretCanonicalScopeAnswer(" Approve scope ")).toBe("approved");
		});

		it("recognises the canonical revise label", () => {
			expect(interpretCanonicalScopeAnswer("Revise scope")).toBe("revision");
		});

		it("recognises the canonical cancel label", () => {
			expect(interpretCanonicalScopeAnswer("Cancel")).toBe("canceled");
		});

		it("free text and near-misses never approve", () => {
			expect(interpretCanonicalScopeAnswer("Approve")).toBe("other");
			expect(interpretCanonicalScopeAnswer("Approved, go ahead")).toBe("other");
			expect(interpretCanonicalScopeAnswer("yes")).toBe("other");
			expect(interpretCanonicalScopeAnswer("")).toBe("other");
		});
	});
});
