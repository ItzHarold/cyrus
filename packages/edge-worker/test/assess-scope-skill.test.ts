import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read through the bundled plugin path rather than the canonical `skills/`
 * directory: the bundle entry is a symlink, and this is the path that actually
 * ships. If the symlink breaks, these assertions fail rather than silently
 * testing a file no install ever sees.
 */
const SKILL_PATH = join(
	__dirname,
	"..",
	"cyrus-skills-plugin",
	"skills",
	"assess-scope",
	"SKILL.md",
);

describe("assess-scope skill: sub-issue handover", () => {
	let skill: string;

	beforeAll(async () => {
		skill = await readFile(SKILL_PATH, "utf8");
	});

	// PON-113: sub-issues were created with `assignee` copied from the original.
	// Linear routes agent work through `delegate`, and a delegated issue reads
	// `assignee: null` — so every approved split produced sub-issues that sat in
	// the backlog and never started. Verified live in FRO-35/36/37.
	it("tells the model to copy delegate, not assignee", () => {
		expect(skill).toMatch(/`delegate`/);
		expect(skill).toMatch(/not its `assignee`/);
	});

	it("explains why assignee is empty, so the rule survives editing", () => {
		expect(skill).toMatch(/assignee: null/);
	});

	it("hands over only the first sub-issue", () => {
		expect(skill).toMatch(/first sub-issue only/i);
		expect(skill).toMatch(/Leave the rest undelegated/i);
	});

	it("delegates nothing when the original has no delegate", () => {
		expect(skill).toMatch(/no `delegate`/);
	});

	it("requires the pointer response to name what is underway", () => {
		expect(skill).toMatch(/which sub-issue is now underway/i);
		expect(skill).toMatch(/start when the client\s+delegates them/i);
	});

	it("still refuses to close the original issue", () => {
		expect(skill).toMatch(/Leave the original issue open/);
		expect(skill).toMatch(/Do not close it yourself/);
	});
});
