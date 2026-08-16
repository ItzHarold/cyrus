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

	// The runner denies an AskUserQuestion carrying more than one question
	// (ClaudeRunner.ts) and Linear renders one body with one option list. A
	// model told to "ask three questions" gets denied and is instructed to ask
	// separately — three elicitations, three round trips, which is the failure
	// this skill exists to prevent. The one-call rule has to be explicit.
	it("states that only one question is permitted", () => {
		expect(skill).toMatch(/exactly one question/i);
		expect(skill).toMatch(/AskUserQuestion/);
	});

	it("caps the questions in that one call at three", () => {
		expect(skill).toMatch(/at most.{0,10}three/i);
	});

	it("requires a proposed default beside each question", () => {
		expect(skill).toMatch(/the answer you\s+will assume/i);
	});

	it("makes 'Use these defaults' the primary option", () => {
		expect(skill).toMatch(/\*\*"Use these defaults"\*\* — the primary/);
	});

	// A client can reply with free text without clicking anything, so the
	// second option must read as an affordance rather than a required step.
	it("does not turn the inline-answer option into an extra round trip", () => {
		expect(skill).toMatch(/affordance, not a step/i);
		expect(skill).toMatch(/Do not\s+turn it into an extra round trip/i);
	});

	it("bars a second round unless the answer genuinely contradicts", () => {
		expect(skill).toMatch(/\*\*Do not ask again\.\*\*/);
	});

	it("proceeds and records the interpretation on 'use your judgment'", () => {
		expect(skill).toMatch(/judgment/i);
		expect(skill).toMatch(/`thought` activity/);
	});

	it("stays silent when the issue is buildable", () => {
		expect(skill).toMatch(/Silence is the correct output of a passed\s+check/);
	});

	describe("calibration — over-asking is the failure that matters", () => {
		it("sets the bar at producing the wrong artefact", () => {
			expect(skill).toMatch(/wrong artefact/i);
		});

		it("refuses to ask what the repo already answers", () => {
			expect(skill).toMatch(/The answer is in the repo/i);
		});

		it("prefers a stated assumption over a question", () => {
			expect(skill).toMatch(/A stated assumption is cheaper/i);
		});

		// Measured on ten real client issues: the noisiest thread in the sample
		// was eight rounds of live third-party API debugging, none of it
		// knowable in advance. Length and follow-up volume are not ambiguity.
		it("excludes runtime behaviour that no question could answer", () => {
			expect(skill).toMatch(/runtime behaviour you cannot know until you run/i);
		});

		it("tells the model that description length is not the signal", () => {
			expect(skill).toMatch(/\*\*Length is not the signal\.\*\*/);
		});

		it("breaks ties toward building", () => {
			expect(skill).toMatch(
				/When you are unsure whether to ask, \*\*don't\*\*/,
			);
		});
	});

	// Both pre-flight checks can park the session. Two pauses in one session is
	// two round trips, so the ordering is stated in both skills rather than
	// left to be inferred from the guidance block alone.
	describe("one pause per session", () => {
		it("clarify-requirements defers to a split proposal", () => {
			expect(skill).toMatch(/At most one pause per session/i);
			expect(skill).toMatch(/stop — do not also ask/i);
		});

		it("assess-scope stops pausing once it has proposed a split", async () => {
			const scope = await readFile(skillPath("assess-scope"), "utf8");
			expect(scope).toMatch(/you are done pausing/i);
			expect(scope).toMatch(/clarify-requirements/);
			expect(scope).toMatch(/At\s+most one pause per session/i);
		});
	});
});
