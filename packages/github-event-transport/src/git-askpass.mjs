#!/usr/bin/env node
/**
 * GIT_ASKPASS helper for GitHub App installation tokens.
 *
 * Git invokes this with the prompt it would otherwise show a human, e.g.
 *   "Username for 'https://github.com': "
 *   "Password for 'https://x-access-token@github.com': "
 *
 * We answer from the environment. The token therefore never appears in:
 *   - .git/config or the saved remote URL (it is not written anywhere)
 *   - the process command line (argv is visible in `ps` to any local user)
 *   - the terminal (git never prompts, so it is never echoed or logged)
 *
 * It lives only in the environment of one short-lived git process and dies
 * with it, which is what "one-shot" means here.
 */
const prompt = process.argv[2] ?? "";

if (/username/i.test(prompt)) {
	// GitHub's convention for installation tokens: the username is a literal
	// marker and the token is the password.
	process.stdout.write("x-access-token\n");
} else {
	process.stdout.write(`${process.env.CYRUS_GIT_TOKEN ?? ""}\n`);
}
