import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { NoInstallationForRepositoryError } from "../src/GitHubAppGitAuth.js";
import { GitHubInstallationResolver } from "../src/GitHubInstallationResolver.js";

describe("GitHubInstallationResolver", () => {
	let config: { appId: string; privateKeyPath: string };
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(() => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const dir = mkdtempSync(join(tmpdir(), "cyrus-resolver-key-"));
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
	const lookup404 = () => new Response("", { status: 404 }) as never;

	describe("per-repository resolution", () => {
		it("resolves each repository to its own installation", async () => {
			const r = new GitHubInstallationResolver(config);
			fetchSpy
				.mockResolvedValueOnce(lookupOk(111))
				.mockResolvedValueOnce(lookupOk(222));

			expect(
				await r.resolveInstallationId({ owner: "clientA", repo: "site" }),
			).toBe("111");
			expect(
				await r.resolveInstallationId({ owner: "clientB", repo: "app" }),
			).toBe("222");
		});

		it("never serves one repository's installation for another", async () => {
			// The PON-143 bug in one assertion: client B must not inherit A's id.
			const r = new GitHubInstallationResolver(config);
			fetchSpy.mockResolvedValueOnce(lookupOk(111));
			await r.resolveInstallationId({ owner: "clientA", repo: "site" });

			fetchSpy.mockResolvedValueOnce(lookup404());
			await expect(
				r.resolveInstallationId({ owner: "clientB", repo: "app" }),
			).rejects.toBeInstanceOf(NoInstallationForRepositoryError);
		});

		it("treats owner/repo case-insensitively, as GitHub does", async () => {
			// Two spellings of one repository must not become two tenants.
			const r = new GitHubInstallationResolver(config);
			fetchSpy.mockResolvedValueOnce(lookupOk(999));

			await r.resolveInstallationId({ owner: "ItzHarold", repo: "Cyrus" });
			await r.resolveInstallationId({ owner: "itzharold", repo: "cyrus" });

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(r.size).toBe(1);
		});
	});

	describe("cache", () => {
		it("does not re-ask GitHub within the TTL", async () => {
			const r = new GitHubInstallationResolver(config, { ttlMs: 60_000 });
			fetchSpy.mockResolvedValueOnce(lookupOk(111));

			await r.resolveInstallationId({ owner: "o", repo: "r" });
			await r.resolveInstallationId({ owner: "o", repo: "r" });
			await r.resolveInstallationId({ owner: "o", repo: "r" });

			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it("re-asks after the TTL, so a revocation takes effect without a restart", async () => {
			// The client-facing guarantee: uninstalling the app stops us working.
			// A cache that never expired would keep minting against an installation
			// the client believes they revoked.
			vi.useFakeTimers();
			try {
				const r = new GitHubInstallationResolver(config, { ttlMs: 1000 });
				fetchSpy.mockResolvedValueOnce(lookupOk(111));
				expect(await r.resolveInstallationId({ owner: "o", repo: "r" })).toBe(
					"111",
				);

				vi.advanceTimersByTime(1500);

				fetchSpy.mockResolvedValueOnce(lookup404());
				await expect(
					r.resolveInstallationId({ owner: "o", repo: "r" }),
				).rejects.toBeInstanceOf(NoInstallationForRepositoryError);
			} finally {
				vi.useRealTimers();
			}
		});

		it("drops the stale entry when the installation disappears", async () => {
			vi.useFakeTimers();
			try {
				const r = new GitHubInstallationResolver(config, { ttlMs: 1000 });
				fetchSpy.mockResolvedValueOnce(lookupOk(111));
				await r.resolveInstallationId({ owner: "o", repo: "r" });
				expect(r.size).toBe(1);

				vi.advanceTimersByTime(1500);
				fetchSpy.mockResolvedValueOnce(lookup404());
				await r
					.resolveInstallationId({ owner: "o", repo: "r" })
					.catch(() => undefined);

				// Not merely expired — removed, so nothing can later read it.
				expect(r.size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("invalidate() forces a fresh lookup", async () => {
			const r = new GitHubInstallationResolver(config, { ttlMs: 60_000 });
			// A fresh Response per call: a body can only be read once, so a single
			// shared mock value fails the second lookup for the wrong reason.
			fetchSpy.mockImplementation(async () => lookupOk(111));

			await r.resolveInstallationId({ owner: "o", repo: "r" });
			r.invalidate({ owner: "O", repo: "R" }); // case-insensitive
			await r.resolveInstallationId({ owner: "o", repo: "r" });

			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe("resolveFromUrl", () => {
		it("resolves a worktree origin remote", async () => {
			const r = new GitHubInstallationResolver(config);
			fetchSpy.mockResolvedValueOnce(lookupOk(777));

			expect(await r.resolveFromUrl("https://github.com/acme/widget.git")).toBe(
				"777",
			);
		});

		it("returns null for a non-GitHub remote rather than failing it", async () => {
			// A GitLab remote is not a GitHub misconfiguration.
			const r = new GitHubInstallationResolver(config);
			expect(
				await r.resolveFromUrl("https://gitlab.com/group/project.git"),
			).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	describe("minting", () => {
		it("mints against the installation resolved for that repository", async () => {
			const r = new GitHubInstallationResolver(config);
			fetchSpy.mockResolvedValueOnce(lookupOk(4242)).mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "ghs_scoped" }), {
					status: 200,
				}) as never,
			);

			expect(await r.mintTokenForRef({ owner: "o", repo: "r" })).toBe(
				"ghs_scoped",
			);
			expect(String(fetchSpy.mock.calls[1]?.[0])).toContain(
				"/app/installations/4242/access_tokens",
			);
		});

		it("refuses to mint at all when nothing covers the repository", async () => {
			const r = new GitHubInstallationResolver(config);
			fetchSpy.mockResolvedValueOnce(lookup404());

			await expect(
				r.mintTokenForRef({ owner: "o", repo: "r" }),
			).rejects.toBeInstanceOf(NoInstallationForRepositoryError);

			const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
			expect(urls.some((u) => u.includes("access_tokens"))).toBe(false);
		});
	});
});
