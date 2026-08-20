import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	askpassPath,
	GIT_NO_AMBIENT_CREDENTIALS,
	gitAuthEnv,
	NoInstallationForRepositoryError,
	parseGitHubRepoUrl,
} from "../src/GitHubAppGitAuth.js";

describe("parseGitHubRepoUrl", () => {
	it.each([
		[
			"https://github.com/ItzHarold/frontdoor-sandbox.git",
			"ItzHarold",
			"frontdoor-sandbox",
		],
		[
			"https://github.com/ItzHarold/frontdoor-sandbox",
			"ItzHarold",
			"frontdoor-sandbox",
		],
		["http://github.com/Ponte-Digital/DVV.git", "Ponte-Digital", "DVV"],
		["git@github.com:Ponte-Digital/DVV.git", "Ponte-Digital", "DVV"],
		["git@github.com:Ponte-Digital/DVV", "Ponte-Digital", "DVV"],
		["  https://github.com/a/b.git  ", "a", "b"],
	])("parses %s", (url, owner, repo) => {
		expect(parseGitHubRepoUrl(url)).toEqual({ owner, repo });
	});

	it("returns null for non-GitHub remotes so they fall through untouched", () => {
		// A GitLab remote must not be failed loudly for a GitHub misconfiguration.
		expect(
			parseGitHubRepoUrl("https://gitlab.com/group/project.git"),
		).toBeNull();
		expect(parseGitHubRepoUrl("git@bitbucket.org:team/repo.git")).toBeNull();
		expect(parseGitHubRepoUrl("/local/path/to/repo")).toBeNull();
	});

	it("strips an embedded credential rather than treating it as the owner", () => {
		expect(
			parseGitHubRepoUrl("https://x-access-token:secret@github.com/o/r.git"),
		).toEqual({ owner: "o", repo: "r" });
	});
});

describe("gitAuthEnv", () => {
	it("supplies the token by environment, never by argument", () => {
		const env = gitAuthEnv("ghs_exampletoken");

		expect(env.CYRUS_GIT_TOKEN).toBe("ghs_exampletoken");
		expect(env.GIT_ASKPASS).toBe(askpassPath());
		// argv is world-readable via `ps`; the token must not be routed there.
		expect(GIT_NO_AMBIENT_CREDENTIALS.join(" ")).not.toContain("ghs_");
	});

	it("disables the terminal prompt so a failure is not a hang", () => {
		// The original bug presented as a wedged process sitting on
		// "Username for 'https://github.com':". Failing fast is the fix.
		expect(gitAuthEnv("t").GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("clears the ambient credential helper", () => {
		// git consults credential.helper before GIT_ASKPASS, so a host with
		// `gh auth git-credential` configured would keep using a personal
		// account and hide a broken App configuration.
		expect([...GIT_NO_AMBIENT_CREDENTIALS]).toEqual([
			"-c",
			"credential.helper=",
		]);
	});
});

describe("askpass helper", () => {
	const script = askpassPath();

	it("ships alongside the module", () => {
		expect(existsSync(script)).toBe(true);
	});

	it("answers the username prompt with the installation-token marker", async () => {
		const { execFileSync } = await import("node:child_process");
		const out = execFileSync(
			process.execPath,
			[script, "Username for 'https://github.com': "],
			{ encoding: "utf-8", env: { ...process.env, CYRUS_GIT_TOKEN: "tok" } },
		);
		expect(out.trim()).toBe("x-access-token");
	});

	it("answers the password prompt with the token from the environment", async () => {
		const { execFileSync } = await import("node:child_process");
		const out = execFileSync(
			process.execPath,
			[script, "Password for 'https://x-access-token@github.com': "],
			{ encoding: "utf-8", env: { ...process.env, CYRUS_GIT_TOKEN: "tok" } },
		);
		expect(out.trim()).toBe("tok");
	});

	it("does not embed a token in its own source", () => {
		// Guards against someone "simplifying" this into a generated script.
		expect(readFileSync(script, "utf-8")).toContain(
			"process.env.CYRUS_GIT_TOKEN",
		);
	});
});

describe("NoInstallationForRepositoryError", () => {
	it("names the repository that could not be resolved", () => {
		const err = new NoInstallationForRepositoryError("Ponte-Digital", "DVV");

		expect(err.owner).toBe("Ponte-Digital");
		expect(err.repo).toBe("DVV");
		expect(err.message).toContain("Ponte-Digital/DVV");
	});

	it("says it is refusing rather than falling back", () => {
		// The isolation guarantee: never mint against a different installation.
		const err = new NoInstallationForRepositoryError("o", "r");
		expect(err.message).toMatch(/Refusing/i);
		expect(err.message).toMatch(/another tenant/i);
	});
});

describe("mintTokenForRepo", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	// Generated per run rather than committed. A private key in the repository
	// trips secret scanning and teaches the wrong habit, even when it guards
	// nothing.
	let config: { appId: string; privateKeyPath: string };

	beforeAll(() => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const dir = mkdtempSync(join(tmpdir(), "cyrus-app-key-"));
		const path = join(dir, "test-key.pem");
		writeFileSync(path, privateKey, { mode: 0o600 });
		config = { appId: "12345", privateKeyPath: path };
	});

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses when GitHub reports no installation for the repository", async () => {
		const { mintTokenForRepo } = await import("../src/GitHubAppGitAuth.js");
		fetchSpy.mockResolvedValue(new Response("", { status: 404 }) as never);

		await expect(
			mintTokenForRepo(config, { owner: "acme", repo: "private-thing" }),
		).rejects.toBeInstanceOf(NoInstallationForRepositoryError);

		// Critically: it must NOT have gone on to mint a token anyway. Falling
		// through to a default installation is the PON-143 defect.
		const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
		expect(calls.some((u) => u.includes("access_tokens"))).toBe(false);
		expect(calls.some((u) => u.includes("/installation"))).toBe(true);
	});

	it("mints against the installation GitHub names for that repository", async () => {
		const { mintTokenForRepo } = await import("../src/GitHubAppGitAuth.js");
		fetchSpy
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 987654 }), { status: 200 }) as never,
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "ghs_minted" }), {
					status: 200,
				}) as never,
			);

		await expect(
			mintTokenForRepo(config, { owner: "acme", repo: "covered" }),
		).resolves.toBe("ghs_minted");

		// The id came from the lookup, not from configuration — this is the
		// per-repository resolution PON-143 needs.
		const mintUrl = String(fetchSpy.mock.calls[1]?.[0]);
		expect(mintUrl).toContain("/app/installations/987654/access_tokens");
	});

	it("signs a real JWT with the App key rather than sending the key", async () => {
		const { mintTokenForRepo } = await import("../src/GitHubAppGitAuth.js");
		fetchSpy.mockResolvedValue(new Response("", { status: 404 }) as never);

		await expect(
			mintTokenForRepo(config, { owner: "acme", repo: "x" }),
		).rejects.toBeInstanceOf(NoInstallationForRepositoryError);

		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const auth = String((init.headers as Record<string, string>).Authorization);
		expect(auth).toMatch(/^Bearer eyJ/); // a JWT, three base64url segments
		expect(auth.split(".")).toHaveLength(3);
		expect(auth).not.toContain("PRIVATE KEY");
	});

	it("surfaces a non-404 lookup failure instead of treating it as 'no installation'", async () => {
		const { mintTokenForRepo } = await import("../src/GitHubAppGitAuth.js");
		fetchSpy.mockResolvedValue(
			new Response("bad credentials", { status: 401 }) as never,
		);

		// A 401 means our own auth is broken. Reporting it as "no installation"
		// would send someone to install an app that is already installed.
		const err = await mintTokenForRepo(config, {
			owner: "acme",
			repo: "x",
		}).catch((e) => e);
		expect(err).not.toBeInstanceOf(NoInstallationForRepositoryError);
		expect(String(err.message)).toContain("401");
	});
});
