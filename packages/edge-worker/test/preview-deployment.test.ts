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

function githubApi(routes: Record<string, unknown>) {
	return vi.fn(async (url: string) => {
		const path = String(url).replace("https://api.github.com", "");
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
