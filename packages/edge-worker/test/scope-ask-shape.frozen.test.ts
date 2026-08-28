import { describe, expect, it } from "vitest";
import {
	findClientContentViolations,
	sanitizeClientPaths,
} from "../src/client-content-policy.js";
import {
	buildScopeAskBody,
	buildScopeConfirmGateBlock,
	SCOPE_APPROVE_LABEL,
	SCOPE_CANCEL_LABEL,
	SCOPE_REVISE_LABEL,
} from "../src/scope-confirm-gate.js";

/**
 * FROZEN: the shape of the client's scope-confirmation ask.
 *
 * Approved by Harold on 2026-08-28 against the live ACM-13 ask, after three
 * iterations that each failed on a client thread: narration (suppressed —
 * the client was asked to approve nothing, PON-188), a comment (readable but
 * a trail on the client's own thread, PON-192), and finally the elicitation
 * itself (PON-196).
 *
 * These cases exist to make a regression loud rather than to describe the
 * implementation. If a change here is deliberate, the ruling that froze the
 * shape has to be revisited first — the failures this guards against were
 * found by a human reading his own client thread, not by a test.
 */

const CLIENT_SCOPE = `**Outcome**

The dashboard works on a phone. You open it from the road and land on the
numbers, not on a menu covering the screen.

**You will receive**

A pull request against \`main\`, with the change visible on its preview deploy.`;

describe("FROZEN: the client's scope ask (PON-196)", () => {
	const body = buildScopeAskBody(CLIENT_SCOPE, {
		identifier: "ACM-13",
		title: "Dashboard is broken on mobile",
	});

	it("opens by naming the issue, not by pointing elsewhere", () => {
		expect(body.startsWith("This is the scope for ACM-13 —")).toBe(true);
		// No "see above", no "I've posted", nothing that depends on a surface
		// the client may not be looking at.
		expect(body).not.toMatch(/\babove\b/i);
		expect(body).not.toMatch(/\bcomment\b/i);
		expect(body).not.toMatch(/I've posted/i);
	});

	it("carries the whole scope inline, in client language", () => {
		expect(body).toContain("**Outcome**");
		expect(body).toContain("**You will receive**");
		expect(body).toContain("The dashboard works on a phone");
	});

	it("ends with the question, so the options read as answers to it", () => {
		expect(body.trimEnd().endsWith("Proceed?")).toBe(true);
		expect(body.indexOf("**Outcome**")).toBeLessThan(body.indexOf("Proceed?"));
	});

	it("keeps operator material out — assumptions are not the client's problem", () => {
		const withInterpreted = buildScopeAskBody(
			`${CLIENT_SCOPE}\n\n**Interpreted**\n\nI assumed the tables should scroll.`,
			{ identifier: "ACM-13" },
		);
		expect(withInterpreted).not.toContain("Interpreted");
		expect(withInterpreted).not.toContain("I assumed");
	});

	it("carries no internals — no paths, no product names, no routing", () => {
		const dirty = buildScopeAskBody(
			"**Outcome** — see /root/.cyrus-community/worktrees/ws/ACM-13/README.md",
			{ identifier: "ACM-13" },
		);
		const sanitized = sanitizeClientPaths(dirty, {
			stripPrefixes: ["/root/.cyrus-community/worktrees/ws/ACM-13"],
		}).text;
		expect(sanitized).not.toContain("/root/");
		expect(findClientContentViolations(sanitized)).toEqual([]);
		// Routing vocabulary has no place in an ask (PON-189).
		expect(dirty).not.toMatch(/\bRouting\b|\bTeam routing\b|→ `main`/);
	});

	it("offers exactly three canonical options, in order", () => {
		expect([
			SCOPE_APPROVE_LABEL,
			SCOPE_REVISE_LABEL,
			SCOPE_CANCEL_LABEL,
		]).toEqual(["Approve scope", "Revise scope", "Cancel"]);
	});

	it("still instructs options that state their own consequence", () => {
		const block = buildScopeConfirmGateBlock();
		expect(block).toContain("must stand on their own");
		expect(block).toContain("what happens if it is chosen");
		// And still forbids the session posting the scope anywhere itself.
		expect(block).toContain("Never post this text yourself");
	});

	it("degrades honestly when the issue is unknown", () => {
		expect(buildScopeAskBody(CLIENT_SCOPE)).toContain(
			"This is the scope for this issue.",
		);
	});
});
