import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCyrusConfig } from "../../src/handlers/cyrusConfig.js";

vi.mock("node:fs", () => ({
	chmodSync: vi.fn(),
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	// A missing file throws ENOENT; returning undefined made JSON.parse throw a
	// SyntaxError, which the locked writer treats as "unparseable, refuse to
	// overwrite" — correctly, since silently replacing it would delete every
	// tenant on the box.
	readFileSync: vi.fn(() => {
		const error = new Error("ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		throw error;
	}),
	readdirSync: vi.fn(() => []),
	unlinkSync: vi.fn(),
	writeFileSync: vi.fn(),
	// PON-190: the shared locked config writer needs these too.
	openSync: vi.fn(() => 1),
	closeSync: vi.fn(),
	renameSync: vi.fn(),
	statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe("handleCyrusConfig", () => {
	const cyrusHome = "/test/cyrus-home";

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CYRUS_WORKTREES_DIR;
		mockExistsSync.mockReturnValue(false);
		// No config file exists in these tests; a missing file throws ENOENT.
		mockReadFileSync.mockImplementation(() => {
			const error = new Error("ENOENT") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		});
	});

	afterEach(() => {
		delete process.env.CYRUS_WORKTREES_DIR;
	});

	it("defaults repository workspaceBaseDir to cyrusHome/worktrees", async () => {
		const result = await handleCyrusConfig(
			{
				repositories: [
					{
						id: "repo-1",
						name: "repo-1",
						repositoryPath: "/repos/repo-1",
						baseBranch: "main",
					},
				],
			},
			cyrusHome,
		);

		expect(result.success).toBe(true);
		expect(mockMkdirSync).toHaveBeenCalledWith(cyrusHome, { recursive: true });
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			// A per-writer temp name (pid + counter), renamed into place — two
			// writers must never share one temp file.
			expect.stringMatching(
				/^\/test\/cyrus-home\/config\.json\.\d+\.\d+\.tmp$/,
			),
			expect.stringContaining(
				'"workspaceBaseDir": "/test/cyrus-home/worktrees"',
			),
			// The locked writer passes mode only; 0600 is unchanged and is
			// additionally re-asserted by an explicit chmod after the write.
			{ mode: 0o600 },
		);
	});

	it("uses CYRUS_WORKTREES_DIR when set", async () => {
		process.env.CYRUS_WORKTREES_DIR = "/tmp/custom-worktrees";

		const result = await handleCyrusConfig(
			{
				repositories: [
					{
						id: "repo-1",
						name: "repo-1",
						repositoryPath: "/repos/repo-1",
						baseBranch: "main",
					},
				],
			},
			cyrusHome,
		);

		expect(result.success).toBe(true);
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			// A per-writer temp name (pid + counter), renamed into place — two
			// writers must never share one temp file.
			expect.stringMatching(
				/^\/test\/cyrus-home\/config\.json\.\d+\.\d+\.tmp$/,
			),
			expect.stringContaining('"workspaceBaseDir": "/tmp/custom-worktrees"'),
			// The locked writer passes mode only; 0600 is unchanged and is
			// additionally re-asserted by an explicit chmod after the write.
			{ mode: 0o600 },
		);
	});
});
