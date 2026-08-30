import { describe, expect, it, vi } from "vitest";
import {
	fetchPreviewDeployment,
	renderPreview,
} from "../src/preview-deployment.js";

/**
 * The preview link (PON-212).
 *
 * Reviewing happens by clicking through a running deployment. The failure this
 * guards against is not "no link" — it is a link that lies: pointing the
 * reviewer at a URL that 404s mid-build, or at a superseded deployment, teaches
 * them not to trust it.
 */

const REPO = { owner: "acme", repo: "webapp" };
const SHA = "c097ef8f8e865118663d8cf0a23518ce7680d374";

function githubApi(
	routes: Record<string, unknown>,
	/** How the preview URL itself answers: open, login-walled, or unreachable. */
	preview: "open" | "protected" | "unreachable" = "open",
) {
	return vi.fn(async (url: string) => {
		const raw = String(url);
		if (!raw.startsWith("https://api.github.com")) {
			if (preview === "unreachable") throw new Error("network");
			return {
				ok: true,
				status: preview === "protected" ? 302 : 200,
				headers: {
					get: (h: string) =>
						h.toLowerCase() === "location" && preview === "protected"
							? "https://vercel.com/sso-api?url=x&nonce=y"
							: null,
				},
			};
		}
		const path = raw.replace("https://api.github.com", "");
		const key = Object.keys(routes).find((k) => path.startsWith(k));
		if (!key) return { ok: false, status: 404, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => routes[key] };
	}) as unknown as typeof fetch;
}

const deployment = {
	id: 1,
	sha: SHA,
	environment: "Preview",
	created_at: "2026-08-29T15:38:20Z",
};

describe("preview deployment", () => {
	it("reads the running site from the deployment status, not the dashboard link", async () => {
		// The commit status's target_url points at vercel.com and needs an
		// account; environment_url is the site itself. Using the wrong one
		// sends the reviewer to a login page.
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({
				"/repos/acme/webapp/deployments?sha=": [deployment],
				"/repos/acme/webapp/deployments/1/statuses": [
					{
						state: "success",
						environment_url: "https://webapp-abc.vercel.app",
						target_url: "https://vercel.com/acme/webapp/XYZ",
						created_at: "2026-08-29T15:40:00Z",
					},
				],
			}),
		);
		expect(result).toEqual({
			state: "ready",
			sha: SHA,
			url: "https://webapp-abc.vercel.app",
		});
	});

	it("catches a preview the client cannot open (PON-206)", async () => {
		// Vercel Authentication is on by default for paid teams, and a
		// protected deployment reports `success` exactly like an open one — so
		// without probing we render a confident link onto a login page.
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi(
				{
					"/repos/acme/webapp/deployments?sha=": [deployment],
					"/repos/acme/webapp/deployments/1/statuses": [
						{
							state: "success",
							environment_url: "https://webapp-abc.vercel.app",
							created_at: "2026-08-29T15:40:00Z",
						},
					],
				},
				"protected",
			),
		);
		expect(result?.state).toBe("protected");
		// The URL is still reported — the operator can open it, and it is the
		// evidence for the onboarding step that was skipped.
		expect(result?.url).toBe("https://webapp-abc.vercel.app");
		expect(renderPreview(result)).toContain("asks for a Vercel login");
	});

	it("does not call a preview protected just because the probe failed", async () => {
		// "we could not check" and "your client cannot open this" are different
		// facts, and the second one accuses the client of a misconfiguration.
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi(
				{
					"/repos/acme/webapp/deployments?sha=": [deployment],
					"/repos/acme/webapp/deployments/1/statuses": [
						{
							state: "success",
							environment_url: "https://webapp-abc.vercel.app",
							created_at: "2026-08-29T15:40:00Z",
						},
					],
				},
				"unreachable",
			),
		);
		expect(result?.state).toBe("ready");
	});

	it("reports a build in progress rather than a URL that is not up yet", async () => {
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({
				"/repos/acme/webapp/deployments?sha=": [deployment],
				"/repos/acme/webapp/deployments/1/statuses": [
					{ state: "in_progress", created_at: "2026-08-29T15:39:00Z" },
				],
			}),
		);
		expect(result?.state).toBe("building");
		expect(result?.url).toBeUndefined();
	});

	it("treats a deployment that has not reported yet as building, not missing", async () => {
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({
				"/repos/acme/webapp/deployments?sha=": [deployment],
				"/repos/acme/webapp/deployments/1/statuses": [],
			}),
		);
		expect(result?.state).toBe("building");
	});

	it("points at logs when the build failed", async () => {
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({
				"/repos/acme/webapp/deployments?sha=": [deployment],
				"/repos/acme/webapp/deployments/1/statuses": [
					{
						state: "failure",
						log_url: "https://vercel.com/acme/webapp/logs/1",
						created_at: "2026-08-29T15:39:00Z",
					},
				],
			}),
		);
		expect(result?.state).toBe("failed");
		expect(result?.logUrl).toContain("logs");
	});

	it("does not offer a superseded deployment as ready", async () => {
		// `inactive` means replaced. Linking it is how a reviewer approves the
		// wrong build.
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({
				"/repos/acme/webapp/deployments?sha=": [deployment],
				"/repos/acme/webapp/deployments/1/statuses": [
					{
						state: "inactive",
						environment_url: "https://old.vercel.app",
						created_at: "2026-08-29T15:39:00Z",
					},
				],
			}),
		);
		expect(result?.url).toBeUndefined();
	});

	it("says a repo has no previews, distinctly from failing to check", async () => {
		const none = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({ "/repos/acme/webapp/deployments?sha=": [] }),
		);
		expect(none).toEqual({ state: "none", sha: SHA });

		const unknown = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({}),
		);
		expect(unknown).toBeUndefined();
	});

	it("names a missing permission instead of calling it an outage", async () => {
		// The live cause on day one: the App had contents/pull_requests but not
		// deployments, so every lookup 403'd and the mirror said "couldn't
		// check" — which sends someone hunting for a problem that is not there.
		const forbidden = vi.fn(async () => ({
			ok: false,
			status: 403,
			json: async () => ({}),
		})) as unknown as typeof fetch;

		const result = await fetchPreviewDeployment("tok", REPO, SHA, forbidden);

		expect(result?.state).toBe("no-access");
		expect(renderPreview(result)).toContain("deployments: read");
	});

	it("uses the newest deployment when several exist for a commit", async () => {
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			githubApi({
				"/repos/acme/webapp/deployments?sha=": [
					{ ...deployment, id: 1, created_at: "2026-08-29T10:00:00Z" },
					{ ...deployment, id: 2, created_at: "2026-08-29T15:00:00Z" },
				],
				"/repos/acme/webapp/deployments/2/statuses": [
					{
						state: "success",
						environment_url: "https://newest.vercel.app",
						created_at: "2026-08-29T15:05:00Z",
					},
				],
			}),
		);
		expect(result?.url).toBe("https://newest.vercel.app");
	});
});

describe("preview rendering", () => {
	it("offers nothing to click while building", () => {
		const line = renderPreview({ state: "building", sha: SHA });
		expect(line).toContain("building");
		expect(line).not.toContain("http");
	});

	it("distinguishes no-preview from could-not-check", () => {
		expect(renderPreview({ state: "none" })).toContain(
			"no preview deployments",
		);
		expect(renderPreview(undefined)).toContain("couldn't check");
	});

	it("gives the URL when it is genuinely up", () => {
		expect(
			renderPreview({ state: "ready", url: "https://x.vercel.app", sha: SHA }),
		).toContain("https://x.vercel.app");
	});
});

/**
 * The bypass has to be judged on the link we publish (PON-213).
 *
 * Found live on Acme: the probe ran against the bare URL and the bypass was
 * appended afterwards, so the mirror was about to render a link that opens,
 * directly beside a warning that it does not, beside an instruction to change
 * a Vercel setting that was no longer the problem. A block that contradicts
 * itself on its headline item is worse than one that says nothing.
 */
describe("preview deployment — with a tenant bypass value", () => {
	/** A host where only the bypassed URL opens; GitHub answers normally. */
	function hostWhereOnlyBypassOpens(goodToken: string | null) {
		return vi.fn(async (url: string) => {
			const raw = String(url);
			if (!raw.startsWith("https://api.github.com")) {
				const ok =
					goodToken !== null &&
					raw.includes(`x-vercel-protection-bypass=${goodToken}`);
				return {
					ok: true,
					status: ok ? 200 : 302,
					headers: {
						get: (h: string) =>
							h.toLowerCase() === "location" && !ok
								? "https://vercel.com/sso-api?url=x"
								: null,
					},
				};
			}
			const path = raw.replace("https://api.github.com", "");
			const routes: Record<string, unknown> = {
				"/repos/acme/webapp/deployments?sha=": [deployment],
				"/repos/acme/webapp/deployments/1/statuses": [
					{
						state: "success",
						environment_url: "https://webapp-abc.vercel.app",
						created_at: "2026-08-29T15:40:00Z",
					},
				],
			};
			const key = Object.keys(routes).find((k) => path.startsWith(k));
			if (!key) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => routes[key] };
		}) as unknown as typeof fetch;
	}

	it("reports ready, and publishes the link that actually opens", async () => {
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			hostWhereOnlyBypassOpens("good"),
			"good",
		);
		expect(result?.state).toBe("ready");
		expect(result?.url).toContain("x-vercel-protection-bypass=good");
		// And the rendered line must not still be telling the reviewer the
		// preview asks for a login.
		expect(renderPreview(result)).not.toContain("asks for a login");
	});

	it("says the value is stale rather than blaming their Vercel setting", async () => {
		// The fix for a dead token is the opposite of the fix for protection
		// being on. Sending an operator to turn off Vercel Authentication when
		// the real problem is a regenerated secret wastes the one action they
		// were going to take.
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			hostWhereOnlyBypassOpens("good"),
			"stale",
		);
		expect(result?.state).toBe("bypass-failed");
		const rendered = renderPreview(result);
		expect(rendered).toContain("no longer opens it");
		expect(rendered).toContain("regenerate");
		expect(rendered).not.toContain("onboarding asks for it to be off");
		// It must not hand out a link carrying a value that does not work.
		expect(result?.url).not.toContain("x-vercel-protection-bypass");
	});

	it("leaves a tenant with no value on exactly today's behaviour", async () => {
		const result = await fetchPreviewDeployment(
			"tok",
			REPO,
			SHA,
			hostWhereOnlyBypassOpens("good"),
		);
		expect(result?.state).toBe("protected");
		expect(renderPreview(result)).toContain("asks for a Vercel login");
	});
});
