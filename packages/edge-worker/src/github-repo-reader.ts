/**
 * Read a client's repository with nothing but the GitHub App token (PON-215).
 *
 * This is the whole access surface for an integration client: `contents:read`
 * and `deployments:read` on the one repository they installed us on. No
 * dashboard, no hosting credential, no cloud API. If discovery ever needs
 * something this reader cannot supply, that is the signal it has become a
 * question for the client rather than a check we can run.
 */

export interface GitHubRepoRef {
	owner: string;
	repo: string;
}

interface TreeEntry {
	path: string;
	type: string;
}

export function createGitHubRepoReader(
	token: string,
	ref: GitHubRepoRef,
	fetchImpl: typeof fetch = fetch,
) {
	const api = async <T>(path: string): Promise<T | undefined> => {
		try {
			const response = await fetchImpl(`https://api.github.com${path}`, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "cyrus-agent",
				},
			});
			if (!response.ok) return undefined;
			return (await response.json()) as T;
		} catch {
			return undefined;
		}
	};

	let treeCache: string[] | undefined;

	return {
		async file(path: string): Promise<string | undefined> {
			const data = await api<{ content?: string; encoding?: string }>(
				`/repos/${ref.owner}/${ref.repo}/contents/${encodeURI(path)}`,
			);
			if (!data?.content) return undefined;
			try {
				return Buffer.from(data.content, "base64").toString("utf8");
			} catch {
				return undefined;
			}
		},

		async paths(): Promise<string[]> {
			if (treeCache) return treeCache;
			const meta = await api<{ default_branch?: string }>(
				`/repos/${ref.owner}/${ref.repo}`,
			);
			const branch = meta?.default_branch ?? "main";
			const tree = await api<{ tree?: TreeEntry[] }>(
				`/repos/${ref.owner}/${ref.repo}/git/trees/${branch}?recursive=1`,
			);
			treeCache = (tree?.tree ?? [])
				.filter((e) => e.type === "blob")
				.map((e) => e.path);
			return treeCache;
		},

		/**
		 * Does a recent pull request's head commit have a preview deployment?
		 *
		 * Asked of PR heads rather than of the deployment list as a whole,
		 * because "this repository has deployments" and "every pull request
		 * gets one" are different claims and only the second one matters.
		 */
		async previewEvidence(): Promise<{
			found: boolean;
			detail: string;
			url?: string;
		}> {
			const prs = await api<Array<{ number: number; head: { sha: string } }>>(
				`/repos/${ref.owner}/${ref.repo}/pulls?state=all&per_page=5&sort=updated&direction=desc`,
			);
			if (!prs || prs.length === 0) {
				return {
					found: false,
					detail: "No pull requests found, so there is nothing to check yet.",
				};
			}
			for (const pr of prs) {
				const deployments = await api<Array<{ id: number }>>(
					`/repos/${ref.owner}/${ref.repo}/deployments?sha=${pr.head.sha}&per_page=5`,
				);
				if (!deployments || deployments.length === 0) continue;
				const first = deployments[0];
				if (!first) continue;
				const statuses = await api<
					Array<{ state: string; environment_url?: string | null }>
				>(
					`/repos/${ref.owner}/${ref.repo}/deployments/${first.id}/statuses?per_page=10`,
				);
				const withUrl = (statuses ?? []).find((s) => s.environment_url);
				if (withUrl?.environment_url) {
					return {
						found: true,
						detail: `PR #${pr.number} has a preview deployment.`,
						url: withUrl.environment_url,
					};
				}
			}
			return {
				found: false,
				detail: `Checked the ${prs.length} most recently updated pull requests; none had a preview deployment.`,
			};
		},
	};
}
