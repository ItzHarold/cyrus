import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { LinearClient } from "@linear/sdk";
import {
	DEFAULT_BASE_BRANCH,
	DEFAULT_CONFIG_FILENAME,
	type EdgeConfig,
	migrateEdgeConfig,
	updateConfigFile,
} from "cyrus-core";
import {
	GIT_NO_AMBIENT_CREDENTIALS,
	gitAuthEnv,
	journalAmbientTokenFallback,
	mintTokenForRepo,
	parseGitHubRepoUrl,
} from "cyrus-github-event-transport";
import { getDefaultReposDir } from "../utils/getDefaultReposDir.js";
import { getDefaultWorktreesDir } from "../utils/getDefaultWorktreesDir.js";
import { BaseCommand } from "./ICommand.js";

/**
 * Detect the default branch of a cloned repository by reading the remote HEAD ref.
 * Falls back to DEFAULT_BASE_BRANCH ("main") if detection fails.
 */
export function detectDefaultBranch(repositoryPath: string): string {
	try {
		const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
			cwd: repositoryPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		// ref looks like "refs/remotes/origin/main" — extract the branch name
		const branch = ref.replace("refs/remotes/origin/", "");
		if (branch) {
			return branch;
		}
	} catch {
		// symbolic-ref not set — try `git remote show origin` as fallback
		try {
			const output = execSync("git remote show origin", {
				cwd: repositoryPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const match = output.match(/HEAD branch:\s*(.+)/);
			if (match?.[1]?.trim()) {
				return match[1].trim();
			}
		} catch {
			// Both methods failed, fall through to default
		}
	}
	return DEFAULT_BASE_BRANCH;
}

/**
 * Workspace credentials extracted from existing repository configurations
 */
interface WorkspaceCredentials {
	id: string;
	name: string;
	token: string;
	refreshToken?: string;
}

/**
 * Self-add-repo command - clones a repo and adds it to config.json
 *
 * Usage:
 *   cyrus self-add-repo                      # prompts for everything
 *   cyrus self-add-repo <url>                # prompts for workspace if multiple
 *   cyrus self-add-repo <url> <workspace>    # no prompts
 *   cyrus self-add-repo <url> -l <labels>    # custom routing labels (comma-separated)
 *   cyrus self-add-repo <url> <workspace> -l <labels>
 *
 * Routing labels are used to route Linear issues to this repository.
 * If not specified, defaults to the repository name.
 */
export class SelfAddRepoCommand extends BaseCommand {
	private rl: readline.Interface | null = null;

	private getReadline(): readline.Interface {
		if (!this.rl) {
			this.rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});
		}
		return this.rl;
	}

	private prompt(question: string): Promise<string> {
		return new Promise((resolve) => {
			this.getReadline().question(question, (answer) => resolve(answer.trim()));
		});
	}

	/**
	 * The team key(s) this repository should route on (PON-190).
	 *
	 * Returns undefined when it cannot be resolved without a decision — more
	 * than one team, or a lookup that failed. The caller then keeps the
	 * label-based routing it always had, so this can only ever add certainty,
	 * never remove a working configuration.
	 */
	private async resolveTeamKeys(
		workspace: WorkspaceCredentials,
	): Promise<string[] | undefined> {
		try {
			const client = new LinearClient({ accessToken: workspace.token });
			const teams = await client.teams({ first: 10 });
			const keys = teams.nodes.map((t) => t.key).filter(Boolean);
			if (keys.length === 1) {
				console.log(`Routing on team key: ${keys[0]}`);
				return [keys[0] as string];
			}
			if (keys.length > 1) {
				console.log(
					`This workspace has ${keys.length} teams (${keys.join(", ")}) — routing on the label instead.`,
				);
				console.log(
					`  To route on a team, add "teamKeys": ["<KEY>"] to this repository.`,
				);
			}
			return undefined;
		} catch (error) {
			// A failed lookup must not fail the onboarding: label routing is
			// what happened before this existed.
			console.log(
				`Could not read the workspace's teams (${(error as Error).message}) — routing on the label.`,
			);
			return undefined;
		}
	}

	private cleanup(): void {
		if (this.rl) {
			this.rl.close();
			this.rl = null;
		}
	}

	async execute(args: string[]): Promise<void> {
		// Parse flags
		let customLabels: string[] | null = null;
		let baseBranchFlag: string | null = null;
		const positionalArgs: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (!arg) continue;
			if ((arg === "-l" || arg === "--label") && args[i + 1]) {
				customLabels = args[i + 1]!.split(",")
					.map((l) => l.trim())
					.filter((l) => l.length > 0);
				i++; // Skip the label value
			} else if ((arg === "-b" || arg === "--base-branch") && args[i + 1]) {
				baseBranchFlag = args[i + 1]!;
				i++; // Skip the branch value
			} else {
				positionalArgs.push(arg);
			}
		}

		let url = positionalArgs[0];
		const workspaceName = positionalArgs[1];

		try {
			// Load config
			const configPath = resolve(this.app.cyrusHome, DEFAULT_CONFIG_FILENAME);
			let config: EdgeConfig;
			try {
				config = migrateEdgeConfig(
					JSON.parse(readFileSync(configPath, "utf-8")),
				) as EdgeConfig;
			} catch {
				this.logError(`Config file not found: ${configPath}`);
				process.exit(1);
			}

			if (!config.repositories) {
				config.repositories = [];
			}

			// Get URL if not provided
			if (!url) {
				url = await this.prompt("Repository URL: ");
				if (!url) {
					this.logError("URL is required");
					process.exit(1);
				}
			}

			// Extract repo name from URL
			const repoName = url
				.split("/")
				.pop()
				?.replace(/\.git$/, "");
			if (!repoName) {
				this.logError("Could not extract repo name from URL");
				process.exit(1);
			}

			// Check for duplicate
			if (
				config.repositories.some(
					(r: EdgeConfig["repositories"][number]) => r.name === repoName,
				)
			) {
				this.logError(`Repository '${repoName}' already exists in config`);
				process.exit(1);
			}

			// Find workspaces with Linear credentials (from workspace-level config)
			const workspaces = new Map<string, WorkspaceCredentials>();
			if (config.linearWorkspaces) {
				for (const [wsId, wsConfig] of Object.entries(
					config.linearWorkspaces,
				)) {
					if (wsConfig.linearToken) {
						workspaces.set(wsId, {
							id: wsId,
							name: wsConfig.linearWorkspaceName || wsId,
							token: wsConfig.linearToken,
							refreshToken: wsConfig.linearRefreshToken,
						});
					}
				}
			}

			if (workspaces.size === 0) {
				this.logError(
					"No Linear credentials found. Run 'cyrus self-auth-linear' first.",
				);
				process.exit(1);
			}

			// Get workspace
			let selectedWorkspace: WorkspaceCredentials;
			const workspaceList = Array.from(workspaces.values());

			if (workspaceList.length === 1) {
				// Safe: we checked length === 1 above
				selectedWorkspace = workspaceList[0]!;
			} else if (workspaceName) {
				const foundWorkspace = workspaceList.find(
					(w) => w.name === workspaceName,
				);
				if (!foundWorkspace) {
					this.logError(`Workspace '${workspaceName}' not found`);
					process.exit(1);
				}
				selectedWorkspace = foundWorkspace;
			} else {
				console.log("\nAvailable workspaces:");
				workspaceList.forEach((w, i) => {
					console.log(`  ${i + 1}. ${w.name}`);
				});
				const choice = await this.prompt(
					`Select workspace [1-${workspaceList.length}]: `,
				);
				const idx = parseInt(choice, 10) - 1;
				if (idx < 0 || idx >= workspaceList.length) {
					this.logError("Invalid selection");
					process.exit(1);
				}
				// Safe: we validated idx is within bounds above
				selectedWorkspace = workspaceList[idx]!;
			}

			// Clone the repo
			const repositoryPath = resolve(
				getDefaultReposDir(this.app.cyrusHome),
				repoName,
			);

			if (existsSync(repositoryPath)) {
				console.log(`Repository already exists at ${repositoryPath}`);
			} else {
				console.log(`Cloning ${url}...`);
				try {
					await this.cloneRepository(url, repositoryPath);
				} catch (error) {
					this.logError(
						`Failed to clone repository: ${(error as Error).message}`,
					);
					process.exit(1);
				}
			}

			// Generate UUID and add to config
			const id = randomUUID();
			const routingLabels = customLabels ?? [repoName];

			// PON-190: resolve the team key rather than leaving routing to a
			// label. The default routing label is the repository name, and
			// nothing creates it — agent tokens cannot create labels — so a
			// client who onboarded without a human making that label by hand
			// had a connected repo that silently routed nothing. A workspace
			// with exactly one team has no ambiguity to resolve; more than one
			// is the only case worth asking about, and the label routing
			// stays as the fallback there.
			const teamKeys = await this.resolveTeamKeys(selectedWorkspace);

			// Determine base branch: flag > auto-detect > default
			const baseBranch = baseBranchFlag ?? detectDefaultBranch(repositoryPath);
			if (baseBranch !== DEFAULT_BASE_BRANCH) {
				console.log(`Detected base branch: ${baseBranch}`);
			}

			// Detect hosting platform from URL
			const repoConfig: EdgeConfig["repositories"][number] = {
				id,
				name: repoName,
				repositoryPath,
				baseBranch,
				workspaceBaseDir: getDefaultWorktreesDir(this.app.cyrusHome),
				linearWorkspaceId: selectedWorkspace.id,
				isActive: true,
				routingLabels,
				...(teamKeys ? { teamKeys } : {}),
			};

			if (url.includes("gitlab.com") || url.includes("gitlab.")) {
				repoConfig.gitlabUrl = url.replace(/\.git$/, "");
			} else if (url.includes("github.com")) {
				repoConfig.githubUrl = url.replace(/\.git$/, "");
			}

			// PON-190: the append happens INSIDE the lock, against the file as
			// it is at that moment — not against the copy read at the top of
			// this command. Between those two points a token rotation or
			// another signup can have written, and writing our stale copy back
			// would erase it. 0600 throughout: this file holds every
			// workspace's Linear OAuth tokens.
			updateConfigFile<typeof config>(
				configPath,
				(current) => {
					const next = current ?? config;
					next.repositories = next.repositories ?? [];
					next.repositories.push(repoConfig);
					return next;
				},
				{ mode: 0o600, indent: "\t" },
			);

			console.log(`\nAdded: ${repoName}`);
			console.log(`  ID: ${id}`);
			console.log(`  Base branch: ${baseBranch}`);
			console.log(`  Workspace: ${selectedWorkspace.name}`);
			console.log(`  Routing labels: ${routingLabels.join(", ")}`);
			console.log(`\nTo use different routing labels, edit ${configPath}`);
			process.exit(0);
		} finally {
			this.cleanup();
		}
	}

	/**
	 * Clone a repository, authenticating through the GitHub App when one is
	 * configured.
	 *
	 * This used to be a bare `execSync("git clone ...")` with `stdio: "inherit"`.
	 * On a box with an ambient credential helper it silently worked, using a
	 * person's GitHub account. On a clean production box it stopped at
	 * `Username for 'https://github.com':` and waited for a human who was not
	 * there — the App was configured, and onboarding never consulted it.
	 *
	 * The token is minted for this repository's own installation and passed
	 * through the environment for exactly this one git process. It is never
	 * written to `.git/config`, never becomes part of the saved remote URL, and
	 * never appears in argv, so the clone leaves nothing behind that could leak
	 * into a log or outlive the token's hour.
	 */
	private async cloneRepository(
		url: string,
		repositoryPath: string,
	): Promise<void> {
		const appId = process.env.GITHUB_APP_ID;
		const privateKeyPath = resolve(this.app.cyrusHome, "github-app.pem");
		const ref = parseGitHubRepoUrl(url);

		// Not in App mode, or not a GitHub remote: behave exactly as before.
		// Absence of App configuration is a legitimate legacy/dev setup, not a
		// misconfiguration — so it is not something to fail loudly about.
		if (!appId || !existsSync(privateKeyPath) || !ref) {
			if (appId && !ref) {
				console.log(
					"   Not a GitHub remote — cloning without GitHub App credentials.",
				);
			}
			// Journaled for the same reason the mint is (PON-176): "the clone
			// worked" says nothing about which credential made it work, and on a
			// box with an ambient helper configured that is precisely the case
			// worth spotting. Named distinctly from the mint so the two are one
			// grep apart, and the reason says which of the three branches ran
			// rather than leaving it to be reconstructed from the environment.
			const reason = !ref
				? "not-github"
				: !appId
					? "no-app-configured"
					: "no-app-private-key";
			journalAmbientTokenFallback(reason, {
				...(ref ? { ref } : {}),
				operation: "clone",
			});
			execSync(`git clone ${url} ${repositoryPath}`, { stdio: "inherit" });
			return;
		}

		console.log(
			`   Authenticating as the GitHub App for ${ref.owner}/${ref.repo}...`,
		);

		// Deliberately not caught: no installation covering this repository is a
		// misconfiguration to surface, not to work around. Falling back to an
		// ambient credential here is how a box ends up quietly cloning one
		// tenant's repository with another tenant's access.
		const token = await mintTokenForRepo({ appId, privateKeyPath }, ref);

		execSync(
			`git ${GIT_NO_AMBIENT_CREDENTIALS.join(" ")} clone ${url} ${repositoryPath}`,
			{
				stdio: "inherit",
				env: { ...process.env, ...gitAuthEnv(token) },
			},
		);

		// The saved remote is the plain URL — verified rather than assumed,
		// because a credential embedded here would persist on disk for anyone
		// who can read the repo, long after the token itself expired.
		const savedRemote = execSync("git remote get-url origin", {
			cwd: repositoryPath,
			encoding: "utf-8",
		}).trim();
		if (savedRemote.includes("@github.com")) {
			throw new Error(
				"Refusing to continue: the saved remote URL contains credentials. " +
					"This should be impossible — report it.",
			);
		}
	}
}
