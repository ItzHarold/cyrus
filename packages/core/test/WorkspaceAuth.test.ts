import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_AUTH_ENV_KEYS,
	describeWorkspaceAuth,
	resolveWorkspaceAuthEnv,
	WorkspaceAuthNotDeclaredError,
	WorkspaceAuthUnavailableError,
} from "../src/WorkspaceAuth.js";

const WS = "95aa9b9b-cca1-42fb-b592-0b249213e9c1";

describe("resolveWorkspaceAuthEnv", () => {
	describe("undeclared workspace", () => {
		it("refuses rather than falling back to the process credential", () => {
			expect(() => resolveWorkspaceAuthEnv(undefined, WS)).toThrow(
				WorkspaceAuthNotDeclaredError,
			);
		});

		it("refuses even when the box has a perfectly good credential to offer", () => {
			// The point of the feature: a usable credential being available is not
			// a reason to use it for a tenant that did not ask for it.
			expect(() =>
				resolveWorkspaceAuthEnv(undefined, WS, {
					subscriptionToken: "sk-ant-oat-real",
				}),
			).toThrow(WorkspaceAuthNotDeclaredError);
		});

		it("names the workspace, so the error is actionable", () => {
			const err = (() => {
				try {
					resolveWorkspaceAuthEnv(undefined, WS, {
						workspaceName: "Ponte Digital",
					});
				} catch (e) {
					return e as WorkspaceAuthNotDeclaredError;
				}
			})();

			expect(err?.workspaceId).toBe(WS);
			expect(err?.message).toContain("Ponte Digital");
			expect(err?.message).toContain(WS);
			// Tells the operator what to do, not just that something is wrong.
			expect(err?.message).toContain("anthropicAuth");
			expect(err?.message).toMatch(/apiKey/);
			expect(err?.message).toMatch(/subscription/);
		});
	});

	describe("apiKey mode", () => {
		const auth = { mode: "apiKey", apiKey: "sk-ant-api03-example" } as const;

		it("sets the workspace key", () => {
			expect(resolveWorkspaceAuthEnv(auth, WS).ANTHROPIC_API_KEY).toBe(
				"sk-ant-api03-example",
			);
		});

		it("UNSETS the subscription token that would otherwise be inherited", () => {
			// The whole reason this returns a complete set rather than an overlay.
			// On a box holding a subscription token, leaving it present would let
			// SDK precedence decide what a keyed workspace actually runs on.
			const env = resolveWorkspaceAuthEnv(auth, WS, {
				subscriptionToken: "sk-ant-oat-should-not-leak",
			});

			expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(true); // present-as-unset
		});

		it("accounts for every auth variable the SDK would accept", () => {
			// If a fourth auth variable is ever added to the SDK, this fails and
			// someone has to decide about it — rather than it silently leaking
			// through as the one key nobody replaced.
			const env = resolveWorkspaceAuthEnv(auth, WS);
			for (const key of ANTHROPIC_AUTH_ENV_KEYS) {
				expect(Object.hasOwn(env, key)).toBe(true);
			}
			expect(Object.keys(env).sort()).toEqual(
				[...ANTHROPIC_AUTH_ENV_KEYS].sort(),
			);
		});
	});

	describe("subscription mode", () => {
		const auth = { mode: "subscription" } as const;

		it("uses the box token when the workspace declares it", () => {
			const env = resolveWorkspaceAuthEnv(auth, WS, {
				subscriptionToken: "sk-ant-oat-declared",
			});

			expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-declared");
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		});

		it("fails loudly when the box cannot supply what was declared", () => {
			// A declaration the box cannot honour is a misconfiguration, not a
			// reason to reach for something else.
			expect(() => resolveWorkspaceAuthEnv(auth, WS, {})).toThrow(
				WorkspaceAuthUnavailableError,
			);
		});

		it("does not silently degrade to an API key that happens to be present", () => {
			const err = (() => {
				try {
					resolveWorkspaceAuthEnv(auth, WS, {});
				} catch (e) {
					return e as WorkspaceAuthUnavailableError;
				}
			})();
			expect(err?.workspaceId).toBe(WS);
			expect(err?.message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		});
	});

	describe("two workspaces on one box", () => {
		it("gives each its declared credential and neither the other's", () => {
			// The scenario the dev box will actually run: Ponte Digital on the
			// subscription, FrontDoor Sandbox on a key, same process.
			const subscriptionToken = "sk-ant-oat-box";

			const devEnv = resolveWorkspaceAuthEnv(
				{ mode: "subscription" },
				"ponte-digital",
				{ subscriptionToken },
			);
			const sandboxEnv = resolveWorkspaceAuthEnv(
				{ mode: "apiKey", apiKey: "sk-ant-api03-sandbox" },
				"frontdoor-sandbox",
				{ subscriptionToken },
			);

			expect(devEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(subscriptionToken);
			expect(devEnv.ANTHROPIC_API_KEY).toBeUndefined();

			expect(sandboxEnv.ANTHROPIC_API_KEY).toBe("sk-ant-api03-sandbox");
			expect(sandboxEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		});
	});
});

describe("describeWorkspaceAuth", () => {
	it("never discloses the key", () => {
		const described = describeWorkspaceAuth({
			mode: "apiKey",
			apiKey: "sk-ant-api03-secret-value",
		});

		expect(described).not.toContain("secret");
		expect(described).not.toContain("sk-ant");
		expect(described).toBe("apiKey(len=25)");
	});

	it("distinguishes the three states for a journal line", () => {
		expect(describeWorkspaceAuth(undefined)).toBe("undeclared");
		expect(describeWorkspaceAuth({ mode: "subscription" })).toBe(
			"subscription",
		);
	});
});
