import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Draft-until-release (PON-208 follow-up).
 *
 * A pull request being a draft is what tells the client the work is not
 * finished yet. Until now that rested entirely on the model following the
 * verify-and-ship skill — and on the very first live run it did not: the
 * session marked its own PR ready before any human had looked at it, so a
 * client watching their repository saw a finished-looking PR for unreviewed
 * work.
 *
 * So this is enforced in two places, and both are tested here: the skill no
 * longer tells the model it may mark a PR ready, and the verification gate
 * puts a ready PR back into draft when it composes the mirror.
 */

const WS = "ws-client";
const COCKPIT = "ws-cockpit";
const ISSUE = "issue-1";
const SESSION = "sess-1";
const PR = "https://github.com/acme/webapp/pull/7";

const repo: RepositoryConfig = {
	id: "repo-1",
	name: "webapp",
	repositoryPath: "/tmp/webapp",
	workspaceBaseDir: "/tmp/ws",
	baseBranch: "main",
	linearWorkspaceId: WS,
	linearToken: "t",
	isActive: true,
} as unknown as RepositoryConfig;

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

/** A fake GitHub GraphQL endpoint that tracks one PR's draft state. */
function fakeGitHub(startsAsDraft: boolean) {
	const state = { isDraft: startsAsDraft, converted: 0, readied: 0 };
	const fetchMock = vi.fn(async (_url: string, init: any) => {
		const body = JSON.parse(init.body);
		const q: string = body.query;
		if (q.includes("convertPullRequestToDraft")) {
			state.isDraft = true;
			state.converted += 1;
			return {
				ok: true,
				json: async () => ({
					data: {
						convertPullRequestToDraft: { pullRequest: { isDraft: true } },
					},
				}),
			};
		}
		if (q.includes("markPullRequestReadyForReview")) {
			state.isDraft = false;
			state.readied += 1;
			return {
				ok: true,
				json: async () => ({ data: { markPullRequestReadyForReview: {} } }),
			};
		}
		return {
			ok: true,
			json: async () => ({
				data: {
					repository: { pullRequest: { id: "PR_1", isDraft: state.isDraft } },
				},
			}),
		};
	});
	return { state, fetchMock };
}

function setup(prStartsAsDraft: boolean) {
	const worker = createTestWorker([repo]);
	const p = privates(worker);
	p.config.cockpit = {
		linearWorkspaceId: COCKPIT,
		workspaceName: "Ponte Digital",
		teamId: "team-ckp",
		reviewers: ["harold"],
	};
	p.mintGitHubTokenForRepo = vi.fn().mockResolvedValue("ghs_faketoken");
	p.cockpitMirror.upsert = vi.fn().mockResolvedValue(undefined);
	p.verificationGate.recordPending(ISSUE, {
		workspaceId: WS,
		issueIdentifier: "ACM-1",
		sessionId: SESSION,
		summary: `Done. ${PR}`,
		isError: false,
	});
	const gh = fakeGitHub(prStartsAsDraft);
	vi.stubGlobal("fetch", gh.fetchMock);
	return { worker, p, gh };
}

describe("draft-until-release — the skill does not authorise marking ready", () => {
	it("no longer tells the model it may mark the PR ready", () => {
		const skill = readFileSync(
			join(__dirname, "../../../skills/verify-and-ship/SKILL.md"),
			"utf8",
		);
		// The exact wording that produced the live incident: it made marking
		// ready the DEFAULT and keeping the draft the exception.
		expect(skill).not.toContain(
			"only mark the PR/MR as ready if guidance does NOT specify keeping them as drafts",
		);
		expect(skill).toContain("Leave the PR/MR as a draft");
	});
});

describe("draft-until-release — the gate re-asserts it", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("puts a PR the session marked ready back into draft", async () => {
		const { p, gh } = setup(false); // the live failure: session readied it

		await p.composeVerificationMirror(ISSUE);

		expect(gh.state.isDraft).toBe(true);
		expect(gh.state.converted).toBe(1);
		const note = p.cockpitMirror.upsert.mock.calls[0][3].note as string;
		expect(note).toContain("put back");
	});

	it("leaves an already-draft PR alone", async () => {
		const { p, gh } = setup(true);

		await p.composeVerificationMirror(ISSUE);

		expect(gh.state.converted).toBe(0);
		expect(gh.state.isDraft).toBe(true);
		const note = p.cockpitMirror.upsert.mock.calls[0][3].note as string;
		expect(note).toContain("(draft)");
	});

	it("says so on the mirror when it cannot put it back", async () => {
		// An un-draftable PR is visible to the client RIGHT NOW, and the
		// operator is the only one who can act on that. Never silent.
		const { p } = setup(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: string, init: any) => {
				const q = JSON.parse(init.body).query as string;
				if (q.includes("convertPullRequestToDraft")) {
					return {
						ok: false,
						status: 403,
						json: async () => ({ errors: [{ message: "no" }] }),
					};
				}
				return {
					ok: true,
					json: async () => ({
						data: {
							repository: { pullRequest: { id: "PR_1", isDraft: false } },
						},
					}),
				};
			}),
		);

		await p.composeVerificationMirror(ISSUE);

		const note = p.cockpitMirror.upsert.mock.calls[0][3].note as string;
		expect(note).toContain("could not put it back");
		expect(note).toContain("the client can see this now");
	});

	it("does not fight the approve path — a delivered record is left alone", async () => {
		// Release marks the PR ready on purpose. If the mirror re-drafted
		// after that, approval would silently undo itself.
		const { p, gh } = setup(false);
		p.verificationGate.markDelivered(ISSUE);

		await p.composeVerificationMirror(ISSUE);

		expect(gh.state.converted).toBe(0);
		expect(p.cockpitMirror.upsert).not.toHaveBeenCalled();
	});
});
