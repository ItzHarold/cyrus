import { afterEach, describe, expect, it, vi } from "vitest";
import {
	markPullRequestReady,
	parsePullRequestUrl,
} from "../src/github-pr-ready.js";

describe("parsePullRequestUrl", () => {
	it("parses owner, repo, and number", () => {
		expect(
			parsePullRequestUrl("https://github.com/acme/web-app/pull/42"),
		).toEqual({ owner: "acme", repo: "web-app", number: 42 });
	});

	it("tolerates trailing paths and fragments", () => {
		expect(
			parsePullRequestUrl("https://github.com/acme/webapp/pull/42/files#diff"),
		).toEqual({ owner: "acme", repo: "webapp", number: 42 });
	});

	it("rejects non-PR urls", () => {
		expect(
			parsePullRequestUrl("https://github.com/acme/webapp/issues/42"),
		).toBeUndefined();
		expect(parsePullRequestUrl("https://example.com/pull/42")).toBeUndefined();
	});
});

describe("markPullRequestReady", () => {
	afterEach(() => vi.unstubAllGlobals());

	const pr = { owner: "acme", repo: "webapp", number: 42 };

	const stub = (
		lookup: { id: string; isDraft: boolean } | null,
		onMutation?: () => void,
	) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const { query } = JSON.parse(init.body) as { query: string };
				if (query.includes("markPullRequestReadyForReview")) {
					onMutation?.();
					return {
						ok: true,
						status: 200,
						json: async () => ({
							data: {
								markPullRequestReadyForReview: {
									pullRequest: { isDraft: false },
								},
							},
						}),
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({
						data: { repository: { pullRequest: lookup } },
					}),
				};
			}),
		);
	};

	it("flips a draft to ready", async () => {
		let mutated = false;
		stub({ id: "PR_1", isDraft: true }, () => {
			mutated = true;
		});
		await expect(markPullRequestReady("tok", pr)).resolves.toBe("ready");
		expect(mutated).toBe(true);
	});

	it("leaves an already-ready PR alone", async () => {
		let mutated = false;
		stub({ id: "PR_1", isDraft: false }, () => {
			mutated = true;
		});
		await expect(markPullRequestReady("tok", pr)).resolves.toBe(
			"already-ready",
		);
		expect(mutated).toBe(false);
	});

	it("throws when the PR is not visible to the token", async () => {
		stub(null);
		await expect(markPullRequestReady("tok", pr)).rejects.toThrow(
			"PR not found",
		);
	});

	it("throws on API errors instead of claiming success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 401,
				json: async () => ({ errors: [{ message: "bad credentials" }] }),
			})),
		);
		await expect(markPullRequestReady("tok", pr)).rejects.toThrow(
			"bad credentials",
		);
	});
});
