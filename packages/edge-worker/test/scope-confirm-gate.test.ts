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
			// PON-196: the client-facing scope IS the recorded client_scope,
			// and it travels inside the ask. The ordering this guards — note
			// first, client text second — is unchanged.
			const clientStep = block.indexOf("Write client_scope");
			expect(noteStep).toBeGreaterThan(-1);
			expect(clientStep).toBeGreaterThan(-1);
			expect(noteStep).toBeLessThan(clientStep);
		});

		it("tells the session NOT to post the scope itself — the ask carries it", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("Never post this text yourself");
			expect(block).toContain("there is no comment");
		});

		it("requires the options to stand alone, not lean on surrounding text", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("must stand on their own");
			expect(block).toContain("no surrounding text");
		});

		it("frames the client text as the deliverable and bans implementation detail", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("**Outcome**");
			expect(block).toContain("**You will receive**");
			expect(block).toContain("No implementation detail");
			expect(block).toContain("no file names");
		});

		it("routes interpretations to the operator note, NOT the client text (PON-196)", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("exactly two sections");
			expect(block).toContain(
				"no interpretations or assumptions section; those go in the operator note",
			);
		});

		it("a revision re-records the operator note too, not just the client text", () => {
			const block = buildScopeConfirmGateBlock();
			expect(block).toContain("re-record the operator note");
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
				interpretScopeConfirmAnswer(confirmQuestion, SCOPE_APPROVE_LABEL)
					.verdict,
			).toBe("approved");
		});

		it("matches case-insensitively and ignores surrounding whitespace", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, "  approve scope ")
					.verdict,
			).toBe("approved");
		});

		it("returns revision for the Revise-labelled option", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, SCOPE_REVISE_LABEL)
					.verdict,
			).toBe("revision");
		});

		it("Cancel closes the gate — a distinct verdict, never an approval", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, SCOPE_CANCEL_LABEL)
					.verdict,
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
			expect(
				interpretScopeConfirmAnswer(question, "Approve partially").verdict,
			).toBe("other");
		});

		it("free text is never an approval — resolve by the answer, not by fallback", () => {
			expect(
				interpretScopeConfirmAnswer(
					confirmQuestion,
					"sounds good but what about X",
				).verdict,
			).toBe("other");
		});

		it("the label plus the client's own words still counts, and keeps them (PON-230)", () => {
			// Linear sends the option and what they typed as one body. Read as
			// a whole string it matched no label — so a revision went
			// uncounted and, on approve, an approval never happened at all:
			// no SLA clock, no mirror, no queue, and a client waiting on
			// silence after doing exactly what they were asked.
			const approved = interpretScopeConfirmAnswer(
				confirmQuestion,
				"Approve scope\n\nand keep it simple",
			);
			expect(approved.verdict).toBe("approved");
			expect(approved.note).toBe("and keep it simple");

			const revised = interpretScopeConfirmAnswer(
				confirmQuestion,
				"Revise scope\n\nlead with the numbers that matter",
			);
			expect(revised.verdict).toBe("revision");
			expect(revised.note).toBe("lead with the numbers that matter");
		});

		it("the label must stand ALONE on the first line", () => {
			// Otherwise "Approve scope?" or "Approve scope, but first…" would
			// approve, and neither is a choice.
			expect(
				interpretScopeConfirmAnswer(
					confirmQuestion,
					"Approve scope — and keep it simple",
				).verdict,
			).toBe("other");
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, "Approve scope?").verdict,
			).toBe("other");
		});

		it("free text alone still never approves, however it begins", () => {
			expect(
				interpretScopeConfirmAnswer(
					confirmQuestion,
					"Approving this\n\nlooks right to me",
				).verdict,
			).toBe("other");
		});

		it("a note cannot smuggle in a verdict from a DIFFERENT elicitation", () => {
			// The adversarial case: an unrelated question offering a
			// similar-looking option must not stamp the SLA clock. Resolution
			// is against the options actually posted (PON-142).
			const deletion: AskUserQuestion = {
				question: "Delete the old export?",
				header: "Cleanup",
				options: [
					{ label: "Approve deletion", description: "delete" },
					{ label: "Keep it", description: "keep" },
				],
				multiSelect: false,
			};
			expect(
				interpretScopeConfirmAnswer(
					deletion,
					"Approve deletion\n\nyes remove it",
				).verdict,
			).toBe("other");
			// And that question is not even recognised as the gate.
			expect(isScopeConfirmQuestion(deletion)).toBe(false);
		});

		it("a partial approve prefix that matches no option is not an approval", () => {
			expect(
				interpretScopeConfirmAnswer(confirmQuestion, "Approve").verdict,
			).toBe("other");
		});
	});

	describe("interpretCanonicalScopeAnswer (restart fallback)", () => {
		it("approves on the exact canonical label only", () => {
			expect(interpretCanonicalScopeAnswer("Approve scope").verdict).toBe(
				"approved",
			);
			expect(interpretCanonicalScopeAnswer("approve scope").verdict).toBe(
				"approved",
			);
			expect(interpretCanonicalScopeAnswer(" Approve scope ").verdict).toBe(
				"approved",
			);
		});

		it("recognises the canonical revise label", () => {
			expect(interpretCanonicalScopeAnswer("Revise scope").verdict).toBe(
				"revision",
			);
		});

		it("recognises the canonical cancel label", () => {
			expect(interpretCanonicalScopeAnswer("Cancel").verdict).toBe("canceled");
		});

		it("free text and near-misses never approve", () => {
			expect(interpretCanonicalScopeAnswer("Approve").verdict).toBe("other");
			expect(interpretCanonicalScopeAnswer("Approved, go ahead").verdict).toBe(
				"other",
			);
			expect(interpretCanonicalScopeAnswer("yes").verdict).toBe("other");
			expect(interpretCanonicalScopeAnswer("").verdict).toBe("other");
		});
	});
});
