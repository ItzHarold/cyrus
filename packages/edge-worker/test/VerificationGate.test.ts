import { describe, expect, it } from "vitest";
import {
	extractPullRequestUrls,
	VerificationGate,
} from "../src/VerificationGate.js";

/**
 * Verify-before-client-sees store (PON-152). The properties that matter:
 * nothing here ever delivers on its own, the ladder marks fire exactly once,
 * and a replayed approval cannot deliver twice.
 */
describe("VerificationGate", () => {
	const entry = {
		workspaceId: "ws-1",
		issueIdentifier: "DVV-12",
		sessionId: "session-1",
		summary:
			"Done. PR: https://github.com/acme/webapp/pull/42 — preview deployed.",
		isError: false,
	};

	it("records pending work with the PR links parsed out", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		const record = gate.get("issue-1");
		expect(record?.state).toBe("in-verification");
		expect(record?.prUrls).toEqual(["https://github.com/acme/webapp/pull/42"]);
		expect(gate.isPending("issue-1")).toBe(true);
	});

	it("a continuation's later summary overwrites, the ladder clock does not restart", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		const firstCompletedAt = gate.get("issue-1")?.completedAt;
		gate.recordPending("issue-1", {
			...entry,
			summary: "Actually finished now. https://github.com/acme/webapp/pull/43",
		});
		expect(gate.get("issue-1")?.completedAt).toBe(firstCompletedAt);
		expect(gate.get("issue-1")?.prUrls).toEqual([
			"https://github.com/acme/webapp/pull/43",
		]);
	});

	it("delivery happens once — a replayed approval finds nothing pending", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		expect(gate.markDelivered("issue-1")).toBe(true);
		expect(gate.get("issue-1")?.state).toBe("delivered");
		expect(gate.get("issue-1")?.deliveredAt).toBeTruthy();
		expect(gate.markDelivered("issue-1")).toBe(false);
		expect(gate.isPending("issue-1")).toBe(false);
	});

	it("rejection clears the record entirely — the next completion starts a fresh ladder", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		gate.markEscalated("issue-1");
		const rejected = gate.reject("issue-1");
		expect(rejected?.summary).toContain("Done.");
		expect(gate.get("issue-1")).toBeUndefined();
		expect(gate.reject("issue-1")).toBeUndefined();
	});

	it("a delivered record cannot be rejected", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		gate.markDelivered("issue-1");
		expect(gate.reject("issue-1")).toBeUndefined();
		expect(gate.get("issue-1")?.state).toBe("delivered");
	});

	it("ladder marks fire exactly once each", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		expect(gate.markEscalated("issue-1")).toBe(true);
		expect(gate.markEscalated("issue-1")).toBe(false);
		expect(gate.markDelayNoted("issue-1")).toBe(true);
		expect(gate.markDelayNoted("issue-1")).toBe(false);
	});

	it("ladder marks survive a summary overwrite", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		gate.markEscalated("issue-1");
		gate.recordPending("issue-1", { ...entry, summary: "revised" });
		expect(gate.markEscalated("issue-1")).toBe(false);
	});

	it("lists only in-verification records", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-a", entry);
		gate.recordPending("issue-b", entry);
		gate.markDelivered("issue-b");
		expect(gate.listPending().map((r) => r.issueId)).toEqual(["issue-a"]);
	});

	it("round-trips through serialize/restore without becoming deliverable", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		const restored = new VerificationGate();
		restored.restore(gate.serialize());
		expect(restored.isPending("issue-1")).toBe(true);
		expect(restored.get("issue-1")?.summary).toBe(entry.summary);
		// Restore NEVER delivers — the state is exactly what was saved.
		expect(restored.get("issue-1")?.state).toBe("in-verification");
	});

	it("remove clears any state (terminal issue)", () => {
		const gate = new VerificationGate();
		gate.recordPending("issue-1", entry);
		gate.markDelivered("issue-1");
		expect(gate.remove("issue-1")).toBe(true);
		expect(gate.remove("issue-1")).toBe(false);
	});
});

describe("extractPullRequestUrls", () => {
	it("finds and dedupes PR links", () => {
		expect(
			extractPullRequestUrls(
				"See https://github.com/a/b/pull/1 and again https://github.com/a/b/pull/1 plus https://github.com/c/d-repo/pull/22.",
			),
		).toEqual([
			"https://github.com/a/b/pull/1",
			"https://github.com/c/d-repo/pull/22",
		]);
	});

	it("ignores non-PR GitHub links", () => {
		expect(
			extractPullRequestUrls(
				"https://github.com/a/b/issues/3 and https://github.com/a/b/commit/abc",
			),
		).toEqual([]);
	});
});
