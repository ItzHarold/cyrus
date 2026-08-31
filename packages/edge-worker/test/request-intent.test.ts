import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import {
	buildDeliveredRequestBlock,
	buildReviewerRequestBlock,
} from "../src/request-intent.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-229: a question must never mutate the branch.
 *
 * Found live on CKP-22. The reviewer asked why a file had been split out —
 * a question about a decision — and the session edited files, committed,
 * pushed a second commit onto the branch under review and rewrote the pull
 * request description. The classification is intrinsic, so what is pinned
 * here is that the question is always ASKED: on the reviewer's thread, and
 * on a delivered client thread where the same mistake would be worse.
 */

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

describe("the blocks themselves", () => {
	it("tell the reviewer's session to change nothing when answering", () => {
		const b = buildReviewerRequestBlock();
		expect(b).toContain("Answer it and change NOTHING");
		expect(b).toContain("no commits, no pushes, no\npull-request edits");
		// The asymmetry is the load-bearing part: it says which way to fall.
		expect(b).toContain("treat it as a question");
	});

	it("tell a delivered client session to confirm before changing anything", () => {
		const b = buildDeliveredRequestBlock();
		expect(b).toContain("Do NOT\nstart working on it");
		expect(b).toContain("ask them to confirm");
		expect(b).toContain("treat it as a question");
		// Client register: never our process.
		expect(b).toContain("Never explain\nour internal process");
	});

	it("both name a question as a question even when the answer is 'you were right'", () => {
		expect(buildReviewerRequestBlock()).toContain("they stay questions even");
	});
});

describe("wiring", () => {
	let worker: EdgeWorker;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		worker = createTestWorker([]);
	});

	it("a delivered client issue's session is asked what the message is", () => {
		const p = privates(worker);
		p.sessionIssueId = () => "issue-1";
		p.verificationGate.recordPending("issue-1", {
			workspaceId: "ws",
			sessionId: "sess-1",
			summary: "done",
			isError: false,
		});
		p.verificationGate.markDelivered("issue-1");

		expect(p.sessionRuleBlocks("sess-1")).toContain("<what_is_being_asked>");
	});

	it("an undelivered client session is NOT — it has no delivered work to be asked about", () => {
		const p = privates(worker);
		p.sessionIssueId = () => "issue-1";

		expect(p.sessionRuleBlocks("sess-1")).not.toContain(
			"<what_is_being_asked>",
		);
	});

	it("an operator session still gets neither client block", () => {
		const p = privates(worker);
		p.operatorSessions.register({
			mirrorSessionId: "mirror-1",
			mirrorIssueId: "ckp-1",
			clientSessionId: "sess-1",
			clientIssueId: "issue-1",
			clientWorkspaceId: "ws",
			cockpitWorkspaceId: "cockpit",
			repositoryId: "repo",
			startedAt: new Date().toISOString(),
		});

		expect(p.sessionRuleBlocks("mirror-1")).toBe("");
	});
});
