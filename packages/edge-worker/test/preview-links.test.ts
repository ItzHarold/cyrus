import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorker } from "../src/EdgeWorker.js";
import {
	opaquePreviewUrl,
	PreviewLinkStore,
	publicBaseUrlFrom,
	stripPreviewBypass,
} from "../src/preview-links.js";
import { createTestWorker } from "./prompt-assembly-utils.js";

/**
 * Opaque preview links (v3.1 P3.1): the client's bypass value never leaves
 * the box. Links carry an id; the box redirects with the tenant's CURRENT
 * value applied at request time; links die with the issue.
 */

const WS = "ws-acme";
const ISSUE = "issue-acm-21";
const BARE = "https://acme-f9g4-ponte.vercel.app/";
const TOKENIZED = `${BARE}?x-vercel-protection-bypass=tok-old&x-vercel-set-bypass-cookie=true`;

function privates(w: EdgeWorker): Record<string, any> {
	return w as never as Record<string, any>;
}

describe("the store", () => {
	it("mints an unguessable id, once per (issue, target), and strips the credential from what it keeps", () => {
		const store = new PreviewLinkStore();
		const a = store.mint(TOKENIZED, { issueId: ISSUE, workspaceId: WS });
		const again = store.mint(BARE, { issueId: ISSUE, workspaceId: WS });
		expect(again).toBe(a);
		expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(store.resolve(a)?.target).toBe(BARE);
		expect(JSON.stringify(store.serialize())).not.toContain("tok-old");
	});

	it("a different issue gets a different id for the same target", () => {
		const store = new PreviewLinkStore();
		const a = store.mint(BARE, { issueId: ISSUE, workspaceId: WS });
		const b = store.mint(BARE, { issueId: "issue-other", workspaceId: WS });
		expect(b).not.toBe(a);
	});

	it("revokes every link of an issue, and survives a restart", () => {
		const store = new PreviewLinkStore();
		const a = store.mint(BARE, { issueId: ISSUE, workspaceId: WS });
		const other = store.mint(BARE, { issueId: "issue-other", workspaceId: WS });
		const restored = new PreviewLinkStore();
		restored.restore(store.serialize());
		expect(restored.resolve(a)?.issueId).toBe(ISSUE);
		expect(restored.revokeForIssue(ISSUE)).toBe(1);
		expect(restored.resolve(a)).toBeUndefined();
		expect(restored.resolve(other)).toBeDefined();
	});

	it("reads the public base from CYRUS_BASE_URL and refuses anything else", () => {
		expect(publicBaseUrlFrom("https://agent.example/")).toBe(
			"https://agent.example",
		);
		expect(publicBaseUrlFrom("  ")).toBeUndefined();
		expect(publicBaseUrlFrom("agent.example")).toBeUndefined();
		expect(opaquePreviewUrl("https://agent.example", "abc")).toBe(
			"https://agent.example/preview/abc",
		);
		expect(stripPreviewBypass("not a url")).toBe("not a url");
	});
});

describe("the links the worker publishes", () => {
	let p: Record<string, any>;
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.CYRUS_BASE_URL = "https://agent.example";
		p = privates(createTestWorker([]));
		p.config.linearWorkspaces = {
			[WS]: { linearToken: "t", previewBypassToken: "tok-now" },
		};
		p.savePersistedState = vi.fn().mockResolvedValue(undefined);
	});
	afterEach(() => {
		delete process.env.CYRUS_BASE_URL;
	});

	it("carry no credential, and resolve to the tenant's CURRENT value", () => {
		const link = p.opaquePreviewLink(TOKENIZED, ISSUE, WS);
		expect(link).toMatch(
			/^https:\/\/agent\.example\/preview\/[A-Za-z0-9_-]{22}$/,
		);
		expect(link).not.toContain("tok-old");
		const id = link.split("/preview/")[1];
		const outcome = p.previewRedirectFor(id);
		expect(outcome.status).toBe(302);
		expect(outcome.location).toBe(
			`${BARE}?x-vercel-protection-bypass=tok-now&x-vercel-set-bypass-cookie=true`,
		);
	});

	it("an unknown or revoked id is a 404, not a redirect to nowhere", () => {
		expect(p.previewRedirectFor("nope").status).toBe(404);
		const link = p.opaquePreviewLink(BARE, ISSUE, WS);
		const id = link.split("/preview/")[1];
		p.previewLinks.revokeForIssue(ISSUE);
		expect(p.previewRedirectFor(id).status).toBe(404);
	});

	it("fall back to the direct link, loudly, when the box has no public base", () => {
		delete process.env.CYRUS_BASE_URL;
		const warn = vi.spyOn(p.logger, "warn");
		expect(p.opaquePreviewLink(TOKENIZED, ISSUE, WS)).toBe(TOKENIZED);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("CYRUS_BASE_URL"),
		);
	});

	it("a preview URL left in the prose becomes an opaque link too", () => {
		const out = p.bypassPreviewLinksIn(
			`See it at ${BARE}dashboard.`,
			WS,
			ISSUE,
		);
		expect(out).toMatch(
			/https:\/\/agent\.example\/preview\/[A-Za-z0-9_-]{22}\./,
		);
		expect(out).not.toContain("tok-now");
	});

	it("persists across a restart", () => {
		const link = p.opaquePreviewLink(BARE, ISSUE, WS);
		const id = link.split("/preview/")[1];
		const snapshot = p.previewLinks.serialize();
		const fresh = privates(createTestWorker([]));
		fresh.config.linearWorkspaces = p.config.linearWorkspaces;
		fresh.previewLinks.restore(snapshot);
		expect(fresh.previewRedirectFor(id).status).toBe(302);
	});
});
