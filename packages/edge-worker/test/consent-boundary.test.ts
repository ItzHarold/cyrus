import { describe, expect, it } from "vitest";
import {
	CONSENT_DESCRIPTION_NOTE,
	CONSENT_MARKER,
	labelPlanAsProposal,
	looksLikePlan,
} from "../src/consent-boundary.js";

/**
 * The consent boundary (PON-216).
 *
 * Harold approved ACM-19's scope and found the cockpit already showing work.
 * Nothing had run — the journal and Git put every write minutes AFTER the
 * approval — but the scope session's plan was on the mirror, timestamped
 * before it, and one of its items was "Verify and open the pull request".
 *
 * The call was to keep that narration and make the boundary legible instead.
 * These tests are about the legibility, since that IS the fix.
 */

describe("recognising a plan", () => {
	it("recognises the checklist shape that caused this", () => {
		expect(
			looksLikePlan(
				[
					"⏳ **Verify and open the pull request**",
					"🔄 **Make the Customers table columns count the same orders**",
					"✅ **Read the repository**",
				].join("\n"),
			),
		).toBe(true);
	});

	it("recognises the other runner's shape, which has no bold", () => {
		// TodoWrite emits `⏳ item`; the Task tools emit `⏳ **subject**`. Both
		// reach the mirror, so matching only one leaves the gap open.
		expect(looksLikePlan("⏳ Verify and open the pull request")).toBe(true);
	});

	it("does not label ordinary narration", () => {
		// The cost is asymmetric: a label on prose is noise, and noise is what
		// teaches a reviewer to stop reading labels.
		expect(looksLikePlan("Reading the orders table to see how it joins.")).toBe(
			false,
		);
		expect(looksLikePlan("")).toBe(false);
	});

	it("does not label prose that merely mentions a checklist item", () => {
		// One emoji line inside a paragraph is a report, not a plan.
		expect(
			looksLikePlan(
				"I finished the first step:\n✅ Read the repository\nNow opening the PR.",
			),
		).toBe(false);
	});
});

describe("labelling a plan before consent", () => {
	const PLAN = "⏳ **Verify and open the pull request**";

	it("says the thing a reviewer misread, in words", () => {
		const labeled = labelPlanAsProposal(PLAN);
		expect(labeled).toContain("not yet approved");
		expect(labeled).toContain("nothing here has been done");
		// And it keeps the plan itself — the reading is the useful part.
		expect(labeled).toContain(PLAN);
	});

	it("leaves anything that is not a plan exactly as it was", () => {
		const prose = "Reading the orders table.";
		expect(labelPlanAsProposal(prose)).toBe(prose);
	});
});

describe("the marker itself", () => {
	it("names both halves of the thread", () => {
		// The reviewer's question is "what ran before consent and what ran
		// after". The marker has to answer it without them scrolling further.
		expect(CONSENT_MARKER).toContain("Above this line");
		expect(CONSENT_MARKER).toContain("Below this line");
		expect(CONSENT_MARKER).toContain("APPROVED THE SCOPE HERE");
	});

	it("says the plan is a proposal, since that is the thing misread", () => {
		expect(CONSENT_MARKER).toContain("proposal");
	});

	it("is heavy enough to hit while scrolling", () => {
		// Deliberate: a single-line thought is exactly what got scrolled past.
		expect(CONSENT_MARKER.split("\n").length).toBeGreaterThan(5);
		expect(CONSENT_MARKER).toContain("##");
	});

	it("repeats the fact in the description, where a reviewer looks first", () => {
		expect(CONSENT_DESCRIPTION_NOTE).toContain("before that");
		expect(CONSENT_DESCRIPTION_NOTE).toContain("proposal");
	});
});
