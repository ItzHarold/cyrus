import http from "node:http";
import open from "open";
import { CLIPrompts } from "../ui/CLIPrompts.js";
import { BaseCommand } from "./ICommand.js";

/**
 * Helper function to check Linear token status
 */
async function checkLinearToken(
	token: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: token,
			},
			body: JSON.stringify({
				query: "{ viewer { id email name } }",
			}),
		});

		const data = (await response.json()) as any;

		if (data.errors) {
			return {
				valid: false,
				error: data.errors[0]?.message || "Unknown error",
			};
		}

		return { valid: true };
	} catch (error) {
		return { valid: false, error: (error as Error).message };
	}
}

/**
 * Refresh token command - refresh a specific Linear token
 */
export class RefreshTokenCommand extends BaseCommand {
	async execute(_args: string[]): Promise<void> {
		if (!this.app.config.exists()) {
			this.logError("No edge configuration found. Please run setup first.");
			process.exit(1);
		}

		const config = this.app.config.load();

		// Build workspace list from workspace-level config
		type WorkspaceStatus = {
			id: string;
			name: string;
			token: string;
			valid: boolean;
		};
		const workspaceStatuses: WorkspaceStatus[] = [];

		console.log("Checking current token status...\n");

		if (config.linearWorkspaces) {
			for (const [wsId, wsConfig] of Object.entries(config.linearWorkspaces)) {
				const name = wsConfig.linearWorkspaceName || wsId;
				const result = await checkLinearToken(wsConfig.linearToken);
				workspaceStatuses.push({
					id: wsId,
					name,
					token: wsConfig.linearToken,
					valid: result.valid,
				});
				console.log(
					`${workspaceStatuses.length}. Workspace ${name}: ${
						result.valid ? "✅ Valid" : "❌ Invalid"
					}`,
				);
			}
		}

		if (workspaceStatuses.length === 0) {
			this.logError(
				"No Linear workspaces configured. Run 'cyrus self-auth-linear' first.",
			);
			process.exit(1);
		}

		// PON-136: non-interactive runs (scripts, incidents, SSH one-liners)
		// must not block on stdin — refresh every INVALID workspace via the
		// silent grant and never open a browser.
		const interactive = process.stdin.isTTY === true;
		const answer = interactive
			? await CLIPrompts.ask(
					'\nWhich workspace token would you like to refresh? (Enter number or "all"): ',
				)
			: "all";
		if (!interactive) {
			console.log(
				"\nNon-interactive mode: attempting the silent refresh grant for every workspace with an invalid token.",
			);
		}

		const indicesToRefresh: number[] = [];

		if (answer.toLowerCase() === "all") {
			indicesToRefresh.push(
				...Array.from({ length: workspaceStatuses.length }, (_, i) => i),
			);
		} else {
			const index = parseInt(answer, 10) - 1;
			if (
				Number.isNaN(index) ||
				index < 0 ||
				index >= workspaceStatuses.length
			) {
				this.logError("Invalid selection");
				process.exit(1);
			}
			indicesToRefresh.push(index);
		}

		// Refresh tokens
		for (const index of indicesToRefresh) {
			const ws = workspaceStatuses[index];
			if (!ws) continue;

			console.log(`\nRefreshing token for workspace ${ws.name} (${ws.id})...`);

			// PON-136: the silent refresh grant FIRST — this is the 2-minute
			// recovery the incidents actually needed (cases 3 and 4), and it
			// is what the running service does on a 401. The browser ceremony
			// is the fallback for a dead refresh token (case 2), and only
			// when a human is present.
			const storedRefresh =
				config.linearWorkspaces?.[ws.id]?.linearRefreshToken;
			const clientId = process.env.LINEAR_CLIENT_ID;
			const clientSecret = process.env.LINEAR_CLIENT_SECRET;
			if (storedRefresh && clientId && clientSecret) {
				try {
					const params = new URLSearchParams({
						grant_type: "refresh_token",
						client_id: clientId,
						client_secret: clientSecret,
						refresh_token: storedRefresh,
					});
					const response = await fetch("https://api.linear.app/oauth/token", {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: params.toString(),
					});
					if (response.ok) {
						const data = (await response.json()) as {
							access_token: string;
							refresh_token?: string;
						};
						this.app.config.update((cfg) => {
							const entry = cfg.linearWorkspaces?.[ws.id];
							if (entry) {
								entry.linearToken = data.access_token;
								if (data.refresh_token) {
									entry.linearRefreshToken = data.refresh_token;
								}
							}
							return cfg;
						});
						this.logSuccess(
							`Refreshed via the silent grant (rotated pair persisted) for ${ws.name}`,
						);
						continue;
					}
					console.log(
						`Silent refresh grant rejected (${response.status}) — the stored refresh token is likely dead.`,
					);
				} catch (error) {
					console.log(
						`Silent refresh grant failed (${(error as Error).message}).`,
					);
				}
			} else if (!storedRefresh) {
				console.log("No stored refresh token for this workspace.");
			} else {
				console.log(
					"LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET not in the environment — cannot use the silent grant.",
				);
			}

			if (!interactive) {
				this.logError(
					`Workspace ${ws.name} needs the browser OAuth flow — run this command interactively (or self-auth-linear).`,
				);
				process.exitCode = 1;
				continue;
			}
			console.log("Opening Linear OAuth flow in your browser...");

			// Use the proxy's OAuth flow with a callback to localhost
			const serverPort = process.env.CYRUS_SERVER_PORT
				? parseInt(process.env.CYRUS_SERVER_PORT, 10)
				: 3456;
			const callbackUrl = `http://localhost:${serverPort}/callback`;
			const proxyUrl = this.app.getProxyUrl();
			const oauthUrl = `${proxyUrl}/oauth/authorize?callback=${encodeURIComponent(
				callbackUrl,
			)}`;

			console.log(`\nPlease complete the OAuth flow in your browser.`);
			console.log(
				`If the browser doesn't open automatically, visit:\n${oauthUrl}\n`,
			);

			// Start a temporary server to receive the OAuth callback
			let tokenReceived: string | null = null;

			const server = await new Promise<any>((resolve) => {
				const s = http.createServer((req: any, res: any) => {
					if (req.url?.startsWith("/callback")) {
						const url = new URL(req.url, `http://localhost:${serverPort}`);
						tokenReceived = url.searchParams.get("token");

						res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
						res.end(`
            <html>
              <head>
                <meta charset="UTF-8">
              </head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h2>✅ Authorization successful!</h2>
                <p>You can close this window and return to your terminal.</p>
                <script>setTimeout(() => window.close(), 2000);</script>
              </body>
            </html>
          `);
					} else {
						res.writeHead(404);
						res.end("Not found");
					}
				});
				s.listen(serverPort, () => {
					console.log("Waiting for OAuth callback...");
					resolve(s);
				});
			});

			await open(oauthUrl);

			// Wait for the token with timeout
			const startTime = Date.now();
			while (!tokenReceived && Date.now() - startTime < 120000) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			server.close();

			const newToken = tokenReceived;

			if (!newToken || !(newToken as string).startsWith("lin_oauth_")) {
				this.logError("Invalid token received from OAuth flow");
				continue;
			}

			// Verify the new token
			const verifyResult = await checkLinearToken(newToken);
			if (!verifyResult.valid) {
				this.logError(`New token is invalid: ${verifyResult.error}`);
				continue;
			}

			// Update the workspace-level token in config
			this.app.config.update((cfg) => {
				if (!cfg.linearWorkspaces) {
					(cfg as Record<string, unknown>).linearWorkspaces = {};
				}
				cfg.linearWorkspaces![ws.id] = {
					linearToken: newToken,
					...(cfg.linearWorkspaces![ws.id]?.linearRefreshToken
						? {
								linearRefreshToken:
									cfg.linearWorkspaces![ws.id]!.linearRefreshToken,
							}
						: {}),
				};
				return cfg;
			});

			this.logSuccess(`Updated token for workspace ${ws.name}`);
		}

		this.logSuccess("Configuration saved");
		// PON-136: explicit exit — the env-file watcher otherwise keeps the
		// process alive forever (the incident-tooling hang, same fix as #16).
		process.exit(process.exitCode === 1 ? 1 : 0);
	}
}
