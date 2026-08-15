import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleRepository,
	sameRepository,
} from "../../src/handlers/repository.js";

vi.mock("node:child_process", () => ({
	exec: vi.fn(),
	execSync: vi.fn(),
}));
vi.mock("node:util", () => ({ promisify: (fn: any) => fn }));
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);

/**
 * PON-115: clone paths carried no tenant discriminator, and an existing
 * directory whose NAME matched was silently adopted. Two tenants each with a
 * repository called "api" would have shared one working copy and one branch
 * namespace.
 */
describe("handleRepository tenant isolation (PON-115)", () => {
	const cyrusHome = "/home/user/.cyrus";

	beforeEach(() => {
		vi.clearAllMocks();
		// Target dir absent before the clone; present (as a git repo) after it.
		mockExistsSync.mockImplementation((p: any) => String(p).endsWith("/.git"));
		vi.mocked(mkdirSync).mockReturnValue(undefined as any);
	});

	it("clones into a per-workspace directory when the workspace is known", async () => {
		const result = await handleRepository(
			{
				repository_url: "https://github.com/acme/api",
				repository_name: "api",
				linear_workspace_id: "ws-aaa",
			} as any,
			cyrusHome,
		);

		expect(result.data?.path).toBe("/home/user/.cyrus/repos/ws-aaa/api");
	});

	it("keeps the flat layout when no workspace is supplied", async () => {
		const result = await handleRepository(
			{
				repository_url: "https://github.com/acme/api",
				repository_name: "api",
			} as any,
			cyrusHome,
		);

		expect(result.data?.path).toBe("/home/user/.cyrus/repos/api");
	});

	it("REFUSES to adopt a directory holding a different repository", async () => {
		mockExistsSync.mockReturnValue(true);
		mockExecSync.mockReturnValue(
			"https://github.com/other-tenant/api.git" as any,
		);

		const result = await handleRepository(
			{
				repository_url: "https://github.com/acme/api",
				repository_name: "api",
			} as any,
			cyrusHome,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("already in use by a different repository");
		expect(result.details).toContain("other-tenant");
	});

	it("still adopts the directory when it is the same repository", async () => {
		mockExistsSync.mockReturnValue(true);
		// same repo, different URL form (ssh vs https, .git suffix)
		mockExecSync.mockReturnValue("git@github.com:acme/api.git" as any);

		const result = await handleRepository(
			{
				repository_url: "https://github.com/acme/api",
				repository_name: "api",
			} as any,
			cyrusHome,
		);

		expect(result.success).toBe(true);
		expect(result.data?.action).toBe("verified");
	});

	it("adopts when the origin cannot be read rather than failing closed", async () => {
		mockExistsSync.mockReturnValue(true);
		mockExecSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});

		const result = await handleRepository(
			{
				repository_url: "https://github.com/acme/api",
				repository_name: "api",
			} as any,
			cyrusHome,
		);

		expect(result.success).toBe(true);
	});
});

describe("sameRepository", () => {
	it.each([
		["https://github.com/acme/api", "git@github.com:acme/api.git"],
		["https://github.com/acme/api.git", "https://github.com/acme/api/"],
		["https://user:token@github.com/acme/api", "https://github.com/acme/api"],
		["https://GitHub.com/Acme/API", "https://github.com/acme/api"],
	])("treats %s and %s as the same repository", (a, b) => {
		expect(sameRepository(a, b)).toBe(true);
	});

	it.each([
		["https://github.com/acme/api", "https://github.com/other/api"],
		["https://github.com/acme/api", "https://github.com/acme/api-v2"],
		["https://github.com/acme/api", "https://gitlab.com/acme/api"],
	])("treats %s and %s as different repositories", (a, b) => {
		expect(sameRepository(a, b)).toBe(false);
	});
});
