import {
	access,
	cp,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger } from "cyrus-core";

/**
 * Deploys bundled default skills to the cyrusHome directory.
 *
 * On first startup, copies all bundled skill directories from the package
 * into `~/.cyrus/cyrus-skills-plugin/skills/` so that users can inspect
 * and customize them. Subsequent startups skip the copy if the plugin
 * directory already exists.
 *
 * Single Responsibility: this class only handles the one-time deployment
 * of default skills from the package to the user's home directory.
 */
export class DefaultSkillsDeployer {
	private readonly bundledSkillsPath: string;
	private readonly deployedPluginPath: string;
	private readonly deployedSkillsPath: string;
	private readonly manifestDir: string;
	private readonly manifestPath: string;
	/** Record of skills this deployer has already placed on disk. */
	private readonly deploymentRecordPath: string;

	constructor(
		private readonly cyrusHome: string,
		private readonly logger: ILogger,
		bundledSkillsDir?: string,
	) {
		// Default: skills live alongside the compiled JS in dist/, placed there
		// by the copy-prompts build step. Callers (e.g. tests) can override.
		this.bundledSkillsPath =
			bundledSkillsDir ??
			join(
				dirname(fileURLToPath(import.meta.url)),
				"cyrus-skills-plugin",
				"skills",
			);
		this.deployedPluginPath = join(this.cyrusHome, "cyrus-skills-plugin");
		this.deployedSkillsPath = join(this.deployedPluginPath, "skills");
		this.manifestDir = join(this.deployedPluginPath, ".claude-plugin");
		this.manifestPath = join(this.manifestDir, "plugin.json");
		this.deploymentRecordPath = join(
			this.deployedPluginPath,
			".deployed-skills.json",
		);
	}

	/**
	 * Ensure default skills are deployed to cyrusHome.
	 *
	 * Deploys any bundled skill this install has never seen, and leaves
	 * everything else alone.
	 *
	 * This used to return early whenever the plugin directory existed. That
	 * protected customizations, but it also meant a skill added in a later
	 * release could never reach an install that had already run once — the
	 * feature shipped and was inert on every upgraded instance, which is how
	 * `assess-scope` (PON-113) arrived dead on this box.
	 *
	 * Simply deploying whatever is missing would fix that and break the other
	 * half: a user who deleted a skill would get it back on the next restart.
	 * So deployment is tracked in `.deployed-skills.json`. A skill is copied
	 * only if it has never been deployed AND is not present.
	 *
	 * On an install predating that record, a missing skill is indistinguishable
	 * from a deleted one. It is restored once, and the record written on that
	 * pass makes any later deletion stick. Restoring once was chosen over
	 * honouring the ambiguity because the alternative is that no new default
	 * skill ever reaches an install that already exists — which is every real
	 * one.
	 */
	async ensureDeployed(): Promise<void> {
		if (!(await this.exists(this.bundledSkillsPath))) {
			this.logger.warn(
				`Bundled skills not found at ${this.bundledSkillsPath} — cannot deploy defaults`,
			);
			return;
		}

		// Create plugin directory structure
		await mkdir(this.deployedSkillsPath, { recursive: true });

		// Write plugin manifest if absent (never overwrite a customized one)
		await mkdir(this.manifestDir, { recursive: true });
		if (!(await this.exists(this.manifestPath))) {
			await writeFile(
				this.manifestPath,
				JSON.stringify(
					{
						name: "cyrus-skills",
						description: "Default Cyrus workflow skills for agent sessions",
					},
					null,
					"\t",
				),
			);
		}

		// Copy each skill directory from bundled to deployed.
		// Entries may be directories or symlinks to directories (dev vs build).
		const entries = await readdir(this.bundledSkillsPath, {
			withFileTypes: true,
		});
		const previouslyDeployed = await this.readDeploymentRecord();
		let deployedCount = 0;
		const deployedNames: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const dest = join(this.deployedSkillsPath, entry.name);
			// Already deployed once: whatever the user did with it since —
			// customized or deleted — is their decision.
			if (previouslyDeployed.has(entry.name)) continue;
			if (await this.exists(dest)) {
				previouslyDeployed.add(entry.name);
				continue;
			}
			await cp(join(this.bundledSkillsPath, entry.name), dest, {
				recursive: true,
				dereference: true,
			});
			previouslyDeployed.add(entry.name);
			deployedCount++;
			deployedNames.push(entry.name);
		}
		await this.writeDeploymentRecord(previouslyDeployed);

		if (deployedCount === 0) {
			this.logger.debug(
				`Default skills already present at ${this.deployedPluginPath}`,
			);
			return;
		}

		this.logger.info(
			`Deployed default skills to ${this.deployedPluginPath} (${deployedCount} new: ${deployedNames.join(", ")})`,
		);
	}

	/**
	 * Skills this install has already been given. Absent for installs that
	 * predate the record — seeded from disk so their deletions still count.
	 */
	private async readDeploymentRecord(): Promise<Set<string>> {
		try {
			const raw = await readFile(this.deploymentRecordPath, "utf-8");
			const parsed = JSON.parse(raw) as { skills?: string[] };
			return new Set(parsed.skills ?? []);
		} catch {
			// No record: seed from what is on disk today.
			try {
				const entries = await readdir(this.deployedSkillsPath, {
					withFileTypes: true,
				});
				return new Set(
					entries
						.filter((e) => e.isDirectory() || e.isSymbolicLink())
						.map((e) => e.name),
				);
			} catch {
				return new Set();
			}
		}
	}

	private async writeDeploymentRecord(skills: Set<string>): Promise<void> {
		try {
			await writeFile(
				this.deploymentRecordPath,
				JSON.stringify({ skills: [...skills].sort() }, null, "\t"),
			);
		} catch (error) {
			// Non-fatal: a missing record only means the next start re-seeds
			// from disk, which is the pre-existing behavior.
			this.logger.warn("Could not write skill deployment record:", error);
		}
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}
}
