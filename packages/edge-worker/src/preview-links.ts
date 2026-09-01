/**
 * Opaque preview links (v3.1 P3.1).
 *
 * A preview bypass value is the client's credential: it opens every
 * protected preview in their hosting project, not just the one we linked.
 * Until now it travelled inside every preview URL we published — a session
 * link on the reviewer's thread, the client's delivery, the client's own
 * session links — and so it lived in Linear, in notification emails, in
 * browser histories, and twice in this project's own terminal output.
 *
 * Now a link is `<public base>/preview/<opaque id>`. The box resolves the id
 * to the bare preview URL and redirects with the tenant's CURRENT bypass
 * value applied at request time, so the credential never leaves the box and
 * a rotated value does not kill links already sent. Links are revoked per
 * client issue when the issue ends.
 *
 * The id is 128 random bits, base64url. Minting is idempotent per
 * (issue, target): the mirror recomposes every few minutes and a fresh id
 * per recompose would add a new "Preview" button to the reviewer's session
 * each time.
 */

import { randomBytes } from "node:crypto";
import type { SerializedPreviewLink } from "cyrus-core";

const BYPASS_PARAMS = [
	"x-vercel-protection-bypass",
	"x-vercel-set-bypass-cookie",
];

/** The preview URL without the bypass parameters. Unparseable input is returned as is. */
export function stripPreviewBypass(url: string): string {
	try {
		const parsed = new URL(url);
		for (const key of BYPASS_PARAMS) parsed.searchParams.delete(key);
		return parsed.toString();
	} catch {
		return url;
	}
}

/**
 * The public origin of this box, from `CYRUS_BASE_URL` (the same variable
 * the OAuth callback uses). Undefined when unset or not an http(s) URL —
 * callers then fall back to the direct link, loudly.
 */
export function publicBaseUrlFrom(raw: string | undefined): string | undefined {
	const value = raw?.trim().replace(/\/+$/, "");
	if (!value || !/^https?:\/\//i.test(value)) return undefined;
	return value;
}

export function opaquePreviewUrl(baseUrl: string, id: string): string {
	return `${baseUrl}/preview/${id}`;
}

export class PreviewLinkStore {
	private links = new Map<string, SerializedPreviewLink>();

	/** Returns the id for this (issue, target), minting one if needed. */
	mint(
		target: string,
		context: { issueId: string; workspaceId: string },
	): string {
		const bare = stripPreviewBypass(target);
		for (const [id, record] of this.links) {
			if (record.issueId === context.issueId && record.target === bare) {
				return id;
			}
		}
		const id = randomBytes(16).toString("base64url");
		this.links.set(id, {
			target: bare,
			issueId: context.issueId,
			workspaceId: context.workspaceId,
			createdAt: new Date().toISOString(),
		});
		return id;
	}

	resolve(id: string): SerializedPreviewLink | undefined {
		return this.links.get(id);
	}

	/** The issue is over: every link for it stops opening. Returns how many. */
	revokeForIssue(issueId: string): number {
		let removed = 0;
		for (const [id, record] of this.links) {
			if (record.issueId === issueId) {
				this.links.delete(id);
				removed++;
			}
		}
		return removed;
	}

	serialize(): Record<string, SerializedPreviewLink> {
		return Object.fromEntries(
			[...this.links.entries()].map(([id, r]) => [id, { ...r }]),
		);
	}

	restore(records: Record<string, SerializedPreviewLink> | undefined): void {
		this.links.clear();
		if (!records) return;
		for (const [id, record] of Object.entries(records)) {
			this.links.set(id, { ...record });
		}
	}

	get size(): number {
		return this.links.size;
	}
}
