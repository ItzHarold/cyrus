import { describe, expect, it } from "vitest";
import {
	SessionLinkTracker,
	SessionPlanTracker,
} from "../src/SessionSurface.js";

describe("SessionPlanTracker", () => {
	// Honest-or-absent: a missing checklist reads as "this agent doesn't show
	// plans"; an empty or half-filled one reads as broken. Absence is the
	// designed fallback, not an accident.
	describe("publishes nothing rather than something broken", () => {
		it("returns null when no tasks exist", () => {
			expect(new SessionPlanTracker().snapshot()).toBeNull();
		});

		it("never returns an empty array", () => {
			const t = new SessionPlanTracker();
			t.addTask("", "ignored");
			t.addTask("1", "   ");
			expect(t.snapshot()).toBeNull();
		});

		it("returns null once disabled after a failed publish", () => {
			const t = new SessionPlanTracker();
			t.addTask("1", "Do the thing");
			expect(t.snapshot()).not.toBeNull();
			t.disable();
			expect(t.snapshot()).toBeNull();
			expect(t.isDisabled).toBe(true);
		});

		// A step whose content was never seen would render as a blank row.
		it("ignores updates for tasks it never saw", () => {
			const t = new SessionPlanTracker();
			t.updateTask("99", "completed");
			expect(t.snapshot()).toBeNull();
		});
	});

	describe("mirrors the real task list", () => {
		it("keeps creation order and starts every step pending", () => {
			const t = new SessionPlanTracker();
			t.addTask("1", "Read the failing test");
			t.addTask("2", "Fix the bucketing");
			t.addTask("3", "Open a PR");
			expect(t.snapshot()).toEqual([
				{ content: "Read the failing test", status: "pending" },
				{ content: "Fix the bucketing", status: "pending" },
				{ content: "Open a PR", status: "pending" },
			]);
		});

		it("maps Cyrus task statuses onto plan statuses", () => {
			const t = new SessionPlanTracker();
			t.addTask("1", "a");
			t.addTask("2", "b");
			t.updateTask("1", "in_progress");
			t.updateTask("2", "completed");
			expect(t.snapshot()?.map((s) => s.status)).toEqual([
				"inProgress",
				"completed",
			]);
		});

		it("leaves status untouched for an unrecognised value", () => {
			const t = new SessionPlanTracker();
			t.addTask("1", "a");
			t.updateTask("1", "cancelled-ish");
			expect(t.snapshot()?.[0].status).toBe("pending");
		});

		it("ignores duplicate task ids", () => {
			const t = new SessionPlanTracker();
			t.addTask("1", "first");
			t.addTask("1", "second");
			expect(t.snapshot()).toHaveLength(1);
			expect(t.snapshot()?.[0].content).toBe("first");
		});

		// The platform replaces rather than merges, so a snapshot is always the
		// complete list — and callers must not be able to mutate our state.
		it("returns a defensive copy", () => {
			const t = new SessionPlanTracker();
			t.addTask("1", "a");
			const snap = t.snapshot();
			snap![0].status = "completed";
			expect(t.snapshot()?.[0].status).toBe("pending");
		});
	});
});

describe("SessionLinkTracker", () => {
	// Real Vercel preview host for branch cyrussh/chb-27-manage-order-...
	const OURS =
		"https://champions-box-git-cyrussh-chb-27-manage-or-4b745d-ponte-digital.vercel.app";
	const SOMEONE_ELSES =
		"https://champions-box-git-cyrussh-dvv-40-per-page-cta-9f21aa-ponte-digital.vercel.app";
	const PRODUCTION = "https://champions-box.vercel.app";

	it("finds a PR url and reports it once", () => {
		const t = new SessionLinkTracker("CHB-27");
		const text =
			"Done. PR: https://github.com/Ponte-Digital/DVV/pull/24 ready.";
		expect(t.scan(text)).toEqual([
			{
				url: "https://github.com/Ponte-Digital/DVV/pull/24",
				label: "Pull request",
			},
		]);
		expect(t.scan(text)).toEqual([]);
	});

	it("ignores a github url that is not a pull request", () => {
		const t = new SessionLinkTracker("CHB-27");
		expect(t.scan("see https://github.com/o/r/issues/3")).toEqual([]);
	});

	// A wrong preview link is worse than none: the client clicks it and sees
	// another deploy or a 404.
	describe("preview attribution", () => {
		it("emits a preview whose host carries this session's issue", () => {
			const t = new SessionLinkTracker("CHB-27");
			expect(t.scan(`Preview: ${OURS}`)).toEqual([
				{ url: OURS, label: "Preview" },
			]);
		});

		it("refuses another session's preview", () => {
			const t = new SessionLinkTracker("CHB-27");
			expect(t.scan(`Preview: ${SOMEONE_ELSES}`)).toEqual([]);
		});

		it("refuses the project's production alias", () => {
			const t = new SessionLinkTracker("CHB-27");
			expect(t.scan(`Live at ${PRODUCTION}`)).toEqual([]);
		});

		it("picks ours out of a message containing several previews", () => {
			const t = new SessionLinkTracker("CHB-27");
			const found = t.scan(`${PRODUCTION} and ${SOMEONE_ELSES} and ${OURS}`);
			expect(found).toEqual([{ url: OURS, label: "Preview" }]);
		});

		// Without an identifier there is no way to attribute, so nothing is safe
		// to emit.
		it("emits no preview at all when the session has no identifier", () => {
			for (const id of [undefined, null, "", "   "]) {
				const t = new SessionLinkTracker(id as never);
				expect(t.scan(`Preview: ${OURS}`)).toEqual([]);
			}
		});

		it("strips trailing prose punctuation", () => {
			const t = new SessionLinkTracker("CHB-27");
			expect(t.scan(`Preview is at ${OURS}.`)).toEqual([
				{ url: OURS, label: "Preview" },
			]);
		});

		it("reports each link once", () => {
			const t = new SessionLinkTracker("CHB-27");
			t.scan(`${OURS}`);
			expect(t.scan(`${OURS}`)).toEqual([]);
		});
	});

	it("reports both when they arrive together", () => {
		const t = new SessionLinkTracker("CHB-27");
		const found = t.scan(`PR https://github.com/o/r/pull/7 and ${OURS}`);
		expect(found.map((f) => f.label).sort()).toEqual([
			"Preview",
			"Pull request",
		]);
	});

	it("emits nothing when there is no url — no speculative buttons", () => {
		const t = new SessionLinkTracker("CHB-27");
		expect(t.scan("I have finished the work.")).toEqual([]);
		expect(t.scan(undefined)).toEqual([]);
		expect(t.scan(null)).toEqual([]);
		expect(t.scan("")).toEqual([]);
	});
});
