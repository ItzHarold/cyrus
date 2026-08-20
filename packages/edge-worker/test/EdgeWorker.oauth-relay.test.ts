import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(function () {
		return {
			initializeFastify: vi.fn(),
			getFastifyInstance: vi.fn().mockReturnValue({
				get: vi.fn(),
				post: vi.fn(),
			}),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
		};
	}),
}));
vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(function () {
		return {
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			getAllSessions: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn(),
			getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
			setActivitySink: vi.fn(),
			on: vi.fn(),
			emit: vi.fn(),
		};
	}),
}));
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn().mockReturnValue(false),
		isAgentSessionPromptedWebhook: vi.fn().mockReturnValue(false),
		isIssueAssignedWebhook: vi.fn().mockReturnValue(false),
		isIssueCommentMentionWebhook: vi.fn().mockReturnValue(false),
		isIssueNewCommentWebhook: vi.fn().mockReturnValue(false),
		isIssueUnassignedWebhook: vi.fn().mockReturnValue(false),
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

type Handler = (request: any, reply: any) => Promise<any>;

/** Captures what a handler actually replied with. */
function makeReply() {
	const captured: {
		status: number;
		body: any;
		contentType?: string;
	} = { status: 200, body: undefined };
	const reply = {
		status: vi.fn((code: number) => {
			captured.status = code;
			return reply;
		}),
		type: vi.fn((value: string) => {
			captured.contentType = value;
			return reply;
		}),
		send: vi.fn((body: any) => {
			captured.body = body;
			return reply;
		}),
	};
	return { reply, captured };
}

/** A request as it arrives from loopback with no proxy in front of it. */
function localRequest(query: Record<string, string> = {}) {
	return { ip: "127.0.0.1", headers: {}, query };
}

describe("EdgeWorker - OAuth relay (PON-126)", () => {
	let edgeWorker: EdgeWorker;
	let routes: Map<string, Handler>;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
	};

	const mockConfig: EdgeWorkerConfig = {
		platform: "linear",
		cyrusHome: "/test/.cyrus",
		repositories: [mockRepository],
		linearWorkspaces: {
			"test-workspace": { linearToken: "test-token" },
		},
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		routes = new Map();
		const capture = (path: string, handler: Handler) => {
			routes.set(path, handler);
		};
		const mockFastify = {
			get: vi.fn((path: string, handler: Handler) => capture(path, handler)),
			post: vi.fn((path: string, handler: Handler) => capture(path, handler)),
		};

		const { SharedApplicationServer } = await import(
			"../src/SharedApplicationServer.js"
		);
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				initializeFastify: vi.fn(),
				getFastifyInstance: vi.fn().mockReturnValue(mockFastify),
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
			};
		} as any);

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).registerOAuthRelayEndpoints();
	});

	afterEach(async () => {
		if (edgeWorker) {
			try {
				await edgeWorker.stop();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	/** Runs the begin handler and returns the issued flow. */
	async function begin(): Promise<{ flowId: string; state: string }> {
		const { reply, captured } = makeReply();
		await routes.get("/admin/oauth/begin")!(localRequest(), reply);
		expect(captured.status).toBe(200);
		return captured.body;
	}

	describe("route registration", () => {
		it("registers begin, result, and the public callback", () => {
			expect(routes.has("/admin/oauth/begin")).toBe(true);
			expect(routes.has("/admin/oauth/result")).toBe(true);
			expect(routes.has("/callback")).toBe(true);
		});
	});

	describe("admin guard", () => {
		// Caddy proxies public traffic from loopback, so request.ip alone is not
		// enough to tell a local operator from the whole internet. Every one of
		// these headers means something else terminated the connection.
		const forwardingHeaders = [
			"x-forwarded-for",
			"x-forwarded-proto",
			"x-forwarded-host",
			"x-real-ip",
			"forwarded",
		];

		for (const header of forwardingHeaders) {
			it(`404s the begin route when ${header} is present, even from loopback`, async () => {
				const { reply, captured } = makeReply();
				await routes.get("/admin/oauth/begin")!(
					{ ip: "127.0.0.1", headers: { [header]: "1.2.3.4" }, query: {} },
					reply,
				);

				expect(captured.status).toBe(404);
				expect(captured.body).toEqual({ error: "Not found" });
				// The refusal must not have minted a flow.
				expect((edgeWorker as any).oauthRelayFlows.size).toBe(0);
			});

			it(`404s the result route when ${header} is present`, async () => {
				const flow = await begin();
				const { reply, captured } = makeReply();
				await routes.get("/admin/oauth/result")!(
					{
						ip: "127.0.0.1",
						headers: { [header]: "1.2.3.4" },
						query: { flowId: flow.flowId },
					},
					reply,
				);

				expect(captured.status).toBe(404);
			});
		}

		for (const ip of ["10.0.0.5", "203.0.113.9", "::ffff:10.0.0.5"]) {
			it(`404s the begin route from non-loopback ${ip}`, async () => {
				const { reply, captured } = makeReply();
				await routes.get("/admin/oauth/begin")!(
					{ ip, headers: {}, query: {} },
					reply,
				);

				expect(captured.status).toBe(404);
				expect((edgeWorker as any).oauthRelayFlows.size).toBe(0);
			});
		}

		for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			it(`allows the begin route from loopback ${ip}`, async () => {
				const { reply, captured } = makeReply();
				await routes.get("/admin/oauth/begin")!(
					{ ip, headers: {}, query: {} },
					reply,
				);

				expect(captured.status).toBe(200);
				expect(captured.body).toHaveProperty("flowId");
				expect(captured.body).toHaveProperty("state");
			});
		}

		it("does not 404 merely because unrelated headers are present", async () => {
			const { reply, captured } = makeReply();
			await routes.get("/admin/oauth/begin")!(
				{
					ip: "127.0.0.1",
					headers: { "user-agent": "curl/8.5.0", accept: "*/*" },
					query: {},
				},
				reply,
			);

			expect(captured.status).toBe(200);
		});
	});

	describe("begin", () => {
		it("issues a distinct flowId and state per call", async () => {
			const first = await begin();
			const second = await begin();

			expect(first.flowId).not.toBe(second.flowId);
			expect(first.state).not.toBe(second.state);
			// state must not be derivable from flowId — it is the only thing
			// standing between the callback and an attacker-supplied code.
			expect(first.state).not.toBe(first.flowId);
			expect((edgeWorker as any).oauthRelayFlows.size).toBe(2);
		});

		it("stores the flow without a code until the callback arrives", async () => {
			const flow = await begin();
			const stored = (edgeWorker as any).oauthRelayFlows.get(flow.flowId);

			expect(stored.state).toBe(flow.state);
			expect(stored.code).toBeUndefined();
		});
	});

	describe("callback", () => {
		it("accepts a code for a state issued by begin", async () => {
			const flow = await begin();
			const { reply, captured } = makeReply();

			await routes.get("/callback")!(
				{ query: { code: "auth-code-123", state: flow.state }, headers: {} },
				reply,
			);

			expect(captured.status).toBe(200);
			expect(captured.contentType).toContain("text/html");
			expect((edgeWorker as any).oauthRelayFlows.get(flow.flowId).code).toBe(
				"auth-code-123",
			);
		});

		it("refuses a code whose state was never issued", async () => {
			await begin();
			const { reply, captured } = makeReply();

			await routes.get("/callback")!(
				{
					query: { code: "attacker-code", state: "not-a-real-state" },
					headers: {},
				},
				reply,
			);

			expect(captured.status).toBe(400);
			// Nothing was stored against the legitimate pending flow.
			const flows = [...(edgeWorker as any).oauthRelayFlows.values()];
			expect(flows.every((f: any) => f.code === undefined)).toBe(true);
		});

		it("refuses a code with no state at all", async () => {
			await begin();
			const { reply, captured } = makeReply();

			await routes.get("/callback")!(
				{ query: { code: "attacker-code" }, headers: {} },
				reply,
			);

			expect(captured.status).toBe(400);
		});

		it("refuses a state with no code", async () => {
			const flow = await begin();
			const { reply, captured } = makeReply();

			await routes.get("/callback")!(
				{ query: { state: flow.state }, headers: {} },
				reply,
			);

			expect(captured.status).toBe(400);
			expect(
				(edgeWorker as any).oauthRelayFlows.get(flow.flowId).code,
			).toBeUndefined();
		});

		it("is reachable without the admin guard, since Linear must reach it", async () => {
			const flow = await begin();
			const { reply, captured } = makeReply();

			// Exactly what arrives through Caddy: public IP, forwarding headers.
			await routes.get("/callback")!(
				{
					ip: "203.0.113.9",
					headers: { "x-forwarded-for": "203.0.113.9" },
					query: { code: "auth-code-123", state: flow.state },
				},
				reply,
			);

			expect(captured.status).toBe(200);
		});
	});

	describe("result", () => {
		it("404s an unknown flowId", async () => {
			const { reply, captured } = makeReply();
			await routes.get("/admin/oauth/result")!(
				localRequest({ flowId: "no-such-flow" }),
				reply,
			);

			expect(captured.status).toBe(404);
			expect(captured.body).toEqual({ error: "Unknown flow" });
		});

		it("404s when no flowId is supplied", async () => {
			await begin();
			const { reply, captured } = makeReply();
			await routes.get("/admin/oauth/result")!(localRequest(), reply);

			expect(captured.status).toBe(404);
		});

		it("reports pending while the operator is still at the consent screen", async () => {
			const flow = await begin();
			const { reply, captured } = makeReply();

			await routes.get("/admin/oauth/result")!(
				localRequest({ flowId: flow.flowId }),
				reply,
			);

			expect(captured.status).toBe(200);
			expect(captured.body).toEqual({ pending: true });
			// Still claimable — a pending read must not consume the flow.
			expect((edgeWorker as any).oauthRelayFlows.has(flow.flowId)).toBe(true);
		});

		it("surrenders the code once, then forgets the flow", async () => {
			const flow = await begin();
			await routes.get("/callback")!(
				{ query: { code: "auth-code-123", state: flow.state }, headers: {} },
				makeReply().reply,
			);

			const first = makeReply();
			await routes.get("/admin/oauth/result")!(
				localRequest({ flowId: flow.flowId }),
				first.reply,
			);
			expect(first.captured.status).toBe(200);
			expect(first.captured.body).toEqual({ code: "auth-code-123" });

			// Single use: a replayed read gets nothing.
			const second = makeReply();
			await routes.get("/admin/oauth/result")!(
				localRequest({ flowId: flow.flowId }),
				second.reply,
			);
			expect(second.captured.status).toBe(404);
			expect((edgeWorker as any).oauthRelayFlows.has(flow.flowId)).toBe(false);
		});

		it("never returns a token — only the authorization code", async () => {
			const flow = await begin();
			await routes.get("/callback")!(
				{ query: { code: "auth-code-123", state: flow.state }, headers: {} },
				makeReply().reply,
			);

			const { reply, captured } = makeReply();
			await routes.get("/admin/oauth/result")!(
				localRequest({ flowId: flow.flowId }),
				reply,
			);

			// The exchange belongs to the CLI. If a token ever appears here, the
			// service has started holding credentials it was designed never to see.
			expect(Object.keys(captured.body)).toEqual(["code"]);
		});
	});

	describe("expiry", () => {
		/** Backdates a flow so the sweep treats it as expired. */
		function age(flowId: string, minutes: number) {
			const flow = (edgeWorker as any).oauthRelayFlows.get(flowId);
			flow.createdAt = Date.now() - minutes * 60 * 1000;
		}

		it("still accepts an approval at 14 minutes", async () => {
			// The first real run of this flow took 7m03s at the consent screen.
			// A window that expires before a human can read a scope list is the
			// bug this guards against (PON-126).
			const flow = await begin();
			age(flow.flowId, 14);

			const { reply, captured } = makeReply();
			await routes.get("/callback")!(
				{ query: { code: "auth-code-123", state: flow.state }, headers: {} },
				reply,
			);

			expect(captured.status).toBe(200);
		});

		it("refuses an approval at 16 minutes", async () => {
			const flow = await begin();
			age(flow.flowId, 16);

			const { reply, captured } = makeReply();
			await routes.get("/callback")!(
				{ query: { code: "auth-code-123", state: flow.state }, headers: {} },
				reply,
			);

			expect(captured.status).toBe(400);
			expect((edgeWorker as any).oauthRelayFlows.has(flow.flowId)).toBe(false);
		});

		it("sweeps expired flows without disturbing live ones", async () => {
			const stale = await begin();
			const live = await begin();
			age(stale.flowId, 20);

			// begin() sweeps before minting.
			await begin();

			expect((edgeWorker as any).oauthRelayFlows.has(stale.flowId)).toBe(false);
			expect((edgeWorker as any).oauthRelayFlows.has(live.flowId)).toBe(true);
		});

		it("holds a code long enough for the CLI's full polling window", async () => {
			// Regression guard for the failure that made this fix necessary: the
			// CLI polled for 5 minutes while the service held codes for 10, so an
			// approval landing in between was stranded — begin() mints a fresh
			// state, so a re-run could never claim it. The service TTL must stay
			// >= the CLI's window (SelfAuthCommand.viaRunningService, 15 min).
			const CLI_POLL_WINDOW_MINUTES = 15;
			const flow = await begin();
			age(flow.flowId, CLI_POLL_WINDOW_MINUTES - 1);

			const { reply, captured } = makeReply();
			await routes.get("/callback")!(
				{ query: { code: "late-but-valid", state: flow.state }, headers: {} },
				reply,
			);

			expect(captured.status).toBe(200);

			const result = makeReply();
			await routes.get("/admin/oauth/result")!(
				localRequest({ flowId: flow.flowId }),
				result.reply,
			);
			expect(result.captured.body).toEqual({ code: "late-but-valid" });
		});
	});
});
