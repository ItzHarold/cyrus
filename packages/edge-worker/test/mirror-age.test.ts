import { describe, expect, it } from "vitest";
import { bareCockpitState, formatMirrorAge } from "../src/CockpitMirror.js";

/**
 * The mirror's own clock (PON-221).
 *
 * Harold read "10 hours ago" on a mirror that was minutes old — the age
 * belonged to the client's issue, which had been open all night while its
 * scope was being agreed. These cases pin the reading, including the two
 * that must never render: a garbled stamp and a clock that went backwards.
 */
const T = Date.parse("2026-08-30T12:00:00.000Z");
const at = (iso: string) => formatMirrorAge(iso, T);

describe("formatMirrorAge", () => {
	it("says 'just now' below a minute", () => {
		expect(at("2026-08-30T11:59:30.000Z")).toBe("just now");
		expect(at("2026-08-30T12:00:00.000Z")).toBe("just now");
	});

	it("counts whole minutes under an hour", () => {
		expect(at("2026-08-30T11:59:00.000Z")).toBe("1m");
		expect(at("2026-08-30T11:01:00.000Z")).toBe("59m");
	});

	it("counts hours, with minutes only when there are some", () => {
		expect(at("2026-08-30T11:00:00.000Z")).toBe("1h");
		expect(at("2026-08-30T09:55:00.000Z")).toBe("2h 5m");
	});

	it("counts days past twenty-four hours", () => {
		expect(at("2026-08-29T12:00:00.000Z")).toBe("1d");
		expect(at("2026-08-27T08:00:00.000Z")).toBe("3d 4h");
	});

	it("renders nothing for a stamp it cannot read", () => {
		// The caller drops the age entirely rather than printing "NaN" at a
		// reviewer deciding whether work has been waiting too long.
		expect(at("not a date")).toBe("");
		expect(at("")).toBe("");
	});

	it("does not render a negative age", () => {
		// Clock skew between the box and Linear must read as new, never as
		// work that has been waiting minus five minutes.
		expect(at("2026-08-30T12:05:00.000Z")).toBe("just now");
	});
});

/**
 * The age must survive everything that rewrites a mirror without the work
 * having moved (PON-221, adversarial review).
 */
describe("bareCockpitState", () => {
	it("strips a queue position so a re-rank is not a transition", () => {
		expect(bareCockpitState("queued (#3)")).toBe("queued");
		expect(bareCockpitState("queued (#12)")).toBe("queued");
		// setOperatorNote re-upserts on the already-bare state; both sides of
		// the comparison have to land on the same string.
		expect(bareCockpitState("queued")).toBe("queued");
	});

	it("leaves a real transition distinguishable", () => {
		expect(bareCockpitState("queued (#1)")).not.toBe(
			bareCockpitState("active"),
		);
		expect(bareCockpitState("in-verification")).toBe("in-verification");
	});

	it("tolerates an absent state", () => {
		expect(bareCockpitState(undefined)).toBe("");
	});
});
