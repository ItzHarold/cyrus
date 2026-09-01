import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/** Controlled per test; `withPreviewBypass` stays the real implementation. */
const fetchPreview = vi.hoisted(() => vi.fn());
vi.mock("../src/preview-deployment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/preview-deployment.js")>()),
	fetchPreviewDeployment: fetchPreview,
}));

/**
 * PON-238 — three defects Harold found while reading a delivery before
 * releasing it, plus the one that would have destroyed it.
 */

const WS = "ws-acme";
const ISSUE = "issue-acm-21";
const ORIGIN = { owner: "Ponte-Digital", repo: "Acme-Metrics" };
const BYPASS = "0123456789abcdef0123456789abcdef";

function privates(worker: EdgeWorker): Record<string, any> {
	return worker as never as Record<string, any>;
}

function worker() {
	const w = createTestWorker([]);
	const p = privates(w);
	p.config.linearWorkspaces = { [WS]: { previewBypassToken: BYPASS } };
	return p;
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	fetchPreview.mockReset();
});

describe("the client gets one preview link, and it opens", () => {
	const record = (over: Record<string, unknown> = {}) => ({
		workspaceId: WS,
		sessionId: "s",
		summary: "Done.\n\nPreview: https://acme-3fvg-ponte.vercel.app",
		isError: false,
		capturedHeadSha: "0f7d1a35b11b3753de46b2f9d46829671085585d",
		...over,
	});

	it("resolves the link for the commit the summary describes, not the prose", async () => {
		// The prose link is whatever commit the run finished on; the reviewer
		// verified the head as it now stands. Shipping the prose one sends the
		// client to a different build than the one that was checked.
		const p = worker();
		p.mintGitHubTokenForRepo = vi.fn().mockResolvedValue("tok");
		fetchPreview.mockResolvedValue({
			state: "ready",
			url: `https://acme-0f7d-ponte.vercel.app/?x-vercel-protection-bypass=${BYPASS}`,
		});

		const url = await p.clientPreviewUrl(record(), ORIGIN);

		expect(url).toContain("acme-0f7d");
		expect(url).not.toContain("acme-3fvg");
	});

	it("never offers a deployment that is not ready", async () => {
		// A link that 404s while it builds teaches the client the link lies.
		const p = worker();
		p.mintGitHubTokenForRepo = vi.fn().mockResolvedValue("tok");
		fetchPreview.mockResolvedValue({ state: "building", url: undefined });
		const url = await p.clientPreviewUrl(
			record({ summary: "Done. No link here." }),
			ORIGIN,
		);
		expect(url).toBeUndefined();
	});

	it("falls back to the prose link rather than shipping none", async () => {
		// A legacy record has no captured head. A delivery with no way to see
		// the work is worse than one whose link came from prose.
		const p = worker();
		const url = await p.clientPreviewUrl(
			record({ capturedHeadSha: undefined }),
			ORIGIN,
		);
		expect(url).toContain("acme-3fvg");
		expect(url).toContain("x-vercel-protection-bypass");
	});
});

describe("no bare login-walled link reaches the client", () => {
	it("applies the access value to a preview URL left in the prose", () => {
		const p = worker();
		const out = p.bypassPreviewLinksIn(
			"You can see it here: https://acme-3fvg-ponte.vercel.app and that's it.",
			WS,
		);
		expect(out).toContain(`x-vercel-protection-bypass=${BYPASS}`);
		// The one Harold followed 302'd to a hosting-provider login page.
		expect(out).not.toMatch(/vercel\.app\s/);
	});

	it("leaves an unconfigured tenant's text exactly as it was", () => {
		const p = worker();
		p.config.linearWorkspaces = { [WS]: {} };
		const text = "See https://acme-3fvg-ponte.vercel.app";
		expect(p.bypassPreviewLinksIn(text, WS)).toBe(text);
	});
});

describe("the summary renders as its own section", () => {
	it("puts a blank line before the heading so Markdown ends the file list", async () => {
		// It was a bare "" element, which .filter(Boolean) removed — so the
		// heading landed directly after the last `Files changed` bullet and
		// Markdown read it as a continuation of that list item. Harold could
		// not find the summary on the mirror because it was rendered inside
		// the file list, attached to the last file.
		const p = worker();
		p.verificationGate.recordPending(ISSUE, {
			workspaceId: WS,
			sessionId: "s",
			summary: "Your dashboard now explains itself.",
			isError: false,
		});
		p.buildCheckoutInstructions = vi.fn().mockResolvedValue("");
		p.captureSummaryHead = vi.fn().mockResolvedValue(undefined);
		p.describePullRequests = vi.fn().mockResolvedValue("");
		p.buildStartHereBlock = vi
			.fn()
			.mockResolvedValue(
				"**Files changed** (1):\n- `src/lib/metric-definitions.ts` (+196/-0)",
			);
		const upsert = vi.fn();
		p.cockpitMirror.upsert = upsert;

		await p.composeVerificationMirror(ISSUE);

		const note = upsert.mock.calls[0][3].note as string;
		expect(note).toContain("(+196/-0)\n\n**What the session reported:**");
	});
});

describe("a rejection that cannot resume must not destroy the summary", () => {
	function gated(resumable: boolean) {
		const p = worker();
		p.savePersistedStateStrict = vi.fn().mockResolvedValue(undefined);
		p.verificationGate.recordPending(ISSUE, {
			workspaceId: WS,
			sessionId: "sess-client",
			summary: "The client's summary, which exists nowhere else in full.",
			isError: false,
		});
		p.agentSessionManager.getSession = vi.fn(() =>
			resumable ? { id: "sess-client" } : undefined,
		);
		if (resumable) {
			p.sessionRepositories.set("sess-client", "repo-1");
			p.repositories.set("repo-1", { id: "repo-1" });
		}
		p.resumeAgentSession = vi.fn().mockResolvedValue(undefined);
		p.cockpitMirror.upsert = vi.fn();
		return p;
	}

	it("keeps the record when the session is gone", async () => {
		const p = gated(false);

		const out = await p.rejectVerifiedWork(ISSUE, "rewrite it");

		expect(out).toContain("NOT recorded");
		// The whole point: still deliverable.
		expect(p.verificationGate.get(ISSUE)?.summary).toContain(
			"which exists nowhere else in full",
		);
		expect(p.verificationGate.get(ISSUE)?.state).toBe("in-verification");
	});

	it("clears it and resumes when the session is there", async () => {
		const p = gated(true);

		await p.rejectVerifiedWork(ISSUE, "rewrite it");

		expect(p.verificationGate.get(ISSUE)).toBeUndefined();
		expect(p.resumeAgentSession).toHaveBeenCalled();
	});

	it("asks the rewrite to HAND the summary over, with no links in it", async () => {
		// Otherwise every regeneration silently falls back to scraping the
		// final message — the failure PON-235 exists to remove.
		const p = gated(true);

		await p.rejectVerifiedWork(ISSUE, "rewrite it");

		const prompt = p.resumeAgentSession.mock.calls[0][4] as string;
		expect(prompt).toContain("client_summary");
		expect(prompt).toContain("record_operator_note");
		expect(prompt).toMatch(/Do NOT put any preview or pull-request URL/);
	});
});
