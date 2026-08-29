/**
 * What we can learn about a client's preview setup from their repository
 * alone (PON-215).
 *
 * An integration client installs the Linear app and the GitHub App. We have
 * never seen their infrastructure, hold no credential for their hosting, and
 * cannot open a dashboard. So the rule this module obeys:
 *
 *   Anything we assert must come from (a) their repository, (b) an
 *   unauthenticated HTTP request, or (c) something they told us. If it needs
 *   a dashboard, it is a QUESTION, not a check.
 *
 * Everything here uses the GitHub App token and nothing else — `contents:read`
 * and `deployments:read`, both already granted. That is deliberate and worth
 * protecting: every previous conclusion about previews in this project was
 * reached with Vercel access to our OWN projects, which no client will ever
 * give us.
 *
 * The output is a picture plus a GENERATED ask: we do the work of finding out
 * what to ask, so the client answers two specific questions instead of filling
 * in a questionnaire about their own setup from memory.
 */

/** Where the app deploys. Determined from config files and the preview host. */
export type PreviewHost =
	| "vercel"
	| "netlify"
	| "render"
	| "fly"
	| "amplify"
	| "unknown";

/**
 * The database provider. This matters far more than it looks: it decides what
 * "we use branching for previews" MEANS, and the two common answers are
 * opposites.
 */
export type DatabaseProvider =
	| "supabase"
	| "neon"
	| "planetscale"
	| "postgres"
	| "mysql"
	| "none-found"
	| "unknown";

/**
 * What a branch of this provider contains by default — the whole reason the
 * separate-database question cannot be answered by asking "do you use
 * branching?".
 */
export type BranchDataDefault =
	/** Schema and seed only. Supabase: "No production data is copied." */
	| "no-production-data"
	/** The parent's rows. Neon: "all of the data that existed in the parent branch." */
	| "copies-parent-data"
	/** No safe assumption either way. */
	| "unknown";

export interface EnvVarFinding {
	name: string;
	/** Where it was declared, or "source" when only a code reference found it. */
	source: string;
	/** True when nothing in the repo documents it — the client will not expect it. */
	undeclared: boolean;
	/**
	 * The code supplies a fallback (`process.env.X ?? "…"`), so the app runs
	 * without it. Worth listing, but asking a client to supply it makes the
	 * list look machine-generated and untrustworthy — and a list they distrust
	 * is one they answer carelessly.
	 */
	optional?: boolean;
}

export interface PreviewDiscovery {
	previewsPerPR: "yes" | "no" | "unknown";
	/** Evidence for the above, in words, so a human can check our reasoning. */
	previewEvidence: string;
	host: PreviewHost;
	database: DatabaseProvider;
	branchDefault: BranchDataDefault;
	envVars: EnvVarFinding[];
	/** Questions the repository genuinely cannot answer. */
	mustAsk: string[];
}

const HOST_FILES: Array<[string, PreviewHost]> = [
	["vercel.json", "vercel"],
	["netlify.toml", "netlify"],
	["render.yaml", "render"],
	["fly.toml", "fly"],
	["amplify.yml", "amplify"],
];

/**
 * Provider fingerprints, most specific first.
 *
 * Order matters: a Supabase project also depends on `pg`, and a Neon project
 * is also "postgres". Matching the generic driver first would erase exactly
 * the distinction the data gate rests on.
 */
const DB_SIGNALS: Array<[RegExp, DatabaseProvider, BranchDataDefault]> = [
	[
		/@neondatabase\/serverless|\.neon\.tech|\bneon\(/,
		"neon",
		"copies-parent-data",
	],
	[
		/@supabase\/supabase-js|\.supabase\.co|supabase\/config\.toml/,
		"supabase",
		"no-production-data",
	],
	[/@planetscale\/database|\.psdb\.cloud/, "planetscale", "unknown"],
	[/\bmysql2\b|\bmysql\b/, "mysql", "unknown"],
	[/\bpg\b|postgres:\/\/|postgresql:\/\//, "postgres", "unknown"],
];

/** Files that declare environment variables, in order of authority. */
const ENV_DECLARATION_FILES = [
	".env.example",
	".env.local.example",
	".env.sample",
	".env.template",
];

interface RepoReader {
	/** File contents, or undefined when absent. Never throws. */
	file(path: string): Promise<string | undefined>;
	/** Every path in the default branch, for the source-grep fallback. */
	paths(): Promise<string[]>;
	/** Does any recent PR head have a preview deployment? */
	previewEvidence(): Promise<{ found: boolean; detail: string; url?: string }>;
}

/** Parse `KEY=` / `KEY =` lines out of a dotenv-style file. */
function declaredIn(content: string): string[] {
	const names: string[] = [];
	for (const line of content.split("\n")) {
		const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
		if (match?.[1]) names.push(match[1]);
	}
	return [...new Set(names)];
}

/** `process.env.FOO` and `process.env["FOO"]` references in source. */
export function envRefsInSource(
	source: string,
): Array<{ name: string; optional: boolean }> {
	const found = new Map<string, boolean>();
	const dotted = /process\.env\.([A-Z][A-Z0-9_]*)\s*(\?\?|\|\|)?/g;
	const indexed =
		/process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]\s*(\?\?|\|\|)?/g;
	for (const re of [dotted, indexed]) {
		let m = re.exec(source);
		while (m) {
			const name = m[1];
			if (name) {
				// A fallback at the reference site means the app runs without
				// it. Any reference WITHOUT one makes it required overall.
				const hasFallback = Boolean(m[2]);
				found.set(name, (found.get(name) ?? true) && hasFallback);
			}
			m = re.exec(source);
		}
	}
	// Variables the PLATFORM injects. Asking a client to supply VERCEL_URL or
	// npm_package_version is how a generated list loses its credibility.
	const platform =
		/^(?:NODE_ENV|CI|PORT|VERCEL(?:_.*)?|AWS_(?:REGION|EXECUTION_ENV|LAMBDA_.*)|NEXT_RUNTIME|npm_.*)$/i;
	return [...found.entries()]
		.filter(([name]) => !platform.test(name))
		.map(([name, optional]) => ({ name, optional }));
}

/**
 * Look at a client's repository and work out what we still need to ask.
 *
 * Deliberately tolerant: every probe that fails degrades to "unknown", because
 * a wrong confident answer about someone's infrastructure is worse than an
 * honest question.
 */
export async function discoverPreviewSetup(
	repo: RepoReader,
): Promise<PreviewDiscovery> {
	// 1. Previews — the one thing that is fact rather than inference. A
	//    deployment either exists for a PR's head commit or it does not.
	let previewsPerPR: PreviewDiscovery["previewsPerPR"] = "unknown";
	let previewEvidence = "Could not read deployments for this repository.";
	let previewUrl: string | undefined;
	try {
		const evidence = await repo.previewEvidence();
		previewsPerPR = evidence.found ? "yes" : "no";
		previewEvidence = evidence.detail;
		previewUrl = evidence.url;
	} catch {
		// leave unknown
	}

	// 2. Host — a config file if present, else the preview hostname itself.
	let host: PreviewHost = "unknown";
	for (const [path, candidate] of HOST_FILES) {
		if (await repo.file(path)) {
			host = candidate;
			break;
		}
	}
	if (host === "unknown" && previewUrl) {
		if (/\.vercel\.app/.test(previewUrl)) host = "vercel";
		else if (/\.netlify\.app/.test(previewUrl)) host = "netlify";
		else if (/\.onrender\.com/.test(previewUrl)) host = "render";
		else if (/\.fly\.dev/.test(previewUrl)) host = "fly";
	}

	// 3. Database provider. Read the manifest plus whatever env declarations
	//    exist — a hostname in .env.example is often the clearest signal.
	const haystack = [
		(await repo.file("package.json")) ?? "",
		(await repo.file("supabase/config.toml")) ? "supabase/config.toml" : "",
		...(await Promise.all(
			ENV_DECLARATION_FILES.map(async (f) => (await repo.file(f)) ?? ""),
		)),
	].join("\n");
	let database: DatabaseProvider = "none-found";
	let branchDefault: BranchDataDefault = "unknown";
	for (const [pattern, provider, defaultData] of DB_SIGNALS) {
		if (pattern.test(haystack)) {
			database = provider;
			branchDefault = defaultData;
			break;
		}
	}

	// 4. Env vars: what the repo declares, then what the source actually reads.
	//    The gap between the two is the interesting part — a variable the app
	//    needs and nothing documents is one the client will not think to send.
	const declared = new Map<string, string>();
	for (const file of ENV_DECLARATION_FILES) {
		const content = await repo.file(file);
		if (!content) continue;
		for (const name of declaredIn(content)) {
			if (!declared.has(name)) declared.set(name, file);
		}
	}
	const referenced = new Map<string, boolean>();
	try {
		const paths = (await repo.paths()).filter(
			(p) =>
				/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(p) &&
				!/(?:^|\/)(?:node_modules|dist|build|\.next)\//.test(p),
		);
		// Bounded: a source grep is a fallback, not a full index.
		for (const path of paths.slice(0, 400)) {
			const content = await repo.file(path);
			if (!content) continue;
			for (const ref of envRefsInSource(content)) {
				referenced.set(
					ref.name,
					(referenced.get(ref.name) ?? true) && ref.optional,
				);
			}
		}
	} catch {
		// The declared list stands on its own.
	}

	const envVars: EnvVarFinding[] = [];
	for (const [name, source] of declared) {
		envVars.push({ name, source, undeclared: false });
	}
	for (const [name, optional] of referenced) {
		if (declared.has(name)) continue;
		envVars.push({ name, source: "source", undeclared: true, optional });
	}
	envVars.sort((a, b) => a.name.localeCompare(b.name));

	return {
		previewsPerPR,
		previewEvidence,
		host,
		database,
		branchDefault,
		envVars,
		mustAsk: buildMustAsk({ previewsPerPR, database, branchDefault }),
	};
}

/**
 * The questions the repository could not answer.
 *
 * Only these get asked. Everything else we worked out ourselves, which is the
 * difference between a client answering two specific questions and a client
 * filling in a form about their own setup from memory.
 */
function buildMustAsk(input: {
	previewsPerPR: PreviewDiscovery["previewsPerPR"];
	database: DatabaseProvider;
	branchDefault: BranchDataDefault;
}): string[] {
	const asks: string[] = [];
	if (input.previewsPerPR === "no") {
		asks.push(
			"Your pull requests do not build a preview yet. Setting that up is the first thing we would do together.",
		);
		return asks;
	}

	// The data gate. Phrased by provider, because "we use branching" means
	// opposite things depending on which one they are on.
	switch (input.branchDefault) {
		case "copies-parent-data":
			asks.push(
				"Your app uses Neon. Neon preview branches include all of the parent branch's data by default, so if your preview branch was made from production it contains real customer records. Was it created from production, or from a seeded branch?",
			);
			break;
		case "no-production-data":
			asks.push(
				"Your app uses Supabase, whose preview branches do not copy production data. Just to confirm: do your previews use branching, or do they point at your production project?",
			);
			break;
		default:
			asks.push(
				"Does your preview run against a different database from your live site? If you are not sure: open your preview and your live site side by side — does the preview show the same customers and orders as the live one?",
			);
	}
	return asks;
}

/**
 * The onboarding message, generated from what we found.
 *
 * Client-facing: plain, specific, and short. It states what we already know so
 * they can see we did the work, and asks only what we could not determine.
 */
export function renderDiscoveryAsk(
	discovery: PreviewDiscovery,
	repoName: string,
): string {
	const lines: string[] = [`We had a look at **${repoName}**.`, ""];

	if (discovery.previewsPerPR === "yes") {
		const where = discovery.host === "unknown" ? "" : ` on ${discovery.host}`;
		lines.push(
			`**Previews:** every pull request already builds one${where} — that is what we review against, so nothing to set up.`,
		);
	} else if (discovery.previewsPerPR === "no") {
		lines.push(
			"**Previews:** your pull requests do not build one yet. That is the one thing missing, and it is the first thing we would build.",
		);
	} else {
		lines.push(
			"**Previews:** we could not tell from the repository whether pull requests build one.",
		);
	}

	const undeclared = discovery.envVars.filter(
		(v) => v.undeclared && !v.optional,
	);
	if (discovery.envVars.length > 0) {
		lines.push(
			"",
			`**Environment:** your app reads ${discovery.envVars.length} variable${discovery.envVars.length === 1 ? "" : "s"}.`,
		);
		if (undeclared.length > 0) {
			lines.push(
				`${undeclared.length} of them ${undeclared.length === 1 ? "is" : "are"} not documented anywhere in the repository, so we found ${undeclared.length === 1 ? "it" : "them"} in the code: ${undeclared.map((v) => `\`${v.name}\``).join(", ")}. Worth adding to a \`.env.example\` whatever happens — it is the kind of thing that costs an afternoon later.`,
			);
		}
	}

	if (discovery.mustAsk.length > 0) {
		lines.push("", "**What we need from you:**");
		for (const ask of discovery.mustAsk) lines.push(`- ${ask}`);
	}
	return lines.join("\n");
}
