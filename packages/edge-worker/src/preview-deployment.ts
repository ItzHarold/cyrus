/**
 * The preview link (PON-212).
 *
 * Reviewing happens by clicking through a running deployment, not by reading a
 * diff — so a mirror without a preview link is missing the main thing the
 * reviewer came for.
 *
 * Vercel reports a preview two ways on a pull request and only one of them is
 * useful. The commit STATUS (context "Vercel") carries a `target_url` pointing
 * at the Vercel dashboard, which needs a Vercel account and is not the site.
 * The GitHub DEPLOYMENT status carries `environment_url` — the preview itself —
 * plus a state we can report honestly.
 *
 * Read with the GitHub App token we already hold: no Vercel credential, no new
 * secret, and nothing to configure per tenant. That matters because we do not
 * hold client Vercel credentials and are not going to start.
 */

export type PreviewState =
	| "building"
	| "ready"
	| "failed"
	/** The repository has no preview deployments at all. */
	| "none";

export interface PreviewDeployment {
	state: PreviewState;
	/** The running site. Only set when state is "ready". */
	url?: string;
	/** Where to look when a build failed — logs, not a broken page. */
	logUrl?: string;
	/** The commit this deployment is for. */
	sha?: string;
}

interface GitHubDeployment {
	id: number;
	sha: string;
	environment: string;
	created_at: string;
}

interface GitHubDeploymentStatus {
	state: string;
	environment_url?: string | null;
	log_url?: string | null;
	target_url?: string | null;
	created_at: string;
}

/**
 * Map GitHub's deployment-status vocabulary onto what a reviewer needs to
 * know. `inactive` is deliberately NOT "ready": it means superseded, and
 * pointing someone at a superseded deployment is how you review the wrong
 * thing.
 */
function toPreviewState(state: string): PreviewState | undefined {
	switch (state) {
		case "success":
			return "ready";
		case "queued":
		case "pending":
		case "in_progress":
			return "building";
		case "failure":
		case "error":
			return "failed";
		default:
			return undefined;
	}
}

/**
 * The current preview for a commit.
 *
 * Returns `none` when the repository has no preview deployment for this commit
 * — which is a real answer (a repo deployed by hand has none), not an error.
 * Returns undefined only when we could not find out, so the caller can say
 * "could not check" rather than "there isn't one": those are different facts
 * and a reviewer acts differently on each.
 */
export async function fetchPreviewDeployment(
	token: string,
	repo: { owner: string; repo: string },
	sha: string,
	fetchImpl: typeof fetch = fetch,
): Promise<PreviewDeployment | undefined> {
	const api = async <T>(path: string): Promise<T | undefined> => {
		const response = await fetchImpl(`https://api.github.com${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "cyrus-agent",
			},
		});
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	};

	try {
		const deployments = await api<GitHubDeployment[]>(
			`/repos/${repo.owner}/${repo.repo}/deployments?sha=${sha}&per_page=10`,
		);
		if (!deployments) return undefined;
		// A repo with no preview environment is a supported shape, not a
		// failure: say so once, rather than leaving a silent gap that reads
		// identically to a broken lookup.
		if (deployments.length === 0) return { state: "none", sha };

		// Newest first — GitHub returns them that way, but do not rely on it.
		const newest = [...deployments].sort(
			(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
		)[0];
		if (!newest) return { state: "none", sha };

		const statuses = await api<GitHubDeploymentStatus[]>(
			`/repos/${repo.owner}/${repo.repo}/deployments/${newest.id}/statuses?per_page=20`,
		);
		if (!statuses || statuses.length === 0) {
			// A deployment exists but has not reported yet — that is building,
			// not missing.
			return { state: "building", sha: newest.sha };
		}
		const latest = [...statuses].sort(
			(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
		)[0];
		if (!latest) return { state: "building", sha: newest.sha };

		const state = toPreviewState(latest.state);
		if (!state) return { state: "building", sha: newest.sha };
		return {
			state,
			sha: newest.sha,
			...(state === "ready" && latest.environment_url
				? { url: latest.environment_url }
				: {}),
			...(state === "failed"
				? { logUrl: latest.log_url ?? latest.target_url ?? undefined }
				: {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * One line for the mirror body.
 *
 * A link that 404s during a build is worse than no link — it teaches the
 * reviewer that the link lies — so a building deployment is named as building
 * and offers nothing to click.
 */
export function renderPreview(preview: PreviewDeployment | undefined): string {
	if (!preview) {
		return "**Preview:** couldn't check right now — the deployment status was unreadable.";
	}
	const at = preview.sha ? ` (\`${preview.sha.slice(0, 7)}\`)` : "";
	switch (preview.state) {
		case "ready":
			return preview.url
				? `**Preview:** ${preview.url}${at} — open it and click through.`
				: `**Preview:** ready${at}, but the deployment did not publish a URL.`;
		case "building":
			return `**Preview:** building${at} — the link appears here when it finishes.`;
		case "failed":
			return preview.logUrl
				? `**Preview:** the build **failed**${at} — ${preview.logUrl}`
				: `**Preview:** the build **failed**${at}.`;
		case "none":
			return "**Preview:** this repository has no preview deployments, so review from the diff.";
	}
}
