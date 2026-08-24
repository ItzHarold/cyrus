/**
 * Mark a draft GitHub pull request ready for review (PON-152). Draft→ready
 * has no REST endpoint — it is the GraphQL markPullRequestReadyForReview
 * mutation. Called ONLY from the operator's explicit approval; nothing else
 * in the system may flip a draft.
 */

const PR_URL =
	/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export interface ParsedPullRequestUrl {
	owner: string;
	repo: string;
	number: number;
}

export function parsePullRequestUrl(
	url: string,
): ParsedPullRequestUrl | undefined {
	const match = PR_URL.exec(url.trim());
	if (!match) return undefined;
	return {
		owner: match[1] as string,
		repo: match[2] as string,
		number: Number(match[3]),
	};
}

/**
 * Returns "ready" when the PR was flipped, "already-ready" when it was not a
 * draft, and throws on API failure — the caller reports honestly rather than
 * claiming a flip that did not happen.
 */
export async function markPullRequestReady(
	token: string,
	pr: ParsedPullRequestUrl,
): Promise<"ready" | "already-ready"> {
	const query = async <T>(
		q: string,
		variables: Record<string, unknown>,
	): Promise<T> => {
		const response = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "cyrus-agent",
			},
			body: JSON.stringify({ query: q, variables }),
		});
		const payload = (await response.json()) as {
			data?: T;
			errors?: Array<{ message: string }>;
		};
		if (!response.ok || payload.errors?.length || !payload.data) {
			throw new Error(
				`GitHub GraphQL error (${response.status}): ${payload.errors?.map((e) => e.message).join("; ") ?? "no data"}`,
			);
		}
		return payload.data;
	};

	const lookup = await query<{
		repository: { pullRequest: { id: string; isDraft: boolean } | null };
	}>(
		`query($owner: String!, $repo: String!, $number: Int!) {
			repository(owner: $owner, name: $repo) {
				pullRequest(number: $number) { id isDraft }
			}
		}`,
		{ owner: pr.owner, repo: pr.repo, number: pr.number },
	);
	const pullRequest = lookup.repository.pullRequest;
	if (!pullRequest) {
		throw new Error(
			`PR not found: ${pr.owner}/${pr.repo}#${pr.number} (token may lack access)`,
		);
	}
	if (!pullRequest.isDraft) return "already-ready";

	await query(
		`mutation($id: ID!) {
			markPullRequestReadyForReview(input: { pullRequestId: $id }) {
				pullRequest { isDraft }
			}
		}`,
		{ id: pullRequest.id },
	);
	return "ready";
}
