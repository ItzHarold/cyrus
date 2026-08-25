import { describe, expect, it } from "vitest";
import { ScopeApprovalStore } from "../src/ScopeApprovalStore.js";

/**
 * Scope-approval state machine (PON-150). The property that matters most:
 * `approvedAt` is the SLA clock start, written exactly once — a replayed
 * answer webhook must not move it.
 */
describe("ScopeApprovalStore", () => {
	it("records a proposal with proposedAt and context", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1", {
			workspaceId: "ws-1",
			issueIdentifier: "DVV-9",
		});

		const record = store.get("issue-1");
		expect(record?.state).toBe("awaiting");
		expect(record?.proposedAt).toBeTruthy();
		expect(record?.workspaceId).toBe("ws-1");
		expect(record?.issueIdentifier).toBe("DVV-9");
		expect(store.isApproved("issue-1")).toBe(false);
	});

	it("keeps the FIRST proposedAt across a revise → re-ask cycle", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");
		const firstProposedAt = store.get("issue-1")?.proposedAt;

		store.recordRevised("issue-1");
		expect(store.get("issue-1")?.state).toBe("revised");
		expect(store.get("issue-1")?.revisions).toBe(1);

		store.recordProposed("issue-1");
		expect(store.get("issue-1")?.state).toBe("awaiting");
		expect(store.get("issue-1")?.proposedAt).toBe(firstProposedAt);
		expect(store.get("issue-1")?.revisions).toBe(1);
	});

	it("records approval exactly once — a replay cannot move the SLA clock", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");

		expect(store.recordApproved("issue-1")).toBe(true);
		const approvedAt = store.get("issue-1")?.approvedAt;
		expect(approvedAt).toBeTruthy();
		expect(store.isApproved("issue-1")).toBe(true);

		// The replayed answer webhook.
		expect(store.recordApproved("issue-1")).toBe(false);
		expect(store.get("issue-1")?.approvedAt).toBe(approvedAt);
	});

	it("approval is terminal: proposals and revisions after it are no-ops", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");
		store.recordApproved("issue-1");

		store.recordProposed("issue-1");
		expect(store.get("issue-1")?.state).toBe("approved");
		expect(store.recordRevised("issue-1")).toBe(false);
		expect(store.get("issue-1")?.state).toBe("approved");
	});

	it("tolerates approval with no prior record (crash before the proposal persisted)", () => {
		const store = new ScopeApprovalStore();
		expect(store.recordApproved("issue-1", { workspaceId: "ws-1" })).toBe(true);
		const record = store.get("issue-1");
		expect(record?.state).toBe("approved");
		expect(record?.approvedAt).toBeTruthy();
		expect(record?.proposedAt).toBeTruthy();
		expect(record?.workspaceId).toBe("ws-1");
	});

	it("a consecutive revise without a re-ask is a replay — not counted", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");
		expect(store.recordRevised("issue-1")).toBe(true);
		// The replayed/duplicate answer webhook: no re-ask happened between.
		expect(store.recordRevised("issue-1")).toBe(false);
		expect(store.get("issue-1")?.revisions).toBe(1);
	});

	it("tolerates a revision with no prior record", () => {
		const store = new ScopeApprovalStore();
		expect(store.recordRevised("issue-1")).toBe(true);
		expect(store.get("issue-1")?.state).toBe("revised");
		expect(store.get("issue-1")?.revisions).toBe(1);
	});

	it("counts revisions across cycles and carries them into the approval record", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");
		store.recordRevised("issue-1");
		store.recordProposed("issue-1");
		store.recordRevised("issue-1");
		store.recordProposed("issue-1");
		store.recordApproved("issue-1");

		expect(store.get("issue-1")?.revisions).toBe(2);
		expect(store.get("issue-1")?.state).toBe("approved");
	});

	it("lists only open gates as pending", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-await", { issueIdentifier: "DVV-1" });
		store.recordProposed("issue-revised");
		store.recordRevised("issue-revised");
		store.recordProposed("issue-approved");
		store.recordApproved("issue-approved");

		const pending = store.listPending().map((entry) => entry.issueId);
		expect(pending).toContain("issue-await");
		expect(pending).toContain("issue-revised");
		expect(pending).not.toContain("issue-approved");
	});

	it("round-trips through serialize/restore without losing the clock", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1", {
			workspaceId: "ws-1",
			issueIdentifier: "DVV-9",
		});
		store.recordRevised("issue-1");
		store.recordProposed("issue-2");
		store.recordApproved("issue-2");
		const approvedAt = store.get("issue-2")?.approvedAt;

		const restored = new ScopeApprovalStore();
		restored.restore(store.serialize());

		expect(restored.get("issue-1")?.state).toBe("revised");
		expect(restored.get("issue-1")?.revisions).toBe(1);
		expect(restored.get("issue-1")?.workspaceId).toBe("ws-1");
		expect(restored.isApproved("issue-2")).toBe(true);
		expect(restored.get("issue-2")?.approvedAt).toBe(approvedAt);
		// A replayed approval after restore still cannot move the clock.
		expect(restored.recordApproved("issue-2")).toBe(false);
	});

	it("restore(undefined) clears to empty (older state files)", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");
		store.restore(undefined);
		expect(store.size).toBe(0);
		expect(store.isApproved("issue-1")).toBe(false);
	});

	it("serialize returns copies — mutating the snapshot does not corrupt the store", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");
		const snapshot = store.serialize();
		snapshot["issue-1"]!.state = "approved";
		expect(store.isApproved("issue-1")).toBe(false);
	});

	it("remove clears a record and reports whether one existed", () => {
		const store = new ScopeApprovalStore();
		store.recordProposed("issue-1");
		expect(store.remove("issue-1")).toBe(true);
		expect(store.remove("issue-1")).toBe(false);
		expect(store.get("issue-1")).toBeUndefined();
	});

	// PON-169: the operator note rides the record.
	describe("operator note (PON-169)", () => {
		it("records a note on an existing record; the latest note replaces the previous", () => {
			const store = new ScopeApprovalStore();
			store.recordProposed("issue-1");
			store.recordOperatorNote("issue-1", "first reading");
			store.recordOperatorNote("issue-1", "revised reading");
			expect(store.get("issue-1")?.operatorNote).toBe("revised reading");
			expect(store.get("issue-1")?.operatorNoteAt).toBeDefined();
		});

		it("a note before any proposal creates an awaiting record; recordProposed keeps its proposedAt", () => {
			const store = new ScopeApprovalStore();
			store.recordOperatorNote("issue-1", "note-first reading");
			const early = store.get("issue-1");
			expect(early?.state).toBe("awaiting");
			expect(early?.operatorNote).toBe("note-first reading");

			store.recordProposed("issue-1", { issueIdentifier: "DVV-12" });
			expect(store.get("issue-1")?.proposedAt).toBe(early?.proposedAt);
			expect(store.get("issue-1")?.operatorNote).toBe("note-first reading");
		});

		it("the note survives approval — it is what the operator approved against", () => {
			const store = new ScopeApprovalStore();
			store.recordProposed("issue-1");
			store.recordOperatorNote("issue-1", "the internal reading");
			expect(store.recordApproved("issue-1")).toBe(true);
			expect(store.get("issue-1")?.operatorNote).toBe("the internal reading");
			expect(store.get("issue-1")?.operatorNoteAt).toBeDefined();
		});

		it("a note after approval still records (mid-work update)", () => {
			const store = new ScopeApprovalStore();
			store.recordProposed("issue-1");
			store.recordApproved("issue-1");
			store.recordOperatorNote("issue-1", "post-approval update");
			expect(store.get("issue-1")?.state).toBe("approved");
			expect(store.get("issue-1")?.operatorNote).toBe("post-approval update");
		});

		it("the note round-trips through serialize/restore", () => {
			const store = new ScopeApprovalStore();
			store.recordProposed("issue-1");
			store.recordOperatorNote("issue-1", "persist me");
			const restored = new ScopeApprovalStore();
			restored.restore(store.serialize());
			expect(restored.get("issue-1")?.operatorNote).toBe("persist me");
		});
	});
});
