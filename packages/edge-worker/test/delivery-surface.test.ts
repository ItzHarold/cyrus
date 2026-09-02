import type { RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Delivery-surface cosmetics (2026-09-02): the preview and pull-request links
 * belong in the footer exactly once. A held summary that also names them shows
 * the client every link twice. `stripDeliveryLinks` removes the summary's copy.
 */

const repo = {
	id: "r",
	name: "Acme-Metrics",
	repositoryPath: "/tmp/a",
	workspaceBaseDir: "/tmp/aw",
	baseBranch: "main",
	linearWorkspaceId: "ws",
	linearToken: "t",
	isActive: true,
} as unknown as RepositoryConfig;

const priv = (w: unknown) => w as unknown as Record<string, any>;

// The real ACM-23 delivery summary that showed the links twice.
const SUMMARY = `The Overview page now tells you when the dashboard was last built.

At the very bottom of the page there is a single quiet line — for example, "Built 2 Sep 2026, 18:40 UTC".

Nothing else on the Overview page has changed.

You can see it here:

Preview: https://agent.pontedigital.co/preview/ofzATRU8heLmg1Q7qzNR6g

Pull request: https://github.com/acme-demo-corp/Acme-Metrics/pull/8

Open the preview, sign in as you normally would, go to Overview, and scroll to the bottom of the page.`;

describe("delivery surface — a link appears once, in the footer", () => {
	it("strips the preview and PR links (and their labels) from the summary", () => {
		const p = priv(createTestWorker([repo]));
		const out: string = p.stripDeliveryLinks(SUMMARY);

		// No delivery link survives in the summary.
		expect(out).not.toMatch(/agent\.pontedigital\.co\/preview/);
		expect(out).not.toMatch(/vercel\.app/);
		expect(out).not.toMatch(/github\.com\/[^\s)]+\/pull\/\d+/);
		// The bare labelled-link lines and their lead-in are gone.
		expect(out).not.toContain("Preview:");
		expect(out).not.toContain("Pull request:");
		expect(out).not.toContain("You can see it here:");
		// The substance survives.
		expect(out).toContain("Built 2 Sep 2026, 18:40 UTC");
		expect(out).toContain("Open the preview, sign in as you normally would");
		expect(out).toContain("Nothing else on the Overview page has changed.");
		// No gaping blank runs left behind.
		expect(out).not.toMatch(/\n\n\n/);
	});

	it("leaves a summary with no delivery links unchanged", () => {
		const p = priv(createTestWorker([repo]));
		const s =
			"The footer button now says Save.\n\nNothing else on the page changed.";
		expect(p.stripDeliveryLinks(s)).toBe(s);
	});

	it("keeps a link that is genuinely part of a sentence", () => {
		// Conservative: only bare labelled-link lines are dropped, so prose that
		// weaves a link into a sentence is preserved rather than mangled.
		const p = priv(createTestWorker([repo]));
		const s = "The change is described in github.com/acme/x/pull/9 in detail.";
		expect(p.stripDeliveryLinks(s)).toBe(s);
	});
});
