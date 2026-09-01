import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assessOnboarding,
	discoverPreviewSetup,
	envRefsInSource,
	renderDiscoveryAsk,
} from "../src/preview-discovery.js";

/**
 * Discovery for an integration client (PON-215).
 *
 * The client installs the Linear app and the GitHub App. We have never seen
 * their infrastructure and cannot open a dashboard, so everything here must be
 * derivable from the repository alone — and the tests are written against a
 * repository shaped like a stranger's, not like ours.
 *
 * The fixture is deliberately awkward in the way real repos are: Neon (whose
 * branches copy production data by default), no host config file, and two
 * environment variables the repo never documents.
 */

// In the repository, deliberately. This used to point at a session's
// scratchpad under /tmp — a directory systemd-tmpfiles ages out after ten
// days and that no other checkout has. The suite was green on one box, for
// ten days, and would have failed hard everywhere else (PON-223, finding F).
const FIXTURE = fileURLToPath(
	new URL("./fixtures/stranger-repo/", import.meta.url),
);

/** A reader over a real directory — same shape the GitHub reader implements. */
function localReader(
	root: string,
	previews: { found: boolean; detail: string; url?: string },
) {
	const walk = (dir: string): string[] => {
		const out: string[] = [];
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) out.push(...walk(full));
			else out.push(relative(root, full));
		}
		return out;
	};
	return {
		async file(path: string) {
			try {
				return readFileSync(join(root, path), "utf8");
			} catch {
				return undefined;
			}
		},
		async paths() {
			return walk(root);
		},
		async previewEvidence() {
			return previews;
		},
	};
}

const WITH_PREVIEWS = {
	found: true,
	detail: "PR #12 has a preview deployment.",
	url: "https://orderly-abc123.vercel.app",
};

describe("discovery — from a stranger's repository", () => {
	it("does not ask for variables the platform supplies or the code defaults", async () => {
		// A generated list that asks for AWS_REGION reads as machine output and
		// gets answered carelessly. The code's own fallback is the signal that
		// the app runs without it.
		const d = await discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));
		const names = d.envVars.map((v) => v.name);
		expect(names).not.toContain("AWS_REGION");

		const message = renderDiscoveryAsk(d, "orderly");
		expect(message).not.toContain("AWS_REGION");
	});

	it("finds the variables the repo never documents", async () => {
		// The failure this prevents: asking a client to "send your environment
		// variables" and getting the two they remember. The gap between what a
		// repo declares and what its code reads is the expensive part.
		const d = await discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));

		const undeclared = d.envVars.filter((v) => v.undeclared).map((v) => v.name);
		expect(undeclared).toContain("POSTMARK_TOKEN");
		expect(undeclared).toContain("NOTIFY_FROM_EMAIL");

		const declared = d.envVars.filter((v) => !v.undeclared).map((v) => v.name);
		expect(declared).toContain("DATABASE_URL");
		expect(declared).toContain("NEXT_PUBLIC_SITE_URL");
	});

	it("identifies the database provider, and what its branches contain", async () => {
		// This is the distinction the whole data position rests on: the same
		// sentence — "we use branching for previews" — is compliant on Supabase
		// and a breach on Neon.
		const d = await discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));
		expect(d.database).toBe("neon");
		expect(d.branchDefault).toBe("copies-parent-data");
	});

	it("does not mistake Neon for plain postgres", async () => {
		// A Neon app also depends on postgres-shaped things. Matching the
		// generic driver first would erase the distinction that matters.
		const d = await discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));
		expect(d.database).not.toBe("postgres");
	});

	it("infers the host from the preview URL when there is no config file", async () => {
		// The fixture has no vercel.json — most repos do not.
		const d = await discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));
		expect(d.host).toBe("vercel");
		expect(d.previewsPerPR).toBe("yes");
	});

	it("asks the Neon question in terms the client can actually answer", async () => {
		const d = await discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));
		const ask = d.mustAsk.join(" ");
		expect(ask).toContain("Neon");
		expect(ask).toContain("created from production");
	});

	it("says the previews are missing rather than asking about databases", async () => {
		// A client with no previews has a different first conversation; asking
		// them about branch data would be noise.
		const d = await discoverPreviewSetup(
			localReader(FIXTURE, {
				found: false,
				detail:
					"Checked the 5 most recently updated pull requests; none had a preview deployment.",
			}),
		);
		expect(d.previewsPerPR).toBe("no");
		expect(d.mustAsk.join(" ")).toContain("do not build a preview");
		expect(d.mustAsk.join(" ")).not.toContain("Neon");
	});
});

describe("discovery — the generated ask", () => {
	it("states what we worked out and asks only what we could not", async () => {
		const d = await discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));
		const message = renderDiscoveryAsk(d, "orderly");

		// It shows its work, so the client can see we looked.
		expect(message).toContain("orderly");
		expect(message).toContain("vercel");
		// It names the undocumented variables specifically.
		expect(message).toContain("POSTMARK_TOKEN");
		// And it asks the one thing the repo cannot answer.
		expect(message).toContain("Neon");
		// It is not a questionnaire: no request for the whole env file.
		expect(message.toLowerCase()).not.toContain("send us your environment");
	});
});

describe("discovery — env reference extraction", () => {
	it("reads both access shapes and drops the host's own variables", () => {
		const found = envRefsInSource(`
			const a = process.env.MY_TOKEN;
			const b = process.env["OTHER_KEY"];
			if (process.env.NODE_ENV === "production") {}
			const c = process.env.VERCEL_URL;
			const d = process.env.OPTIONAL_ONE ?? "default";
		`).map((r) => r.name);
		expect(found).toContain("MY_TOKEN");
		expect(found).toContain("OTHER_KEY");
		// NODE_ENV and VERCEL_URL are not the client's to supply — asking for
		// them makes the list look automated and untrustworthy.
		expect(found).not.toContain("NODE_ENV");
		expect(found).not.toContain("VERCEL_URL");
	});
});

/**
 * The onboarding gate (PON-215).
 *
 * The bypass token is a PREREQUISITE, not an extra: a protected preview is
 * invisible to the reviewer too, so without it the product does not work for
 * that client. The gate exists so that is said before a lane is sold, not at
 * the first delivery.
 */
describe("onboarding readiness", () => {
	const base = async () =>
		discoverPreviewSetup(localReader(FIXTURE, WITH_PREVIEWS));

	it("blocks when the preview is protected and we have no bypass value", async () => {
		const gate = assessOnboarding({
			discovery: await base(),
			bypass: "missing",
			dataSeparation: "confirmed",
		});
		expect(gate.readiness).toBe("blocked-needs-client-action");
		// It has to say why in terms of the product, not the mechanism.
		expect(gate.blockers.join(" ")).toContain("we cannot review the work");
		expect(gate.blockers.join(" ")).toContain(
			"Protection Bypass for Automation",
		);
	});

	it("does not ask for a bypass value when the preview already opens", async () => {
		// Asking for a credential nobody needs is how an onboarding message
		// stops being believed.
		const gate = assessOnboarding({
			discovery: await base(),
			bypass: "not-needed",
			dataSeparation: "confirmed",
		});
		expect(gate.readiness).toBe("ready");
		expect(gate.blockers).toHaveLength(0);
	});

	it("treats an unconfirmed database as unmet, not as fine", async () => {
		const gate = assessOnboarding({
			discovery: await base(),
			bypass: "not-needed",
			dataSeparation: "unconfirmed",
		});
		expect(gate.readiness).toBe("blocked-needs-client-action");
	});

	it("refuses outright when the preview reads production", async () => {
		const gate = assessOnboarding({
			discovery: await base(),
			bypass: "not-needed",
			dataSeparation: "reads-production",
		});
		expect(gate.blockers.join(" ")).toContain("real customer data");
	});

	it("routes a client with no previews to the setup engagement", async () => {
		// Not a blocker to argue about — it is the first paid piece of work.
		const discovery = await discoverPreviewSetup(
			localReader(FIXTURE, { found: false, detail: "none" }),
		);
		const gate = assessOnboarding({
			discovery,
			bypass: "not-needed",
			dataSeparation: "unconfirmed",
		});
		expect(gate.readiness).toBe("needs-setup-engagement");
		// And it does not pile on the other asks, which would be noise.
		expect(gate.blockers).toHaveLength(1);
	});

	it("catches a bypass value that does not actually open the preview", async () => {
		// The failure this prevents: a typo'd or stale value looks done at
		// onboarding and fails at the first delivery, in front of the client,
		// on the one link the product is built around.
		const gate = assessOnboarding({
			discovery: await base(),
			bypass: "supplied-but-fails",
			dataSeparation: "confirmed",
		});
		expect(gate.readiness).toBe("blocked-needs-client-action");
		// And it must not read as if they ignored us — they did the thing.
		expect(gate.blockers.join(" ")).toContain("Thanks for the access value");
	});

	it("distinguishes an unreachable preview from a bad value", async () => {
		const gate = assessOnboarding({
			discovery: await base(),
			bypass: "could-not-check",
			dataSeparation: "confirmed",
		});
		expect(gate.blockers.join(" ")).toContain("could not reach");
	});

	it("blocks when there is no account to sign in with", async () => {
		// "Exercisable" is the promise. Watching a change render is not
		// checking that it works.
		const gate = assessOnboarding({
			discovery: await base(),
			bypass: "not-needed",
			dataSeparation: "confirmed",
			testAccounts: 0,
		});
		expect(gate.readiness).toBe("blocked-needs-client-action");
		expect(gate.blockers.join(" ")).toContain("cannot use it");
	});

	it("says plainly that work cannot start, in the client's message", async () => {
		const discovery = await base();
		const gate = assessOnboarding({
			discovery,
			bypass: "missing",
			dataSeparation: "unconfirmed",
		});
		const message = renderDiscoveryAsk(discovery, "orderly", gate);
		expect(message).toContain("Before we can start");
		expect(message).toContain("we cannot deliver it");
	});
});
