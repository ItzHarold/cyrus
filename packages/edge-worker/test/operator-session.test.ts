import { describe, expect, it } from "vitest";
import { classifyMirrorIntent } from "../src/operator-session.js";

/**
 * Asking the client in plain language (PON-221).
 *
 * Harold wants to ask mid-review without remembering a keyword. The asymmetry
 * is what shapes the pattern: failing to recognise an ask costs a re-phrase,
 * while misreading an internal instruction as one puts operator words in
 * front of a client.
 */
describe("classifyMirrorIntent — asking the client", () => {
	// The question is forwarded VERBATIM, so it must already be written the
	// way it should arrive: after a separator, or ending in a question mark.
	const asks = [
		"ask client: which date format do they want?",
		"ask the client, which column order do you want?",
		"can you ask the client: could you send us the logo files?",
		"Could you ask the client if Tuesday works?",
		"check with the client: is the current pricing final?",
		"please ask the client — sorry, ask client: what should the totals round to?",
	];
	for (const body of asks) {
		it(`treats "${body.slice(0, 42)}…" as an ask`, () => {
			const intent = classifyMirrorIntent(body);
			expect(intent.kind).toBe("ask-client");
			expect((intent as { question: string }).question.length).toBeGreaterThan(
				0,
			);
		});
	}

	const notAsks = [
		"ask them to double-check the totals",
		"ask yourself whether this is the simplest fix",
		"check with the maintainers before changing the schema",
		"I asked the client already, just carry on",
		"the client asked for CSV, not Excel",
		// The compound noun. The first pattern accepted `-` as a separator
		// after "client", so this matched and would have sent the client the
		// words "facing team to review the copy".
		"ask the client-facing team to review the copy",
		"ask the clients why they left",
		// No question to send. Falling through to `iterate` keeps it on the
		// operator's thread, where a reply can say what was missing.
		"ask client",
		"confirm with the client",
	];
	for (const body of notAsks) {
		it(`does NOT send "${body.slice(0, 42)}…" to the client`, () => {
			// Anything not recognised falls through to `iterate`, which stays
			// on the operator's own thread. That is the safe direction.
			expect(classifyMirrorIntent(body).kind).not.toBe("ask-client");
		});
	}
});

/**
 * A plain-language ask that is NOT a usable question (PON-221, adversarial
 * review).
 *
 * The reviewer speaks about the client in the third person while the message
 * is addressed to them, so forwarding his phrasing verbatim sends a fragment
 * in the wrong person. These are recognised as asks — so he gets the syntax
 * back rather than a model turn — but nothing reaches the client.
 */
describe("classifyMirrorIntent — an ask that isn't a question yet", () => {
	const unclear = [
		["can you ask the client for the logo files", "for the logo files"],
		["check with the client on the column order", "on the column order"],
		[
			"ask the client whether they want the totals rounded",
			"whether they want the totals rounded",
		],
		[
			"please ask the client for a decision on pricing",
			"for a decision on pricing",
		],
		["ask client", ""],
		["confirm with the client", ""],
	] as const;

	for (const [body, draft] of unclear) {
		it(`does not forward "${body.slice(0, 40)}…"`, () => {
			const intent = classifyMirrorIntent(body);
			expect(intent.kind).toBe("ask-client-unclear");
			expect((intent as { draft: string }).draft).toBe(draft);
		});
	}

	it("still forwards a question the reviewer actually wrote", () => {
		const intent = classifyMirrorIntent(
			"ask the client for the logo files — sorry: could you send us the logo files?",
		);
		expect(intent.kind).toBe("ask-client");
	});
});
