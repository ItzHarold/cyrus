import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const skillPath = (name: string) =>
	join(__dirname, "..", "cyrus-skills-plugin", "skills", name, "SKILL.md");

describe("clarify-requirements skill", () => {
	let skill: string;

	beforeAll(async () => {
		skill = await readFile(skillPath("clarify-requirements"), "utf8");
	});

	// The asking version was measured against 18 real client issues on
	// reconstructed pre-merge trees, under two different framings, and never
	// fired once — including on issues whose original sessions cost rework.
	// Shipping a never-fired question path would put an unpredictable
	// interruption into client work with no evidence it triggers correctly, so
	// the ask is disabled until invocation is reliable and calibration is
	// measured where vague issues actually occur.
	describe("does not ask", () => {
		it("forbids the question tools outright", () => {
			expect(skill).toMatch(/Do not call AskUserQuestion/);
			expect(skill).toMatch(/Do not emit an elicitation/);
			expect(skill).toMatch(/Do not wait/);
		});

		it("records the reading instead of asking", () => {
			expect(skill).toMatch(/post \*\*one short\s+`thought` activity\*\*/);
			expect(skill).toMatch(/Do not wait for a reply/);
		});

		it("states the two preconditions for enabling the ask path", () => {
			expect(skill).toMatch(/Invocation is reliable/);
			expect(skill).toMatch(
				/Calibration is measured where the phenomenon lives/,
			);
		});
	});

	describe("how it reads an issue", () => {
		it("enumerates alternative readings rather than hunting for gaps", () => {
			expect(skill).toMatch(
				/what it could mean other\s+than what you first assumed/i,
			);
			expect(skill).toMatch(/ones with two/i);
		});

		// The failures this targets live in filled-in fields, not empty ones.
		it("covers what the issue says, not only what it omits", () => {
			expect(skill).toMatch(
				/what the issue \*\*says\*\*, not only to what it omits/i,
			);
			expect(skill).toMatch(
				/A filled-in field is a place\s+where guessing happens/i,
			);
		});

		it("treats neither length nor specificity as the signal", () => {
			expect(skill).toMatch(/Length and specificity are not the signal/i);
			expect(skill).toMatch(/its very specificity is what stops you looking/i);
		});

		it("treats the repo as an answer", () => {
			expect(skill).toMatch(/\*\*The repo is an answer\.\*\*/);
		});

		it("keeps the recorded note to forks that change the artefact", () => {
			expect(skill).toMatch(/A list of every assumption\s+you made is noise/i);
		});

		it("stays silent when nothing is genuinely two-way", () => {
			expect(skill).toMatch(
				/Silence is the correct output of\s+a passed\s+check/,
			);
		});
	});

	// Both pre-flight checks run before implementation, and assess-scope is the
	// only one that can still pause a session.
	describe("ordering with assess-scope", () => {
		it("is skipped when a split was proposed", () => {
			expect(skill).toMatch(/after assess-scope/i);
		});

		// Regression: assess-scope's pass path said "continue straight to the
		// appropriate skill for the work", which routes to `implementation` and
		// skipped this skill entirely — observed live on a 398-message session
		// where clarify-requirements was never invoked.
		it("assess-scope hands off to clarify-requirements when it passes", async () => {
			const scope = await readFile(skillPath("assess-scope"), "utf8");
			expect(scope).toMatch(
				/hand off to `clarify-requirements`\*\* if it is available/i,
			);
			expect(scope).toMatch(/before starting\s+any work/i);
		});

		it("assess-scope stops pausing once it has proposed a split", async () => {
			const scope = await readFile(skillPath("assess-scope"), "utf8");
			expect(scope).toMatch(/you are done pausing/i);
			expect(scope).toMatch(/clarify-requirements/);
			expect(scope).toMatch(/At\s+most one pause per session/i);
		});
	});
});
