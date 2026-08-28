import { describe, expect, it } from "vitest";
import {
	remoteUrlHasEmbeddedCredential,
	stripEmbeddedCredential,
} from "../src/GitHubAppGitAuth.js";

/**
 * PON-203: a session with no credential of its own improvised one, pushing
 * with `https://x-access-token:<token>@github.com/...`. That shape is the only
 * one that can persist a live token into `.git/config`, where it outlives the
 * process and lands in backups.
 *
 * On the boxes it turned out the token was passed as a one-shot argument and
 * never written to config — but the improvisation happened because sessions
 * had no credentials, and the guard exists so the shape cannot survive even if
 * something does write it.
 */

describe("credentials embedded in a remote URL (PON-203)", () => {
	it("catches the exact shape a session improvises", () => {
		const url =
			"https://x-access-token:ghs_AbCdEf0123456789@github.com/ItzHarold/frontdoor-sandbox.git";
		expect(remoteUrlHasEmbeddedCredential(url)).toBe(true);
		expect(stripEmbeddedCredential(url)).toBe(
			"https://github.com/ItzHarold/frontdoor-sandbox.git",
		);
	});

	it("catches a personal token too, and any http(s) userinfo pair", () => {
		expect(
			remoteUrlHasEmbeddedCredential(
				"https://user:ghp_secret@github.com/o/r.git",
			),
		).toBe(true);
		expect(
			remoteUrlHasEmbeddedCredential("http://a:b@internal.example/o/r.git"),
		).toBe(true);
	});

	it("leaves a clean URL exactly as it is", () => {
		const clean = "https://github.com/Ponte-Digital/Acme-Metrics.git";
		expect(remoteUrlHasEmbeddedCredential(clean)).toBe(false);
		// Identity, so a caller can tell that nothing happened.
		expect(stripEmbeddedCredential(clean)).toBe(clean);
	});

	it("does not mistake an SSH remote for a credential", () => {
		// `git@github.com:owner/repo` — the user is a literal, not a secret.
		const ssh = "git@github.com:Ponte-Digital/Acme-Metrics.git";
		expect(remoteUrlHasEmbeddedCredential(ssh)).toBe(false);
		expect(stripEmbeddedCredential(ssh)).toBe(ssh);
	});

	it("does not flag a bare username with no password", () => {
		// No colon: a username hint carries no secret, and rewriting it would
		// change a working remote for no reason.
		expect(
			remoteUrlHasEmbeddedCredential("https://octocat@github.com/o/r.git"),
		).toBe(false);
	});

	it("is not fooled by a token-looking string elsewhere in the URL", () => {
		expect(
			remoteUrlHasEmbeddedCredential(
				"https://github.com/o/r.git?ref=ghs_notacredential",
			),
		).toBe(false);
	});
});
