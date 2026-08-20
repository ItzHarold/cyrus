import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LinearClient } from "@linear/sdk";
import {
	DEFAULT_CONFIG_FILENAME,
	type EdgeConfig,
	migrateEdgeConfig,
} from "cyrus-core";
import Fastify, { type FastifyInstance } from "fastify";
import open from "open";
import { BaseCommand } from "./ICommand.js";

/**
 * Self-auth-linear command - authenticate with Linear OAuth directly from CLI
 * Handles the complete OAuth flow without requiring EdgeWorker
 */
export class SelfAuthCommand extends BaseCommand {
	private server: FastifyInstance | null = null;
	private callbackPort = parseInt(process.env.CYRUS_SERVER_PORT || "3456", 10);

	async execute(_args: string[]): Promise<void> {
		console.log("\nCyrus Linear Self-Authentication");
		this.logDivider();

		// Check required environment variables
		const clientId = process.env.LINEAR_CLIENT_ID;
		const clientSecret = process.env.LINEAR_CLIENT_SECRET;
		const baseUrl = process.env.CYRUS_BASE_URL;

		if (!clientId || !clientSecret || !baseUrl) {
			this.logError("Missing required environment variables:");
			if (!clientId) console.log("   - LINEAR_CLIENT_ID");
			if (!clientSecret) console.log("   - LINEAR_CLIENT_SECRET");
			if (!baseUrl) console.log("   - CYRUS_BASE_URL");
			console.log(`\nAdd these to your env file (${this.app.cyrusHome}/.env):`);
			console.log("  LINEAR_CLIENT_ID=your-client-id");
			console.log("  LINEAR_CLIENT_SECRET=your-client-secret");
			console.log("  CYRUS_BASE_URL=https://your-tunnel-domain.com");
			process.exit(1);
		}

		// Check config file exists
		const configPath = resolve(this.app.cyrusHome, DEFAULT_CONFIG_FILENAME);
		let config: EdgeConfig;
		try {
			config = migrateEdgeConfig(
				JSON.parse(readFileSync(configPath, "utf-8")),
			) as EdgeConfig;
		} catch {
			this.logError(`Config file not found: ${configPath}`);
			console.log("Run 'cyrus' first to create initial configuration.");
			process.exit(1);
		}

		console.log("Configuration:");
		console.log(`   Client ID: ${clientId.substring(0, 20)}...`);
		console.log(`   Base URL: ${baseUrl}`);
		console.log(`   Config: ${configPath}`);
		console.log(`   Callback port: ${this.callbackPort}`);
		console.log();

		try {
			if (process.env.CLOUDFLARE_TOKEN) {
				this.logger.info("Starting cloudflare tunnel...");

				const { SharedApplicationServer } = await import("cyrus-edge-worker");
				const sharedApplicationServer = new SharedApplicationServer(
					this.callbackPort,
					baseUrl,
					false,
				);
				await sharedApplicationServer.startCloudflareTunnel(
					process.env.CLOUDFLARE_TOKEN,
				);
			}

			// Prefer the running service's relay so authorising a workspace does
			// not require an outage (PON-126). Falls back to binding the port
			// ourselves when no service is up — which is the fresh-VM case.
			const authCode =
				(await this.viaRunningService(clientId)) ??
				(await this.waitForCallback(clientId));

			// Exchange code for tokens
			console.log("Exchanging code for tokens...");
			const tokens = await this.exchangeCodeForTokens(
				authCode,
				clientId,
				clientSecret,
			);
			this.logSuccess(
				`Got access token: ${tokens.accessToken.substring(0, 30)}...`,
			);

			// Fetch workspace info
			console.log("Fetching workspace info...");
			const workspace = await this.fetchWorkspaceInfo(tokens.accessToken);
			this.logSuccess(`Workspace: ${workspace.name} (${workspace.id})`);

			// Save workspace credentials to config.json
			console.log("Saving tokens to config.json...");
			if (!config.linearWorkspaces) {
				(config as Record<string, unknown>).linearWorkspaces = {};
			}
			// Preserve per-workspace settings on re-auth, but NOT a previous
			// deactivation: completing this flow is proof the workspace has
			// granted access again (PON-115). Without this, re-installing
			// after a revocation would store a working token in a tenant the
			// service still refuses to serve — the recovery path a real client
			// would take, silently doing nothing.
			const existingWorkspace = config.linearWorkspaces![workspace.id] as
				| (NonNullable<EdgeConfig["linearWorkspaces"]>[string] & {
						active?: boolean;
						revokedAt?: string;
				  })
				| undefined;
			const {
				active: _previouslyActive,
				revokedAt: _previouslyRevokedAt,
				...preservedSettings
			} = existingWorkspace ?? ({} as NonNullable<typeof existingWorkspace>);
			config.linearWorkspaces![workspace.id] = {
				...preservedSettings,
				linearToken: tokens.accessToken,
				...(tokens.refreshToken
					? { linearRefreshToken: tokens.refreshToken }
					: {}),
				linearWorkspaceName: workspace.name,
				linearWorkspaceSlug: workspace.slug,
				...(workspace.appUserId ? { appUserId: workspace.appUserId } : {}),
				installedAt: preservedSettings.installedAt ?? new Date().toISOString(),
			};
			// 0600: this file holds per-workspace Linear OAuth tokens.
			writeFileSync(configPath, JSON.stringify(config, null, "\t"), {
				encoding: "utf-8",
				mode: 0o600,
			});
			// mode only applies on create, so tighten pre-existing configs too.
			chmodSync(configPath, 0o600);

			this.logSuccess(`Saved credentials for workspace: ${workspace.name}`);
			if (!config.repositories || config.repositories.length === 0) {
				console.log(
					"   No repositories configured yet. Run 'cyrus self-add-repo' to add one.",
				);
			}

			console.log();
			this.logSuccess(
				"Authentication complete! Restart cyrus to use the new tokens.",
			);
			process.exit(0);
		} catch (error) {
			this.logError(`Authentication failed: ${(error as Error).message}`);
			process.exit(1);
		} finally {
			// One of the key guarantees of finally — it runs regardless of how the try block exits (return, throw, or normal completion).
			await this.cleanup();
		}
	}

	/**
	 * Authorise through the already-running service.
	 *
	 * The old flow bound CYRUS_SERVER_PORT to catch the redirect — the very
	 * port the service listens on — so onboarding a client meant stopping the
	 * service. With several lanes on one box, authorising one client would
	 * pause every other client's work.
	 *
	 * Here the running service catches the redirect and holds the code for us
	 * to collect. The token exchange and the config write stay in this command:
	 * the service never sees the client secret and never persists a credential.
	 *
	 * Returns null when there is no service to relay through, so the caller can
	 * fall back to the standalone flow.
	 */
	private async viaRunningService(clientId: string): Promise<string | null> {
		const baseUrl = process.env.CYRUS_BASE_URL;
		if (!baseUrl) return null;
		const local = `http://127.0.0.1:${this.callbackPort}`;

		let flow: { flowId: string; state: string };
		try {
			const res = await fetch(`${local}/admin/oauth/begin`, { method: "POST" });
			if (!res.ok) return null;
			const body = (await res.json()) as Partial<{
				flowId: string;
				state: string;
			}>;
			// A 200 is not enough. Something else entirely could be listening on
			// this port and answering happily — and without this check we would
			// take its response as a flow and then poll a stranger for fifteen
			// minutes. Only a body that actually looks like our relay counts;
			// anything else means "no relay here", so fall back.
			if (
				typeof body?.flowId !== "string" ||
				typeof body?.state !== "string" ||
				!body.flowId ||
				!body.state
			) {
				return null;
			}
			flow = { flowId: body.flowId, state: body.state };
		} catch {
			return null; // nothing listening — fresh box, use the standalone flow
		}

		const redirectUri = `${baseUrl}/callback`;
		const oauthUrl =
			`https://linear.app/oauth/authorize?client_id=${clientId}` +
			`&redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&response_type=code&scope=write,app:assignable,app:mentionable&actor=app` +
			`&state=${encodeURIComponent(flow.state)}`;

		console.log("Service is running — authorising without stopping it.");
		console.log();
		console.log("Visit:");
		console.log(oauthUrl);
		console.log();
		open(oauthUrl).catch(() => {
			console.log("Could not open browser automatically.");
		});

		// Matches the service's flow TTL. The first real run of this flow took
		// 7m03s to approve and the deadline was five minutes, so the CLI gave up
		// while the service was still holding a perfectly good code. Anything
		// shorter than the TTL strands approvals that arrive in between.
		const WINDOW_MS = 15 * 60 * 1000;
		const started = Date.now();
		const deadline = started + WINDOW_MS;
		let nextHeartbeat = started + 60_000;

		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2000));
			if (Date.now() >= nextHeartbeat) {
				const minutesLeft = Math.ceil((deadline - Date.now()) / 60_000);
				console.log(`Still waiting for approval... (${minutesLeft} min left)`);
				nextHeartbeat += 60_000;
			}
			try {
				const res = await fetch(
					`${local}/admin/oauth/result?flowId=${encodeURIComponent(flow.flowId)}`,
				);
				if (!res.ok) continue;
				const body = (await res.json()) as { code?: string; pending?: boolean };
				if (body.code) return body.code;
			} catch {
				// Transient — the service may be mid-restart. Keep waiting.
			}
		}
		// An approval landing just after the deadline used to be unrecoverable:
		// re-running mints a fresh state, so the held code could never be claimed
		// and the whole authorisation had to be redone. Name the flow so a late
		// approval can still be collected.
		throw new Error(
			`Timed out waiting for authorization after ${WINDOW_MS / 60_000} minutes.\n` +
				`   If you approved just now, the service may still hold the code briefly:\n` +
				`   curl -s "${local}/admin/oauth/result?flowId=${flow.flowId}"`,
		);
	}

	private async waitForCallback(clientId: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const baseUrl = process.env.CYRUS_BASE_URL;
			if (!baseUrl) {
				reject(new Error("CYRUS_BASE_URL environment variable is required"));
				return;
			}
			const redirectUri = `${baseUrl}/callback`;
			// https://linear.app/developers/oauth-2-0-authentication
			// https://linear.app/developers/oauth-actor-authorization
			const oauthUrl = `https://linear.app/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=write,app:assignable,app:mentionable&actor=app`;

			this.server = Fastify({ logger: false });

			this.server.get("/callback", async (request, reply) => {
				const query = request.query as { code?: string; error?: string };
				const code = query.code;
				const error = query.error;

				if (error) {
					reply
						.type("text/html; charset=utf-8")
						.code(400)
						.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: system-ui; padding: 40px; text-align: center;">
<h2>Authorization failed</h2>
<p>${error}</p>
</body></html>`);
					reject(new Error(`OAuth error: ${error}`));
					return;
				}

				if (code) {
					reply
						.type("text/html; charset=utf-8")
						.code(200)
						.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: system-ui; padding: 40px; text-align: center;">
<h2>Cyrus authorized successfully</h2>
<p>You can close this window and return to the terminal.</p>
</body></html>`);
					resolve(code);
					return;
				}

				reply
					.type("text/html; charset=utf-8")
					.code(400)
					.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: system-ui; padding: 40px; text-align: center;">
<h2>Missing authorization code</h2>
</body></html>`);
				reject(new Error("Missing authorization code"));
			});

			const isExternalHost =
				process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
			const listenHost = isExternalHost ? "0.0.0.0" : "localhost";

			this.server
				.listen({ port: this.callbackPort, host: listenHost })
				.then(() => {
					console.log(
						`Waiting for authorization on port ${this.callbackPort}...`,
					);
					console.log();
					console.log("Opening browser for Linear authorization...");
					console.log();
					console.log("If browser doesn't open, visit:");
					console.log(oauthUrl);
					console.log();

					open(oauthUrl).catch(() => {
						console.log("Could not open browser automatically.");
					});
				})
				.catch((err) => {
					reject(new Error(`Server error: ${err.message}`));
				});
		});
	}

	private async exchangeCodeForTokens(
		code: string,
		clientId: string,
		clientSecret: string,
	): Promise<{ accessToken: string; refreshToken?: string }> {
		const baseUrl = process.env.CYRUS_BASE_URL;
		const redirectUri = `${baseUrl}/callback`;

		// https://linear.app/developers/oauth-2-0-authentication
		const response = await fetch("https://api.linear.app/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				code,
				redirect_uri: redirectUri,
				client_id: clientId,
				client_secret: clientSecret,
				grant_type: "authorization_code",
			}).toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token exchange failed: ${errorText}`);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
		};

		if (!data.access_token?.startsWith("lin_oauth_")) {
			throw new Error("Invalid access token received");
		}

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
		};
	}

	private async fetchWorkspaceInfo(
		accessToken: string,
	): Promise<{ id: string; name: string; slug: string; appUserId?: string }> {
		const linearClient = new LinearClient({ accessToken });
		const viewer = await linearClient.viewer;
		const organization = await viewer.organization;

		if (!organization?.id) {
			throw new Error("Failed to get workspace info from Linear");
		}

		return {
			id: organization.id,
			name: organization.name || organization.id,
			slug: organization.urlKey,
			// Linear issues a distinct app-user id per install; storing it
			// alongside the token is how we identify ourselves in this tenant.
			...(viewer.id ? { appUserId: viewer.id } : {}),
		};
	}

	private async cleanup(): Promise<void> {
		if (this.server) {
			await this.server.close();
			this.server = null;
		}
	}
}
