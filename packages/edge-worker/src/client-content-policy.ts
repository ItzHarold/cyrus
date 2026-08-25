/**
 * Client-visible content policy (PON-168 / client-flow R2).
 *
 * On ANY client-visible surface — tenant Linear activity, PR titles/bodies,
 * commit messages, branch names, error activities — internal vocabulary must
 * never appear: the service's internal name, its package names, internal
 * filesystem paths, and model names. This module is the SINGLE definition of
 * those bans, used three ways:
 *
 *   1. the static sweep test runs every registered client-facing template
 *      through it (a hit is a test failure);
 *   2. the runtime tripwire checks model-authored outbound text, logs
 *      violations, and redacts only the unambiguous cases — loudly, never
 *      silently;
 *   3. the intrinsic prompt block tells the model the rule up front, which
 *      is what actually prevents most violations (intrinsic beats enforced).
 */

export interface ClientContentViolation {
	/** Which ban matched */
	rule:
		| "internal-name"
		| "internal-package"
		| "internal-path"
		| "model-id"
		| "model-family-word";
	/** The offending excerpt */
	match: string;
	/** Whether redactClientContent can rewrite this safely */
	redactable: boolean;
}

/**
 * Branch references ("name/ref" shape). The lookbehind keeps the exemption
 * OUT of filesystem paths: in `/root/.cyrus-community/worktrees/…` the
 * segment after the dot would otherwise match as a "branch ref" and swallow
 * the path tail from redaction (found by PON-179's repo-relative tests —
 * this had silently weakened path redaction since PON-168).
 */
const BRANCH_REF_PATTERN = /(?<![./\w-])cyrus[\w-]*\/[\w./-]+/gi;

/** http(s) URLs — exempt as functional pointers (see the scanner comment). */
const URL_PATTERN = /https?:\/\/[^\s<>")]+/gi;

const RULES: Array<{
	rule: ClientContentViolation["rule"];
	pattern: RegExp;
	redactable: boolean;
}> = [
	// The internal service name, any casing, any word position — covers the
	// bare word and cyrus-* package names alike.
	{ rule: "internal-name", pattern: /cyrus[\w-]*/gi, redactable: true },
	// Internal filesystem paths. The service home and worktree layout are
	// operational detail no client should ever see.
	{
		rule: "internal-path",
		pattern: /(?:\/root\/|~\/\.[\w-]+\/|\/home\/[\w-]+\/)[\w./-]*/g,
		redactable: true,
	},
	// Concrete model ids are unambiguous.
	{
		rule: "model-id",
		pattern: /claude-[\w.-]+/gi,
		redactable: true,
	},
	// Bare model-family words in agent-authored text. NOT redactable — some
	// are ordinary words ("magnum opus"), so the tripwire logs rather than
	// rewrites; the static sweep still fails templates that contain them.
	{
		rule: "model-family-word",
		pattern: /\b(?:claude|opus|sonnet|haiku|fable)\b/gi,
		redactable: false,
	},
];

/**
 * Find every policy violation in a piece of client-visible text.
 * `allowlist` removes expected matches (e.g. a branch prefix that IS the
 * configured app username) before scanning.
 */
export function findClientContentViolations(
	text: string,
	allowlist: string[] = [],
): ClientContentViolation[] {
	let scanned = text;
	// URLs are exempt (found live, PON-175 audit 2026-08-25): a URL is a
	// functional pointer — Vercel preview hosts embed the branch name in
	// DASHED form (`repo-git-appuser-issue.vercel.app`), which the slash-
	// shaped branch-ref exemption below cannot cover, and rewriting it
	// hands the client a broken link. The name class a URL can leak (the
	// app username) is already client-visible as the comment author.
	scanned = scanned.replace(URL_PATTERN, " ");
	// The per-repo hook script names are the CLIENT's own files, documented
	// product conventions that live in their repository — reporting "ran
	// cyrus-setup.sh" names their file, not our internals. (Renaming the
	// convention itself is a product decision outside this policy.)
	scanned = scanned.replace(/cyrus-(?:setup|teardown)\.sh/gi, " ");
	// Branch references are exempt: Linear generates branch names from the
	// app username (e.g. an internal-named dev app), the client sees them in
	// their own repository anyway, and rewriting a branch name would break
	// the one thing it exists to identify. A "name/ref" shape (no leading
	// slash) is a branch reference, not an internal path.
	scanned = scanned.replace(BRANCH_REF_PATTERN, " ");
	for (const allowed of allowlist) {
		if (allowed) scanned = scanned.split(allowed).join(" ");
	}
	const violations: ClientContentViolation[] = [];
	for (const { rule, pattern, redactable } of RULES) {
		pattern.lastIndex = 0;
		for (const match of scanned.matchAll(pattern)) {
			violations.push({ rule, match: match[0], redactable });
		}
	}
	return violations;
}

/**
 * Rewrite the unambiguous violations: internal name → "the agent", model id
 * → "the model", internal path → its basename. Returns the redacted text and
 * what was rewritten so callers can LOG the redaction — a silent rewrite of
 * model output is its own kind of dishonesty.
 */
export function redactClientContent(
	text: string,
	options?: {
		/**
		 * Path prefixes (the session's workspace root) whose matches are
		 * rewritten REPO-RELATIVE instead of to a bare basename (PON-179):
		 * the client should read `SUPPORT.md`, not an internal box path and
		 * not an ambiguous `…/SUPPORT.md`.
		 */
		stripPrefixes?: string[];
	},
): {
	text: string;
	redactions: string[];
} {
	const redactions: string[] = [];
	// Same URL exemption as the scanner, protected FIRST (a URL may contain
	// branch-shaped or path-shaped substrings): rewriting a pointer hands
	// the client a broken link (found live, PON-175 audit).
	const urls: string[] = [];
	let out = text.replace(URL_PATTERN, (m) => {
		urls.push(m);
		return `\uE001U${urls.length - 1}\uE001`;
	});
	// Same branch-reference exemption as the scanner: protect them before
	// any rewriting, restore after.
	const branchRefs: string[] = [];
	out = out.replace(BRANCH_REF_PATTERN, (m) => {
		branchRefs.push(m);
		return `\uE000BR${branchRefs.length - 1}\uE000`;
	});
	const prefixes = (options?.stripPrefixes ?? []).filter(Boolean);
	out = out.replace(
		/(?:\/root\/|~\/\.[\w-]+\/|\/home\/[\w-]+\/)[\w./-]*/g,
		(m) => {
			redactions.push(m);
			for (const prefix of prefixes) {
				if (m.startsWith(prefix)) {
					const relative = m.slice(prefix.length).replace(/^\/+/, "");
					if (relative) return relative;
					// The workspace root itself: name it as such.
					return "the project root";
				}
			}
			const base = m.replace(/\/+$/, "").split("/").pop() ?? "";
			return base ? `…/${base}` : "…";
		},
	);
	out = out.replace(/cyrus[\w-]*/gi, (m) => {
		redactions.push(m);
		return "the agent";
	});
	out = out.replace(/claude-[\w.-]+/gi, (m) => {
		redactions.push(m);
		return "the model";
	});
	out = out.replace(
		/\uE000BR(\d+)\uE000/g,
		(_m, i) => branchRefs[Number(i)] ?? "",
	);
	out = out.replace(/\uE001U(\d+)\uE001/g, (_m, i) => urls[Number(i)] ?? "");
	return { text: out, redactions };
}

/**
 * Path-ONLY sanitization (PON-182): internal absolute paths have no
 * legitimate use on ANY client-visible surface, gated or not — so this
 * runs unconditionally on activity payloads and elicitation bodies.
 * Deliberately narrower than redactClientContent: internal names and model
 * ids stay context-dependent (dogfood narration on the operator's own
 * issues legitimately says package names) and remain scoped to quiet
 * surfaces / the final-response tripwire.
 */
export function sanitizeClientPaths(
	text: string,
	options?: { stripPrefixes?: string[] },
): { text: string; redactions: string[] } {
	const redactions: string[] = [];
	const urls: string[] = [];
	let out = text.replace(URL_PATTERN, (m) => {
		urls.push(m);
		return `U${urls.length - 1}`;
	});
	const prefixes = (options?.stripPrefixes ?? []).filter(Boolean);
	out = out.replace(
		/(?:\/root\/|~\/\.[\w-]+\/|\/home\/[\w-]+\/)[\w./-]*/g,
		(m) => {
			redactions.push(m);
			for (const prefix of prefixes) {
				if (m.startsWith(prefix)) {
					const relative = m.slice(prefix.length).replace(/^\/+/, "");
					if (relative) return relative;
					return "the project root";
				}
			}
			const base = m.replace(/\/+$/, "").split("/").pop() ?? "";
			return base ? `…/${base}` : "…";
		},
	);
	out = out.replace(/U(\d+)/g, (_m, i) => urls[Number(i)] ?? "");
	return { text: out, redactions };
}

/**
 * The intrinsic half: an always-on system-prompt rule for every session
 * whose output can reach a client surface.
 */
export function buildClientSurfaceRuleBlock(): string {
	return `

<client_surface_rules>
Everything you post to the issue, and everything that lands in the client's repository (PR titles and bodies, commit messages), is read by the client. On those surfaces:

- Never mention internal tooling names, internal file paths, package names, or which model is running. Describe results, not machinery.
- No running narration of what you are doing or thinking. Progress updates are short statements of state ("Building the export view", "Ready for review"), not a diary.
- Write everything in terms of what the client receives and where they can see it.
</client_surface_rules>`;
}
