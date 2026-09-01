import { beforeEach, describe, expect, it, vi } from "vitest";

/** Controlled per test; the rest of the module stays real. */
const fetchPreview = vi.hoisted(() => vi.fn());
vi.mock("../src/preview-deployment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/preview-deployment.js")>()),
	fetchPreviewDeployment: fetchPreview,
}));

import type { EdgeWorker } from "../src/EdgeWorker.js";
import { containsBypassToken } from "../src/preview-deployment.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * The client's preview bypass value is a credential. A mirror description is
 * the worst place to keep one: persisted, rewritten into every later
 * transition, and printed verbatim by any read of the issue — which is how
 * it reached this project's own terminal output twice.
 *
 * It is published as a session link instead. Same access, same click.
 */

const WS = "ws-acme";
const COCKPIT_WS = "ws-cockpit";
const ISSUE = "issue-acm-21";
const MIRROR_SESSION = "sess-mirror";
const BYPASS = "0123456789abcdef0123456789abcdef";
const READY = `https://acme-f9g4-ponte.vercel.app/?x-vercel-protection-bypass=${BYPASS}&x-vercel-set-bypass-cookie=true`;

function privates(w: EdgeWorker): Record<string, any> {
	return w as never as Record<string, any>;
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

function worker() {
	const w = createTestWorker([]);
	const p = privates(w);
	p.config.cockpit = {
		linearWorkspaceId: COCKPIT_WS,
		workspaceName: "Cockpit",
		teamId: "t",
	};
	p.config.linearWorkspaces = { [WS]: { previewBypassToken: BYPASS } };
	const updateAgentSession = vi.fn().mockResolvedValue(true);
	p.issueTrackers.set(COCKPIT_WS, { updateAgentSession });
	p.operatorSessions.forClientIssue = vi
		.fn()
		.mockReturnValue({ mirrorSessionId: MIRROR_SESSION });
	p.verificationGate.recordPending(ISSUE, {
		workspaceId: WS,
		sessionId: "s",
		summary: "done",
		isError: false,
	});
	p.buildCheckoutInstructions = vi.fn().mockResolvedValue("");
	p.captureSummaryHead = vi.fn().mockResolvedValue(undefined);
	p.describePullRequests = vi.fn().mockResolvedValue("");
	const upsert = vi.fn();
	p.cockpitMirror.upsert = upsert;
	return { p, upsert, updateAgentSession };
}

describe("the reviewer's preview link", () => {
	it("is published as a session link, not written into the description", async () => {
		const { p, upsert, updateAgentSession } = worker();
		p.buildStartHereBlock = vi.fn(async (_p: any, _w: any, onUrl: any) => {
			onUrl?.(READY);
			return "**Preview:** open it from the **Preview** link on this session — it carries the client's access value, which is deliberately not written into this description.";
		});

		await p.composeVerificationMirror(ISSUE);

		const note = upsert.mock.calls[0][3].note as string;
		expect(containsBypassToken(note)).toBe(false);
		expect(note).toContain("Preview");

		expect(updateAgentSession).toHaveBeenCalledWith(MIRROR_SESSION, {
			addedExternalUrls: [{ url: READY, label: "Preview" }],
		});
	});

	it("still describes the mirror when the session link cannot be published", async () => {
		// The review block is the deliverable; a mirror that cannot take a
		// session link must still get its description.
		const { p, upsert } = worker();
		p.issueTrackers.set(COCKPIT_WS, {
			updateAgentSession: vi.fn().mockRejectedValue(new Error("nope")),
		});
		p.buildStartHereBlock = vi.fn(async (_p: any, _w: any, onUrl: any) => {
			onUrl?.(READY);
			return "**Preview:** on this session.";
		});

		await expect(p.composeVerificationMirror(ISSUE)).resolves.toBeUndefined();
		expect(upsert).toHaveBeenCalled();
	});

	it("publishes nothing when there is no bypassed preview to publish", async () => {
		const { p, updateAgentSession } = worker();
		p.buildStartHereBlock = vi.fn().mockResolvedValue("**Preview:** none.");

		await p.composeVerificationMirror(ISSUE);

		expect(updateAgentSession).not.toHaveBeenCalled();
	});
});

describe("the block that actually writes the description", () => {
	it("emits no bypass value, and hands the tokenized link to the caller", async () => {
		// Tested against the REAL buildStartHereBlock. The tests above mock
		// it, which would make the whole guarantee vacuous on its own — the
		// function under test would be the mock.
		const w = createTestWorker([]);
		const p = privates(w);
		p.config.linearWorkspaces = { [WS]: { previewBypassToken: BYPASS } };
		p.previewDataSeparationFor = vi.fn().mockReturnValue("confirmed");
		p.mintGitHubTokenForRepo = vi.fn().mockResolvedValue("tok");
		p.fetchPullRequestFacts = vi.fn().mockResolvedValue({
			headSha: "0f7d1a3",
			files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
			truncated: false,
		});
		p.testAccountLines = vi.fn().mockReturnValue([]);
		fetchPreview.mockResolvedValue({
			state: "ready",
			url: READY,
			sha: "0f7d1a35b11b",
		});

		const handed: string[] = [];
		const block = await p.buildStartHereBlock(
			["https://github.com/Ponte-Digital/Acme-Metrics/pull/6"],
			WS,
			(u: string) => handed.push(u),
		);

		expect(containsBypassToken(block)).toBe(false);
		// And not the bare URL either — that is the login-walled link the
		// delivery path stopped shipping; a reviewer gets the same rule.
		expect(block).not.toContain("vercel.app");
		expect(block).toContain("Preview");
		expect(handed).toEqual([READY]);
	});
});
