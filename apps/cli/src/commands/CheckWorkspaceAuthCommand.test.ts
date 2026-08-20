import { beforeEach, describe, expect, it, vi } from "vitest";
import { CheckWorkspaceAuthCommand } from "./CheckWorkspaceAuthCommand.js";

/**
 * The point of this command is to answer "would a restart stop any workspace?"
 * without restarting. So the tests care about two things above all: that a
 * workspace which would refuse is reported as refusing, and that no key is ever
 * printed.
 */

const SUBSCRIPTION_TOKEN = "sk-ant-oat-box-token";
const SANDBOX_KEY = "sk-ant-api03-sandbox-key-value";

function makeApp(
	linearWorkspaces: Record<string, unknown>,
	exists = true,
	sink: string[] = [],
) {
	// BaseCommand takes its logger from the Application, and every helper
	// (success/error/divider) goes through it — so the fake must supply one, and
	// the leak assertions must read it as well as console.log.
	return {
		logger: {
			success: (m: string) => sink.push(m),
			error: (m: string) => sink.push(m),
			info: (m: string) => sink.push(m),
			warn: (m: string) => sink.push(m),
			divider: () => sink.push("─".repeat(50)),
		},
		config: {
			exists: () => exists,
			load: () => ({ repositories: [], linearWorkspaces }),
		},
	} as never;
}

describe("CheckWorkspaceAuthCommand", () => {
	let out: string[];
	let exitCode: number | undefined;

	beforeEach(() => {
		out = [];
		exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation((...args) => {
			out.push(args.join(" "));
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCode = code;
			throw new Error("process.exit called");
		}) as never);
		process.env.CLAUDE_CODE_OAUTH_TOKEN = SUBSCRIPTION_TOKEN;
	});

	const run = async (app: unknown) => {
		// `out` already receives console.log; the fake logger pushes into it too,
		// via the shared sink passed to makeApp.
		try {
			await new CheckWorkspaceAuthCommand(app as never).execute([]);
		} catch (e) {
			if ((e as Error).message !== "process.exit called") throw e;
		}
		return out.join("\n");
	};

	it("passes every workspace that declares a credential", async () => {
		const text = await run(
			makeApp(
				{
					ws1: {
						linearWorkspaceName: "Ponte Digital",
						anthropicAuth: { mode: "subscription" },
					},
					ws2: {
						linearWorkspaceName: "FrontDoor Sandbox",
						anthropicAuth: { mode: "apiKey", apiKey: SANDBOX_KEY },
					},
				},
				true,
				out,
			),
		);

		expect(text).toContain("✅ Ponte Digital");
		expect(text).toContain("✅ FrontDoor Sandbox");
		expect(exitCode).toBe(0);
	});

	it("reports an undeclared workspace as refusing, and exits non-zero", async () => {
		// The whole reason the command exists: this is the state that turns a
		// restart into an outage for that workspace.
		const text = await run(
			makeApp(
				{
					ws1: {
						linearWorkspaceName: "Declared",
						anthropicAuth: { mode: "subscription" },
					},
					ws2: { linearWorkspaceName: "Undeclared" },
				},
				true,
				out,
			),
		);

		expect(text).toContain("❌ Undeclared");
		expect(text).toContain("no anthropicAuth declared");
		expect(text).toContain("1 of 2 workspace(s) would refuse");
		expect(exitCode).toBe(1);
	});

	it("reports a subscription workspace as refusing when the box has no token", async () => {
		// A declaration the box cannot satisfy is a misconfiguration, and running
		// this in a shell without the service's environment must say so rather
		// than quietly passing.
		process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined as never;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

		const text = await run(
			makeApp(
				{
					ws1: {
						linearWorkspaceName: "Subscribed",
						anthropicAuth: { mode: "subscription" },
					},
				},
				true,
				out,
			),
		);

		expect(text).toContain("❌ Subscribed");
		expect(exitCode).toBe(1);
	});

	describe("never discloses a credential", () => {
		it("prints only the length of an API key", async () => {
			const text = await run(
				makeApp(
					{
						ws1: {
							linearWorkspaceName: "Sandbox",
							anthropicAuth: { mode: "apiKey", apiKey: SANDBOX_KEY },
						},
					},
					true,
					out,
				),
			);

			expect(text).not.toContain(SANDBOX_KEY);
			expect(text).not.toContain("sk-ant");
			expect(text).toContain(`apiKey(len=${SANDBOX_KEY.length})`);
		});

		it("does not leak the subscription token either", async () => {
			const text = await run(
				makeApp(
					{
						ws1: {
							linearWorkspaceName: "Ponte Digital",
							anthropicAuth: { mode: "subscription" },
						},
					},
					true,
					out,
				),
			);

			expect(text).not.toContain(SUBSCRIPTION_TOKEN);
			expect(text).toContain("subscription");
		});

		it("does not leak a key in the refusal path either", async () => {
			// A malformed declaration must not print the value while explaining
			// what is wrong with it.
			const text = await run(
				makeApp(
					{
						ws1: {
							linearWorkspaceName: "Broken",
							anthropicAuth: { mode: "apiKey", apiKey: "" },
						},
					},
					true,
					out,
				),
			);

			expect(text).not.toContain(SANDBOX_KEY);
			expect(text).not.toContain(SUBSCRIPTION_TOKEN);
		});
	});

	it("handles a config with no workspaces without failing", async () => {
		const text = await run(makeApp({}, true, out));
		expect(text).toContain("No Linear workspaces configured");
	});

	it("errors when there is no configuration at all", async () => {
		await run(makeApp({}, false, out));
		expect(exitCode).toBe(1);
	});
});
