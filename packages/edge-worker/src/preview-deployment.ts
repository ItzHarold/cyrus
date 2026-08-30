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
	/**
	 * Deployed and healthy, but behind the host's login wall.
	 *
	 * Vercel Authentication is on by default for paid teams, and a protected
	 * deployment reports `success` exactly like an open one — so without this
	 * we render a confident link that lands on a login page. The reviewer hits
	 * it as well as the client, and neither can tell it from a broken build.
	 */
	| "protected"
	/**
	 * Behind the login wall, and the bypass value we hold does not open it.
	 *
	 * Distinct from `protected` because the fix is the opposite one: nothing
	 * is wrong with the client's Vercel setting, our stored value is stale.
	 * Telling an operator to go turn off Vercel Authentication would send
	 * them to change a setting that is not the problem.
	 */
	| "bypass-failed"
	/** The repository has no preview deployments at all. */
	| "none"
	/**
	 * We are not allowed to read deployments on this repository.
	 *
	 * Distinct from a transient failure because the fix is different and
	 * specific: the GitHub App needs `deployments: read`, which an org owner
	 * grants once. Reporting it as "couldn't check" sends someone hunting for
	 * an outage that is not there.
	 */
	| "no-access";

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
	/**
	 * The tenant's Vercel bypass value, when we hold one (PON-213).
	 *
	 * The reachability probe has to run against the link we are actually
	 * going to publish. Probing the bare URL and then appending the bypass
	 * afterwards produced the worst possible mirror line: a link that opens,
	 * next to a warning that it does not, next to an instruction to change a
	 * Vercel setting that no longer needs changing.
	 */
	bypassToken?: string,
): Promise<PreviewDeployment | undefined> {
	let forbidden = false;
	const api = async <T>(path: string): Promise<T | undefined> => {
		const response = await fetchImpl(`https://api.github.com${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "cyrus-agent",
			},
		});
		// 403 only. A 404 is ambiguous — GitHub uses it to hide private
		// resources, but it is also a plain missing repo — and guessing wrong
		// would tell an org owner to grant a permission that is not the problem.
		if (response.status === 403) forbidden = true;
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	};

	try {
		const deployments = await api<GitHubDeployment[]>(
			`/repos/${repo.owner}/${repo.repo}/deployments?sha=${sha}&per_page=10`,
		);
		if (!deployments)
			return forbidden ? { state: "no-access", sha } : undefined;
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
		if (state === "ready" && latest.environment_url) {
			const reachable = await isReachableWithoutLogin(
				latest.environment_url,
				fetchImpl,
			);
			if (reachable !== false) {
				return { state: "ready", sha: newest.sha, url: latest.environment_url };
			}
			// Behind the wall. If we hold the tenant's bypass value, the link
			// we publish is the bypassed one — so that is the link to judge.
			if (bypassToken) {
				const bypassed = withPreviewBypass(latest.environment_url, bypassToken);
				const opens = await isReachableWithoutLogin(bypassed, fetchImpl);
				return {
					state: opens ? "ready" : "bypass-failed",
					sha: newest.sha,
					url: opens ? bypassed : latest.environment_url,
				};
			}
			return {
				state: "protected",
				sha: newest.sha,
				url: latest.environment_url,
			};
		}
		return {
			state,
			sha: newest.sha,
			...(state === "failed"
				? { logUrl: latest.log_url ?? latest.target_url ?? undefined }
				: {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Does this preview open for someone with no account on the host?
 *
 * The deployment status cannot answer it — a protected deployment succeeds
 * exactly like an open one — so the only way to know is to ask the URL. A
 * redirect to a login endpoint is the signal.
 *
 * Returns undefined when we could not tell, which is deliberately different
 * from `false`: "we did not check" and "your client cannot open this" call for
 * different words on the mirror.
 */
async function isReachableWithoutLogin(
	url: string,
	fetchImpl: typeof fetch,
): Promise<boolean | undefined> {
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			redirect: "manual",
			headers: { "User-Agent": "cyrus-agent" },
		});
		const location = response.headers?.get?.("location") ?? "";
		if (/\/sso-api|\/sso\b|vercel\.com\/login/.test(location)) return false;
		// 401/403 without a redirect is the password-protection shape.
		if (response.status === 401 || response.status === 403) return false;
		return true;
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
			// An explicit markdown link, not a bare URL (PON-221). With a
			// bypass value appended the raw form is a 150-character blob whose
			// visible text is dominated by a secret, and it relies on Linear's
			// autolinker surviving the `?` and `&` — which is how a reviewer
			// ends up with something that looks like a link and does not
			// behave like one. Short anchor text, everything else in the href.
			return preview.url
				? `**Preview:** [▶ Open the running app](${preview.url})${at} — opens without a Vercel account.`
				: `**Preview:** ready${at}, but the deployment did not publish a URL.`;
		case "building":
			return `**Preview:** building${at} — the link appears here when it finishes.`;
		case "failed":
			return preview.logUrl
				? `**Preview:** the build **failed**${at} — ${preview.logUrl}`
				: `**Preview:** the build **failed**${at}.`;
		case "protected":
			// Deliberately NOT "open the running app": this link does not
			// reach the app, and anchor text that promises it would send the
			// reviewer to a login wall wondering what they did wrong.
			return `**Preview:** [the deployment](${preview.url})${at} — ⚠️ **it asks for a Vercel login**, so the client cannot open their own preview. The connected project still has Vercel Authentication on for previews; onboarding asks for it to be off.`;
		case "bypass-failed":
			return `**Preview:** [the deployment](${preview.url})${at} — ⚠️ **the access value we hold no longer opens it.** Nothing is wrong with their Vercel setting; ask the client to regenerate the Protection Bypass value and send it again. Review from the diff until then.`;
		case "no-access":
			return "**Preview:** I can't read deployments on this repository — the GitHub App is missing the `deployments: read` permission. An org owner grants it once, in the App's settings, and the installation then has to accept it.";
		case "none":
			return "**Preview:** this repository has no preview deployments, so review from the diff.";
	}
}

/**
 * Vercel's query parameters for opening a protected preview.
 *
 * `x-vercel-set-bypass-cookie` makes the first load set a cookie, so the
 * reviewer or client can navigate the app rather than having the bypass apply
 * to one request and then bounce them to a login page on the second click.
 */
const BYPASS_PARAM = "x-vercel-protection-bypass";
const BYPASS_COOKIE_PARAM = "x-vercel-set-bypass-cookie";

/**
 * Make a protected preview openable by someone with no Vercel account
 * (PON-213).
 *
 * The client generates this secret on their own project and gives it to us.
 * Appending it opens our link while leaving the preview protected against
 * anyone who does not have it — which is why we ask for this rather than
 * asking them to switch protection off and make previews world-readable.
 *
 * Returns the URL unchanged when there is no token, so an unconfigured tenant
 * degrades to today's behaviour rather than to a broken link.
 */
export function withPreviewBypass(
	url: string,
	token: string | undefined,
): string {
	if (!token) return url;
	try {
		const parsed = new URL(url);
		parsed.searchParams.set(BYPASS_PARAM, token);
		parsed.searchParams.set(BYPASS_COOKIE_PARAM, "true");
		return parsed.toString();
	} catch {
		// Not a URL we can parse — hand back what we were given rather than
		// concatenating a secret onto an unknown string.
		return url;
	}
}

/**
 * Whether the client's bypass value actually opens their preview (PON-215).
 *
 * The gate used to trust that a supplied value works. It might be a typo, the
 * wrong project's secret, or one they regenerated between copying and sending
 * — and we would find out at the first delivery, in front of the client, on
 * the one link the whole product is built around.
 *
 * Checking is one unauthenticated request, so it happens at onboarding while
 * someone is still paying attention.
 */
export type BypassCheck =
	/** Previews are open; no value is needed and none should be asked for. */
	| "not-needed"
	| "works"
	/** They gave us something and it does not open the preview. */
	| "supplied-but-fails"
	| "missing"
	/** Could not reach the preview at all — not the same as a bad value. */
	| "could-not-check";

export async function verifyPreviewAccess(
	previewUrl: string | undefined,
	token: string | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<BypassCheck> {
	if (!previewUrl) return "could-not-check";

	const openWithout = await isReachableWithoutLogin(previewUrl, fetchImpl);
	if (openWithout === undefined) return "could-not-check";
	// Previews that already open need no value, and asking for one anyway is
	// how an onboarding message stops being believed.
	if (openWithout) return "not-needed";
	if (!token) return "missing";

	const withToken = await isReachableWithoutLogin(
		withPreviewBypass(previewUrl, token),
		fetchImpl,
	);
	if (withToken === undefined) return "could-not-check";
	return withToken ? "works" : "supplied-but-fails";
}

/**
 * Does this text carry a preview bypass token?
 *
 * The content policy blanks URLs before scanning, deliberately — a preview
 * host embeds the branch name and rewriting it hands the client a broken
 * link. But a bypass token lives in a query string, so that exemption makes
 * the one place the secret appears the one place we do not look. This is the
 * narrow re-inclusion: scan for the parameter by name, whatever the value.
 */
export function containsBypassToken(text: string): boolean {
	return new RegExp(`[?&]${BYPASS_PARAM}=`, "i").test(text);
}
