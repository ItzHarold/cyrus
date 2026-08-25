import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { mintTokenForRepo } from "../src/GitHubAppGitAuth.js";
import { GitHubAppTokenProvider } from "../src/GitHubAppTokenProvider.js";
import { GitHubInstallationResolver } from "../src/GitHubInstallationResolver.js";
import {
	journalAmbientTokenFallback,
	journalTokenCacheHit,
	journalTokenMinted,
} from "../src/github-token-journal.js";

// The module-level logger reads its level once, at import time, so the level
// has to be set before the imports above are evaluated — hence `vi.hoisted`.
// DEBUG so the cache-hit line (deliberately below INFO) is observable here.
const previousLogLevel = vi.hoisted(() => {
	const previous = process.env.CYRUS_LOG_LEVEL;
	process.env.CYRUS_LOG_LEVEL = "DEBUG";
	return previous;
});

afterAll(() => {
	if (previousLogLevel === undefined) delete process.env.CYRUS_LOG_LEVEL;
	else process.env.CYRUS_LOG_LEVEL = previousLogLevel;
});

/** Everything the process wrote to the console during one test. */
function captureConsole() {
	const lines: string[] = [];
	const record =
		() =>
		(...args: unknown[]) => {
			lines.push(args.map((a) => String(a)).join(" "));
		};
	vi.spyOn(console, "log").mockImplementation(record());
	vi.spyOn(console, "warn").mockImplementation(record());
	vi.spyOn(console, "error").mockImplementation(record());
	return lines;
}

/** A logger that records calls instead of writing, for the injected-sink path. */
function fakeLogger(): ILogger & {
	events: Array<{ name: string; attributes?: Record<string, unknown> }>;
	debugs: string[];
} {
	const events: Array<{ name: string; attributes?: Record<string, unknown> }> =
		[];
	const debugs: string[] = [];
	return {
		events,
		debugs,
		debug: (message: string) => {
			debugs.push(message);
		},
		info: () => {},
		warn: () => {},
		error: () => {},
		event: (name: string, attributes?: Record<string, unknown>) => {
			events.push({ name, attributes });
		},
		withContext() {
			return this as unknown as ILogger;
		},
		getLevel: () => 0,
		setLevel: () => {},
	} as never;
}

describe("GitHub credential journal (PON-176)", () => {
	let config: { appId: string; privateKeyPath: string };
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(() => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const dir = mkdtempSync(join(tmpdir(), "cyrus-journal-key-"));
		const path = join(dir, "key.pem");
		writeFileSync(path, privateKey, { mode: 0o600 });
		config = { appId: "12345", privateKeyPath: path };
	});

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const lookupOk = (id: number) =>
		new Response(JSON.stringify({ id }), { status: 200 }) as never;
	const mintOk = (token: string) =>
		new Response(JSON.stringify({ token }), { status: 200 }) as never;

	describe("every repository-scoped mint announces itself", () => {
		it("names owner, repo, installation and purpose on the CLI clone path", async () => {
			// PON-162's lesson in one assertion: the path `self-add-repo` uses must
			// be as observable as the session-time one.
			fetchSpy
				.mockResolvedValueOnce(lookupOk(987654))
				.mockResolvedValueOnce(mintOk("ghs_clone"));
			const lines = captureConsole();

			await mintTokenForRepo(
				config,
				{ owner: "acme", repo: "widget" },
				"clone",
			);

			const event = lines.find((l) =>
				l.includes("[event:github_token_minted]"),
			);
			expect(event).toBeDefined();
			expect(
				JSON.parse(String(event).split("[event:github_token_minted] ")[1]),
			).toEqual({
				owner: "acme",
				repo: "widget",
				installationId: "987654",
				purpose: "clone",
			});
		});

		it("emits the identical line from the session-time resolver path", async () => {
			// Both GitService instances reach GitHub through this resolver, so one
			// shared emitting path is what stops the two drifting apart.
			fetchSpy
				.mockResolvedValueOnce(lookupOk(4242))
				.mockResolvedValueOnce(mintOk("ghs_fetch"));
			const lines = captureConsole();

			const resolver = new GitHubInstallationResolver(config);
			await resolver.mintTokenForRef(
				{ owner: "acme", repo: "widget" },
				"fetch",
			);

			const event = lines.find((l) =>
				l.includes("[event:github_token_minted]"),
			);
			expect(
				JSON.parse(String(event).split("[event:github_token_minted] ")[1]),
			).toEqual({
				owner: "acme",
				repo: "widget",
				installationId: "4242",
				purpose: "fetch",
			});
		});

		it("still journals when the installation id came from cache", async () => {
			// The resolver caches the installation *id*, not the token. Every call
			// mints, so every call must produce a line — otherwise a second fetch
			// would look uncredentialed.
			fetchSpy
				.mockResolvedValueOnce(lookupOk(4242))
				.mockResolvedValueOnce(mintOk("ghs_one"))
				.mockResolvedValueOnce(mintOk("ghs_two"));
			const lines = captureConsole();

			const resolver = new GitHubInstallationResolver(config, {
				ttlMs: 60_000,
			});
			await resolver.mintTokenForRef({ owner: "o", repo: "r" }, "fetch");
			await resolver.mintTokenForRef({ owner: "o", repo: "r" }, "push");

			const events = lines.filter((l) =>
				l.includes("[event:github_token_minted]"),
			);
			expect(events).toHaveLength(2);
			expect(events[1]).toContain('"purpose":"push"');
		});

		it("says nothing when no installation covers the repository", async () => {
			// A refusal must not leave a line claiming a credential was issued.
			fetchSpy.mockResolvedValue(new Response("", { status: 404 }) as never);
			const lines = captureConsole();

			await mintTokenForRepo(
				config,
				{ owner: "acme", repo: "x" },
				"fetch",
			).catch(() => undefined);

			expect(
				lines.filter((l) => l.includes("[event:github_token_minted]")),
			).toHaveLength(0);
		});
	});

	describe("the token value is never written", () => {
		it("keeps the minted token out of every console line", async () => {
			const secret = "ghs_this_must_never_be_logged_9f3a";
			fetchSpy
				.mockResolvedValueOnce(lookupOk(4242))
				.mockResolvedValueOnce(mintOk(secret));
			const lines = captureConsole();

			const resolver = new GitHubInstallationResolver(config);
			expect(
				await resolver.mintTokenForRef({ owner: "o", repo: "r" }, "fetch"),
			).toBe(secret);

			expect(lines.some((l) => l.includes(secret))).toBe(false);
			// And the line that *is* written is the one we expect, so this is not
			// passing merely because nothing was logged at all.
			expect(lines.some((l) => l.includes("[event:github_token_minted]"))).toBe(
				true,
			);
		});

		it("keeps the cached token out of the cache-hit line", async () => {
			const secret = "ghs_cached_must_never_be_logged_71bd";
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						token: secret,
						expires_at: new Date(Date.now() + 3600_000).toISOString(),
					}),
					{ status: 200 },
				) as never,
			);
			const lines = captureConsole();

			const provider = new GitHubAppTokenProvider({
				appId: "12345",
				installationId: "67890",
				privateKeyPath: config.privateKeyPath,
			});
			await provider.getToken();
			await provider.getToken();

			expect(lines.some((l) => l.includes(secret))).toBe(false);
		});
	});

	describe("a cache hit is not a mint", () => {
		it("journals the cached-token path under its own name", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						token: "ghs_provider",
						expires_at: new Date(Date.now() + 3600_000).toISOString(),
					}),
					{ status: 200 },
				) as never,
			);
			const lines = captureConsole();

			const provider = new GitHubAppTokenProvider({
				appId: "12345",
				installationId: "67890",
				privateKeyPath: config.privateKeyPath,
			});
			await provider.getToken();
			await provider.getToken();
			await provider.getToken();

			// One real mint, two hits — a journal that showed three mints would
			// misreport how often we actually talked to GitHub.
			expect(
				lines.filter((l) => l.includes("[event:github_token_minted]")),
			).toHaveLength(1);
			expect(
				lines.filter((l) => l.includes("[event:github_token_cache_hit]")),
			).toHaveLength(2);
		});

		it("keeps the cache-hit line below INFO", () => {
			const logger = fakeLogger();
			journalTokenCacheHit("4242", { operation: "github-api" }, logger);

			// Debug, not event: a cache hit is the absence of a decision, and at
			// info level it would bury the mints it derives from.
			expect(logger.events).toHaveLength(0);
			expect(logger.debugs[0]).toContain("[event:github_token_cache_hit]");
		});
	});

	describe("the fallback is named distinctly", () => {
		it("does not share a name with the mint", () => {
			const logger = fakeLogger();
			journalTokenMinted("4242", { ref: { owner: "o", repo: "r" } }, logger);
			journalAmbientTokenFallback(
				"no-app-configured",
				{ ref: { owner: "o", repo: "r" } },
				logger,
			);

			// The whole point: App-minted vs ambient is one grep, not a reading
			// exercise over a shared message.
			expect(logger.events.map((e) => e.name)).toEqual([
				"github_token_minted",
				"github_token_ambient_fallback",
			]);
		});

		it("carries the reason and the repository, and no credential", () => {
			const logger = fakeLogger();
			journalAmbientTokenFallback(
				"unverified-payload",
				{ ref: { owner: "acme", repo: "widget" }, operation: "github-api" },
				logger,
			);

			expect(logger.events[0]?.attributes).toEqual({
				owner: "acme",
				repo: "widget",
				reason: "unverified-payload",
				purpose: "github-api",
			});
		});
	});

	describe("attributes when the repository is unknown", () => {
		it("omits owner/repo rather than inventing them", () => {
			const logger = fakeLogger();
			journalTokenMinted("67890", { operation: "github-api" }, logger);

			const attributes = logger.events[0]?.attributes ?? {};
			expect(attributes.installationId).toBe("67890");
			expect(attributes.owner).toBeUndefined();
			expect(attributes.repo).toBeUndefined();
		});

		it("labels an unstated purpose rather than leaving it blank", () => {
			const logger = fakeLogger();
			journalTokenMinted("67890", {}, logger);

			expect(logger.events[0]?.attributes?.purpose).toBe("unspecified");
		});
	});
});
