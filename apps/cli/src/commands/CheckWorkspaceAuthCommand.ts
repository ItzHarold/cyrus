import {
	describeWorkspaceAuth,
	resolveWorkspaceAuthEnv,
	WorkspaceAuthNotDeclaredError,
} from "cyrus-core";
import { BaseCommand } from "./ICommand.js";

/**
 * Report how each configured Linear workspace authenticates to Anthropic
 * (PON-139), without starting anything.
 *
 * This exists because the alternative was restarting the service to find out.
 * A workspace that has not declared its credential refuses to start sessions,
 * so on a box serving clients the restart *is* the test — and its failure mode
 * is every undeclared workspace stopping at once. That is the wrong shape for a
 * check: it should be possible to know the answer before taking the risk.
 *
 * Strictly read-only. No network, no sessions, no writes. It resolves each
 * workspace through exactly the same function the runtime uses, so a pass here
 * means the runtime will resolve it too — a check that reimplemented the logic
 * could agree with itself and disagree with production.
 *
 * Never prints a key. A credential is described by mode and length only, which
 * is enough to tell two workspaces apart and not enough to reconstruct either.
 */
export class CheckWorkspaceAuthCommand extends BaseCommand {
	async execute(_args: string[]): Promise<void> {
		if (!this.app.config.exists()) {
			this.logError("No edge configuration found. Please run setup first.");
			process.exit(1);
		}

		const config = this.app.config.load();
		const workspaces = Object.entries(config.linearWorkspaces ?? {});

		console.log("\nWorkspace Anthropic auth");
		this.logDivider();

		if (workspaces.length === 0) {
			console.log("No Linear workspaces configured.");
			return;
		}

		// The subscription token comes from the process environment, exactly as it
		// does at session start. Running this in a shell without the service's env
		// will therefore report a subscription workspace as unsatisfiable — which
		// is correct rather than a false alarm: it is the same question the
		// service asks, asked in a different environment.
		const subscriptionToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

		let refused = 0;

		for (const [workspaceId, workspace] of workspaces) {
			const name = workspace?.linearWorkspaceName || workspaceId;
			const declared = describeWorkspaceAuth(workspace?.anthropicAuth);

			try {
				resolveWorkspaceAuthEnv(workspace?.anthropicAuth, workspaceId, {
					workspaceName: workspace?.linearWorkspaceName,
					subscriptionToken,
				});
				console.log(`  ✅ ${name.padEnd(24)} ${declared}`);
			} catch (error) {
				refused++;
				const why =
					error instanceof WorkspaceAuthNotDeclaredError
						? "no anthropicAuth declared"
						: (error as Error).message.split("\n")[0];
				console.log(`  ❌ ${name.padEnd(24)} ${declared} — ${why}`);
			}
		}

		console.log();

		if (refused > 0) {
			this.logError(
				`${refused} of ${workspaces.length} workspace(s) would refuse to start sessions.`,
			);
			console.log(
				"   Declare anthropicAuth on each, then re-run. Restarting before\n" +
					"   this is clean stops those workspaces entirely.",
			);
			process.exit(1);
		}

		this.logSuccess(
			`All ${workspaces.length} workspace(s) resolve their declared credential.`,
		);
		// Exit explicitly: the Application keeps a watcher on the env file, so the
		// event loop never drains on its own and the command would appear to hang.
		// The same reason SelfAuthCommand exits rather than returning.
		process.exit(0);
	}
}
