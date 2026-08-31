import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appBotIdentity,
	resetAppBotIdentityCache,
} from "../src/GitHubAppGitAuth.js";

/**
 * PON-232: the App bot identity lookup authenticated with the wrong thing.
 *
 * An App JWT authenticates the app and is only accepted on the /app family
 * of endpoints. Sending it to /users/:login returns 401, which is what every
 * session had been getting — "Could not resolve the App bot identity" —
 * leaving commits attributed to nobody in particular. The endpoint is
 * public, so no credential is the right credential.
 */

const PEM_PATH = "/tmp/pon232-test-key.pem";

// A throwaway key generated for this test only; it signs a JWT that is never
// sent anywhere real, because the /app call is mocked.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
writeFileSync(
	PEM_PATH,
	privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
);

afterEach(() => {
	resetAppBotIdentityCache();
	vi.unstubAllGlobals();
});

describe("appBotIdentity", () => {
	it("asks for the public user WITHOUT the App JWT", async () => {
		const seen: Array<{ url: string; auth?: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
				seen.push({ url, auth: init.headers.Authorization });
				if (url.endsWith("/app"))
					return { ok: true, json: async () => ({ slug: "ponte-digital" }) };
				return { ok: true, json: async () => ({ id: 12345 }) };
			}),
		);

		const identity = await appBotIdentity({
			appId: "app-1",
			privateKeyPath: PEM_PATH,
		} as never);

		const appCall = seen.find((c) => c.url.endsWith("/app"));
		const userCall = seen.find((c) => c.url.includes("/users/"));
		// The app call is authenticated — that is what a JWT is for.
		expect(appCall?.auth).toMatch(/^Bearer /);
		// The user call is not, because a JWT there is a 401.
		expect(userCall?.auth).toBeUndefined();
		expect(identity).toEqual({
			name: "ponte-digital[bot]",
			email: "12345+ponte-digital[bot]@users.noreply.github.com",
		});
	});
});
