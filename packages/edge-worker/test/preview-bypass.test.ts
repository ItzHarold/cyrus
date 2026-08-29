import { describe, expect, it } from "vitest";
import {
	findClientContentViolations,
	redactClientContent,
} from "../src/client-content-policy.js";
import {
	containsBypassToken,
	withPreviewBypass,
} from "../src/preview-deployment.js";

/**
 * The preview bypass token (PON-213).
 *
 * Previews are protected by default on paid Vercel teams, so the link we send
 * a client shows them a login page for an account they do not have. The client
 * generates this secret on their own project; appending it opens our link
 * while leaving the preview protected against anyone without it.
 *
 * The token is a client secret in a query string, which is the one shape the
 * content policy was built to ignore — so half of these tests are about it not
 * escaping through that hole.
 */

const URL = "https://acme-metrics-abc123-ponte-digital.vercel.app";
const TOKEN = "s3cr3tbypassvalue";

describe("preview bypass — applying it", () => {
	it("opens the link for someone with no account", () => {
		const out = withPreviewBypass(URL, TOKEN);
		expect(out).toContain(`x-vercel-protection-bypass=${TOKEN}`);
		// The cookie parameter is what makes the SECOND click work too —
		// without it the bypass applies to one request and the reviewer is
		// bounced to a login page as soon as they navigate.
		expect(out).toContain("x-vercel-set-bypass-cookie=true");
	});

	it("changes nothing for a tenant that has not supplied one", () => {
		// An unconfigured client must degrade to today's behaviour, not to a
		// broken link.
		expect(withPreviewBypass(URL, undefined)).toBe(URL);
		expect(withPreviewBypass(URL, "")).toBe(URL);
	});

	it("refuses to concatenate a secret onto something that is not a URL", () => {
		expect(withPreviewBypass("not a url", TOKEN)).toBe("not a url");
	});

	it("does not double-append when applied twice", () => {
		const once = withPreviewBypass(URL, TOKEN);
		const twice = withPreviewBypass(once, TOKEN);
		expect(twice).toBe(once);
	});
});

describe("preview bypass — it cannot escape through the URL exemption", () => {
	it("is seen by the scanner even though URLs are blanked", () => {
		// The exemption is right about branch-shaped hosts and wrong about
		// query strings: blanking URLs wholesale made the single place this
		// secret ever appears the single place nobody looked.
		const text = `See it working: ${withPreviewBypass(URL, TOKEN)}`;
		const violations = findClientContentViolations(text);
		expect(violations.some((v) => v.rule === "preview-bypass-token")).toBe(
			true,
		);
	});

	it("still blanks an ordinary preview URL, so branch-shaped hosts stay exempt", () => {
		// The original reason for the exemption must survive: a Vercel host
		// embeds the branch name, and rewriting it hands the client a broken
		// link.
		expect(findClientContentViolations(`See it working: ${URL}`)).toHaveLength(
			0,
		);
	});

	it("redacts the value and leaves the link shape intact", () => {
		const { text } = redactClientContent(
			`Preview: ${withPreviewBypass(URL, TOKEN)}`,
		);
		expect(text).not.toContain(TOKEN);
		expect(text).toContain("acme-metrics-abc123");
	});

	it("recognises a token by parameter name, whatever the value looks like", () => {
		// Opaque client values defeat any value-shaped regex, so detection has
		// to key on the parameter.
		expect(containsBypassToken(withPreviewBypass(URL, "zzzz"))).toBe(true);
		expect(containsBypassToken(URL)).toBe(false);
	});
});
