import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * PON-239 — the client's session must carry the work, not just describe it.
 *
 * A delivery that only posts prose leaves the client with links in text: no
 * Diff tab, no merge button, nothing to act on where they are standing. The
 * external URLs on their agent session are what Linear renders as the native
 * surface, so every delivery has to set them — this is the regression guard
 * that it keeps happening.
 */

const WS = "ws-acme";
const _ISSUE = "issue-acm-21";
const CLIENT_SESSION = "sess-client";
const MIRROR_SESSION = "sess-mirror";
const PR = "https://github.com/Ponte-Digital/Acme-Metrics/pull/6";
const PREVIEW =
	"https://acme-f9g4-ponte.vercel.app/?x-vercel-protection-bypass=t";

function privates(w: EdgeWorker): Record<string, any> {
	return w as never as Record<string, any>;
}

function worker() {
	const w = createTestWorker([]);
	const p = privates(w);
	const updateAgentSession = vi.fn().mockResolvedValue(true);
	p.issueTrackers.set(WS, { updateAgentSession });
	return { p, updateAgentSession };
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("delivery attaches the work to the client's own session", () => {
	it("sets the pull request AND the preview as external URLs", async () => {
		const { p, updateAgentSession } = worker();

		await p.attachClientDeliveryLinks(
			{ sessionId: CLIENT_SESSION, workspaceId: WS },
			[PR],
			PREVIEW,
		);

		expect(updateAgentSession).toHaveBeenCalledWith(CLIENT_SESSION, {
			addedExternalUrls: [
				{ url: PR, label: "Pull request" },
				{ url: PREVIEW, label: "Preview" },
			],
		});
	});

	it("targets the CLIENT session, never the mirror", async () => {
		// The mirror is where the reviewer stands; the client's native surface
		// has to hang off the session on THEIR issue. Getting this backwards
		// renders the delivery on the cockpit and leaves the client with prose.
		const { p, updateAgentSession } = worker();
		p.operatorSessions.set?.(MIRROR_SESSION, {
			mirrorSessionId: MIRROR_SESSION,
			clientSessionId: CLIENT_SESSION,
		});

		await p.attachClientDeliveryLinks(
			{ sessionId: CLIENT_SESSION, workspaceId: WS },
			[PR],
			PREVIEW,
		);

		expect(updateAgentSession.mock.calls[0][0]).toBe(CLIENT_SESSION);
		expect(updateAgentSession.mock.calls[0][0]).not.toBe(MIRROR_SESSION);
	});

	it("carries the preview link with its access value intact", async () => {
		// Stripping the bypass here would hand the client a link that opens a
		// hosting-provider login they cannot pass (PON-238).
		const { p, updateAgentSession } = worker();

		await p.attachClientDeliveryLinks(
			{ sessionId: CLIENT_SESSION, workspaceId: WS },
			[PR],
			PREVIEW,
		);

		const sent = updateAgentSession.mock.calls[0][1].addedExternalUrls;
		expect(sent.find((u: any) => u.label === "Preview").url).toContain(
			"x-vercel-protection-bypass=",
		);
	});

	it("says nothing rather than sending an empty update", async () => {
		const { p, updateAgentSession } = worker();
		await p.attachClientDeliveryLinks(
			{ sessionId: CLIENT_SESSION, workspaceId: WS },
			[],
			undefined,
		);
		expect(updateAgentSession).not.toHaveBeenCalled();
	});

	it("a failure to attach never fails the delivery", async () => {
		// The summary is the delivery. Losing the native surface is a
		// degradation; losing the client's summary is the product failing.
		const { p } = worker();
		p.issueTrackers.set(WS, {
			updateAgentSession: vi.fn().mockRejectedValue(new Error("boom")),
		});

		await expect(
			p.attachClientDeliveryLinks(
				{ sessionId: CLIENT_SESSION, workspaceId: WS },
				[PR],
				PREVIEW,
			),
		).resolves.toBeUndefined();
	});
});
