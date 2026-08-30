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
	const asks = [
		"ask client: which date format do they want?",
		"ask the client whether they want the totals rounded",
		"can you ask the client for the logo files",
		"Could you ask the client if Tuesday works?",
		"check with the client on the column order",
		"please ask the client for a decision on pricing",
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
