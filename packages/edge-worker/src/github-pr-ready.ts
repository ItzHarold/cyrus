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

/**
 * Is this pull request still a draft (PON-208)?
 *
 * The cockpit used to LABEL links "PR (draft)" without ever asking. That is
 * fine right up until it is wrong — the one thing the operator is deciding is
 * whether the client should see this work, and a PR that quietly went ready
 * has already shown it to them. Read-only, and deliberately undefined rather
 * than false on failure: "we could not tell" and "it is ready" are different
 * facts and the mirror should not print the second when it means the first.
 */
export async function isPullRequestDraft(
	token: string,
	pr: ParsedPullRequestUrl,
): Promise<boolean | undefined> {
	try {
		const response = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "cyrus-agent",
			},
			body: JSON.stringify({
				query: `query($owner: String!, $repo: String!, $number: Int!) {
					repository(owner: $owner, name: $repo) {
						pullRequest(number: $number) { isDraft }
					}
				}`,
				variables: { owner: pr.owner, repo: pr.repo, number: pr.number },
			}),
		});
		const payload = (await response.json()) as {
			data?: {
				repository?: { pullRequest?: { isDraft?: boolean } | null } | null;
			};
			errors?: unknown[];
		};
		if (!response.ok || payload.errors?.length) return undefined;
		return payload.data?.repository?.pullRequest?.isDraft;
	} catch {
		return undefined;
	}
}

/**
 * Put a pull request BACK into draft (PON-208 follow-up).
 *
 * The inverse of `markPullRequestReady`, and the structural half of
 * draft-until-release. Draft-ness used to rest entirely on the model
 * following the verify-and-ship skill — and on the first live run it did
 * not: the session marked its own PR ready before a human had looked at
 * it, so a client watching their repository saw a finished-looking PR
 * for work nobody had reviewed.
 *
 * Instructions cannot guarantee this; re-asserting the invariant can. We
 * hold the App token, so whatever a session does, the gate can put it
 * back.
 *
 * Returns "drafted" when it flipped one, "already-draft" when there was
 * nothing to do. Throws on API failure so the caller can report honestly
 * rather than assume.
 */
export async function convertPullRequestToDraft(
	token: string,
	pr: ParsedPullRequestUrl,
): Promise<"drafted" | "already-draft"> {
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
	const found = lookup.repository?.pullRequest;
	if (!found)
		throw new Error(
			`Pull request not found: ${pr.owner}/${pr.repo}#${pr.number}`,
		);
	if (found.isDraft) return "already-draft";

	await query(
		`mutation($id: ID!) {
			convertPullRequestToDraft(input: { pullRequestId: $id }) {
				pullRequest { id isDraft }
			}
		}`,
		{ id: found.id },
	);
	return "drafted";
}
