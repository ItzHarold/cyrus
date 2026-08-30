import { describe, expect, it } from "vitest";
import { formatMirrorAge } from "../src/CockpitMirror.js";

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
