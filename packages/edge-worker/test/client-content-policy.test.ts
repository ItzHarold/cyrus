import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildClientSurfaceRuleBlock,
	findClientContentViolations,
	redactClientContent,
} from "../src/client-content-policy.js";
import { CLIENT_MESSAGES } from "../src/client-messages.js";

/**
 * Client-visible content policy (PON-168 / R2). Three suites:
 *   - the policy itself (what matches, what is exempt, what redacts);
 *   - the STATIC SWEEP: every registered client-facing template must be
 *     clean — a hit here is the "test failure on any outbound
 *     client-visible string" the spec demands;
 *   - registry completeness: the set of modules that emit client-visible
 *     strings is asserted against the codebase, so a new emitting module
 *     cannot silently skip the sweep.
 */

const SRC = join(__dirname, "..", "src");

describe("policy matching", () => {
	it("flags the internal service name and package names", () => {
		expect(
			findClientContentViolations("Cyrus finished the work").map((v) => v.rule),
		).toContain("internal-name");
		expect(
			findClientContentViolations("uses cyrus-edge-worker internally").map(
				(v) => v.rule,
			),
		).toContain("internal-name");
	});

	it("flags internal paths and model names", () => {
		expect(
			findClientContentViolations("saved to /root/.service-home/state").map(
				(v) => v.rule,
			),
		).toContain("internal-path");
		expect(
			findClientContentViolations("ran on claude-opus-5").map((v) => v.rule),
		).toContain("model-id");
		expect(
			findClientContentViolations("an opus of engineering").map((v) => v.rule),
		).toContain("model-family-word");
	});

	it("exempts branch references — the client sees those in their own repo", () => {
		expect(
			findClientContentViolations(
				"Pushed to cyrussh/pon-166-add-a-changelog-stub for review.",
			),
		).toEqual([]);
	});

	it("clean client text passes untouched", () => {
		expect(
			findClientContentViolations(
				"Done — the export view is live on the preview. Open the PR to merge.",
			),
		).toEqual([]);
	});

	it("redacts the unambiguous cases loudly and leaves ambiguous words alone", () => {
		const { text, redactions } = redactClientContent(
			"Cyrus wrote /root/.service/workspaces/ABC-1/file.ts using claude-opus-5; quite the opus.",
		);
		expect(text).not.toMatch(/cyrus/i);
		expect(text).not.toContain("/root/");
		expect(text).not.toContain("claude-opus-5");
		expect(text).toContain("the agent");
		expect(text).toContain("the model");
		expect(text).toContain("opus."); // ambiguous family word untouched
		expect(redactions.length).toBeGreaterThanOrEqual(3);
	});

	it("redaction preserves branch references verbatim", () => {
		const { text } = redactClientContent(
			"See branch cyrussh/pon-166-stub for the change.",
		);
		expect(text).toContain("cyrussh/pon-166-stub");
	});

	// URLs are functional pointers — found live (PON-175 audit, 2026-08-25):
	// the tripwire rewrote the app username inside a Vercel preview host
	// (dashed branch form, so the slash-shaped exemption missed it) and
	// handed the client "https://pontedigital-git-the agent.vercel.app".
	it("URLs are exempt from scanning — a dashed preview host is not a violation", () => {
		expect(
			findClientContentViolations(
				"Preview: https://pontedigital-git-cyrussh-pon-175-add-a-contact.vercel.app",
			),
		).toEqual([]);
		expect(
			findClientContentViolations("Docs: https://example.com/root/guide"),
		).toEqual([]);
	});

	it("redaction preserves URLs verbatim while still redacting outside them", () => {
		const { text, redactions } = redactClientContent(
			"Cyrus deployed it. Preview: https://pontedigital-git-cyrussh-pon-175-add-a-contact.vercel.app",
		);
		expect(text).toContain(
			"https://pontedigital-git-cyrussh-pon-175-add-a-contact.vercel.app",
		);
		expect(text).toContain("the agent deployed it.");
		expect(redactions).toEqual(["Cyrus"]);
	});
});

describe("static sweep — registered client-facing templates are clean", () => {
	it("every CLIENT_MESSAGES template passes the policy", () => {
		for (const [name, template] of Object.entries(CLIENT_MESSAGES)) {
			const rendered = (template as (...args: string[]) => string)(
				"example-repository",
			);
			expect(
				findClientContentViolations(rendered),
				`CLIENT_MESSAGES.${name} violates the client content policy`,
			).toEqual([]);
		}
	});

	it("the client-facing halves of the gate blocks are clean", () => {
		// The blocks themselves are prompt-side, but their canonical labels
		// and quoted client-facing phrasing surface verbatim in elicitations.
		const gate = readFileSync(join(SRC, "scope-confirm-gate.ts"), "utf8");
		for (const literal of extractStringLiterals(gate)) {
			expect(
				findClientContentViolations(literal).filter(
					// Prompt-side text may reference the model's own tooling
					// vocabulary; only the name/path/model bans apply to what
					// clients can see quoted.
					(v) => v.rule !== "model-family-word",
				),
				`scope-confirm-gate literal violates policy: ${literal.slice(0, 60)}`,
			).toEqual([]);
		}
	});

	it.each([
		"ActivityPoster.ts",
		"RepositoryRouter.ts",
	])("%s string literals are clean", (file) => {
		const source = readFileSync(join(SRC, file), "utf8");
		for (const literal of extractStringLiterals(source)) {
			if (literal.length < 4) continue; // keys, separators
			if (!/\s/.test(literal)) continue; // code constants, not prose
			expect(
				findClientContentViolations(literal).filter(
					(v) => v.rule !== "model-family-word",
				),
				`${file} literal violates policy: ${literal.slice(0, 60)}`,
			).toEqual([]);
		}
	});

	it("the intrinsic rule block itself is clean and present", () => {
		const block = buildClientSurfaceRuleBlock();
		expect(block).toContain("<client_surface_rules>");
		expect(findClientContentViolations(block)).toEqual([]);
	});
});

describe("registry completeness — emitting modules cannot skip the sweep", () => {
	/**
	 * Modules whose string literals can reach a TENANT surface. Anything
	 * that calls the client-posting APIs must be here or in the documented
	 * operator-side list below.
	 */
	const SWEPT = new Set([
		"ActivityPoster.ts",
		"client-messages.ts",
		"scope-confirm-gate.ts",
		"RepositoryRouter.ts",
	]);
	/** Operator-side or non-tenant emitters, each with the reason. */
	const OPERATOR_SIDE = new Set([
		"CockpitMirror.ts", // writes ONLY into the operator's cockpit workspace
		"EdgeWorker.ts", // client strings moved to client-messages.ts; remaining posts are operator-side (mirror replies) or use templates
		"AgentSessionManager.ts", // posts CONTENT it is given; sources are swept
		"AskUserQuestionHandler.ts", // posts the model's question verbatim; intrinsic rules govern it
		"SlackChatAdapter.ts", // Slack operator surface, not a tenant issue
		"ChatSessionHandler.ts", // chat surface
	]);

	it("every module calling a posting API is either swept or documented operator-side", () => {
		const emitting = readdirSync(SRC)
			.filter((f) => f.endsWith(".ts"))
			.filter((f) => {
				const source = readFileSync(join(SRC, f), "utf8");
				return /createAgentActivity|postActivity\(|createComment\(|postComment\(/.test(
					source,
				);
			});
		const unaccounted = emitting.filter(
			(f) => !SWEPT.has(f) && !OPERATOR_SIDE.has(f),
		);
		expect(
			unaccounted,
			`modules emit client-visible strings but are neither swept nor documented: ${unaccounted.join(", ")}`,
		).toEqual([]);
	});

	it("EdgeWorker's tenant-facing error/comment strings come from CLIENT_MESSAGES", () => {
		const source = readFileSync(join(SRC, "EdgeWorker.ts"), "utf8");
		// The tenant-facing posts this workstream owns must reference the
		// template module, not inline literals (that is what keeps the sweep
		// total for them).
		expect(source).toContain("CLIENT_MESSAGES.worktreeRefusedAtStart");
		expect(source).toContain("CLIENT_MESSAGES.worktreeRefusedOnResume");
		expect(source).toContain("CLIENT_MESSAGES.workspaceUnpreparable");
		expect(source).toContain("CLIENT_MESSAGES.workspaceNotConfigured");
		expect(source).toContain("CLIENT_MESSAGES.verificationDelayNote");
	});
});

/** Pull string/template literal bodies out of TypeScript source. */
function extractStringLiterals(source: string): string[] {
	// Import specifiers are strings but never client-visible.
	const withoutImports = source
		.replace(/^import[^;]*;$/gms, "")
		.replace(/require\([^)]*\)/g, "");
	const out: string[] = [];
	const patterns = [
		/`((?:[^`\\]|\\.)*)`/gs,
		/"((?:[^"\\]|\\.)*)"/g,
		/'((?:[^'\\]|\\.)*)'/g,
	];
	for (const pattern of patterns) {
		for (const match of withoutImports.matchAll(pattern)) {
			out.push(match[1] ?? "");
		}
	}
	return out;
}
