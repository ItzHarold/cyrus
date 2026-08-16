import {
	access,
	cp,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultSkillsDeployer } from "../src/DefaultSkillsDeployer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(
	__dirname,
	"..",
	"cyrus-skills-plugin",
	"skills",
);

function createTestLogger(): ILogger {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		withContext: () => createTestLogger(),
	} as unknown as ILogger;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("DefaultSkillsDeployer", () => {
	let testHome: string;
	let deployer: DefaultSkillsDeployer;

	beforeEach(async () => {
		testHome = join(
			tmpdir(),
			`cyrus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(testHome, { recursive: true });
		deployer = new DefaultSkillsDeployer(
			testHome,
			createTestLogger(),
			BUNDLED_SKILLS_DIR,
		);
	});

	afterEach(async () => {
		await rm(testHome, { recursive: true, force: true });
	});

	it("should deploy default skills when plugin directory does not exist", async () => {
		await deployer.ensureDeployed();

		const pluginPath = join(testHome, "cyrus-skills-plugin");
		expect(await exists(pluginPath)).toBe(true);

		// Plugin manifest should exist
		const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
		expect(await exists(manifestPath)).toBe(true);

		const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
		expect(manifest.name).toBe("cyrus-skills");

		// Skills directory should exist with skills copied
		const skillsPath = join(pluginPath, "skills");
		expect(await exists(skillsPath)).toBe(true);

		const skillDirs = await readdir(skillsPath, { withFileTypes: true });
		const skillNames = skillDirs
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
		expect(skillNames.length).toBeGreaterThan(0);
		expect(skillNames).toContain("implementation");
		expect(skillNames).toContain("debug");
		expect(skillNames).toContain("verify-and-ship");
	});

	it("should not overwrite existing plugin directory", async () => {
		// Deploy once
		await deployer.ensureDeployed();

		const pluginPath = join(testHome, "cyrus-skills-plugin");
		const skillsPath = join(pluginPath, "skills");

		// Remove a skill to simulate user customization
		const implPath = join(skillsPath, "implementation");
		await rm(implPath, { recursive: true, force: true });

		// Deploy again — should NOT recreate the removed skill
		await deployer.ensureDeployed();

		expect(await exists(implPath)).toBe(false);
	});

	// A skill added in a later release must reach installs that already ran —
	// otherwise the feature ships and is inert everywhere real (PON-113).
	it("deploys a newly bundled skill to an install that already exists", async () => {
		await deployer.ensureDeployed();
		const skillsPath = join(testHome, "cyrus-skills-plugin", "skills");
		const newSkill = join(skillsPath, "brand-new-skill");
		expect(await exists(newSkill)).toBe(false);

		// Simulate the next release bundling an extra skill.
		const extraBundled = join(BUNDLED_SKILLS_DIR, "..", "..", "..");
		const tempBundle = join(testHome, "bundled-next");
		await mkdir(join(tempBundle, "brand-new-skill"), { recursive: true });
		await writeFile(
			join(tempBundle, "brand-new-skill", "SKILL.md"),
			"---\nname: brand-new-skill\ndescription: x\n---\n",
		);
		for (const name of await readdir(BUNDLED_SKILLS_DIR)) {
			await cp(join(BUNDLED_SKILLS_DIR, name), join(tempBundle, name), {
				recursive: true,
				dereference: true,
			});
		}
		void extraBundled;

		const upgraded = new DefaultSkillsDeployer(
			testHome,
			createTestLogger(),
			tempBundle,
		);
		await upgraded.ensureDeployed();

		expect(await exists(newSkill)).toBe(true);
	});

	it("does not restore a skill the user deleted after it was deployed", async () => {
		await deployer.ensureDeployed();
		const skillsPath = join(testHome, "cyrus-skills-plugin", "skills");
		const implPath = join(skillsPath, "implementation");
		await rm(implPath, { recursive: true, force: true });

		await deployer.ensureDeployed();
		await deployer.ensureDeployed();

		expect(await exists(implPath)).toBe(false);
	});

	// On an install predating the record, a missing skill is indistinguishable
	// from a deleted one. It is restored once — the alternative is that no new
	// default skill ever reaches an existing install — and the record written
	// on that pass makes any later deletion stick.
	it("restores a missing skill once on a pre-record install, then respects deletion", async () => {
		await deployer.ensureDeployed();
		const pluginPath = join(testHome, "cyrus-skills-plugin");
		const implPath = join(pluginPath, "skills", "implementation");

		// Mimic an older install: no record, and the skill removed.
		await rm(join(pluginPath, ".deployed-skills.json"), { force: true });
		await rm(implPath, { recursive: true, force: true });

		await deployer.ensureDeployed();
		expect(await exists(implPath)).toBe(true); // restored once

		// Now the record exists, so a deliberate deletion sticks.
		await rm(implPath, { recursive: true, force: true });
		await deployer.ensureDeployed();
		expect(await exists(implPath)).toBe(false);
	});

	it("should create SKILL.md files in each deployed skill directory", async () => {
		await deployer.ensureDeployed();

		const skillsPath = join(testHome, "cyrus-skills-plugin", "skills");
		const skillDirs = await readdir(skillsPath, { withFileTypes: true });

		for (const entry of skillDirs) {
			if (entry.isDirectory()) {
				const skillMd = join(skillsPath, entry.name, "SKILL.md");
				expect(await exists(skillMd)).toBe(true);
			}
		}
	});
});
