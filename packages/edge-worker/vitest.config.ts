import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		setupFiles: ["./test/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules",
				"test",
				"dist",
				"**/*.d.ts",
				"**/*.config.*",
				"**/mockData.ts",
			],
		},
		testTimeout: 30000,
		hookTimeout: 30000,
	},
	resolve: {
		// ARRAY form with anchored regexes, deliberately.
		//
		// Every workspace dependency resolves to SOURCE here. Four of the
		// thirteen were missing, so they went through `main: dist/index.js` and
		// the tests ran the last BUILD of those packages. Proven rather than
		// inferred: a module-load-time `throw` planted in
		// packages/core/src/PersistenceManager.ts, without rebuilding, left all
		// 1518 tests passing — every one would have failed at import had core
		// been loaded from source.
		//
		// The real cost is not a stale test run, it is a stale MUTATION CHECK:
		// the standing bar's evidence step silently proves things about whatever
		// was compiled last, so "the mutation failed" becomes a coincidence of
		// whether someone happened to build first.
		//
		// Anchored (`/^name$/`) because a plain string alias is a PREFIX match:
		// it rewrote `cyrus-github-event-transport/test/fixtures` into
		// `<...>/src/index.ts/test/fixtures`. Subpath imports must fall through
		// to normal resolution.
		alias: [
			{ find: "@test", replacement: path.resolve(__dirname, "./test") },
			{ find: "@", replacement: path.resolve(__dirname, "./src") },
			{
				find: /^cyrus-claude-runner$/,
				replacement: path.resolve(__dirname, "../claude-runner/src/index.ts"),
			},
			{
				find: /^cyrus-codex-runner$/,
				replacement: path.resolve(__dirname, "../codex-runner/src/index.ts"),
			},
			{
				find: /^cyrus-cursor-runner$/,
				replacement: path.resolve(__dirname, "../cursor-runner/src/index.ts"),
			},
			{
				find: /^cyrus-gemini-runner$/,
				replacement: path.resolve(__dirname, "../gemini-runner/src/index.ts"),
			},
			{
				find: /^cyrus-simple-agent-runner$/,
				replacement: path.resolve(
					__dirname,
					"../simple-agent-runner/src/index.ts",
				),
			},
			{
				find: /^cyrus-config-updater$/,
				replacement: path.resolve(__dirname, "../config-updater/src/index.ts"),
			},
			{
				find: /^cyrus-linear-event-transport$/,
				replacement: path.resolve(
					__dirname,
					"../linear-event-transport/src/index.ts",
				),
			},
			{
				find: /^cyrus-mcp-tools$/,
				replacement: path.resolve(__dirname, "../mcp-tools/src/index.ts"),
			},
			{
				find: /^cyrus-cloudflare-tunnel-client$/,
				replacement: path.resolve(
					__dirname,
					"../cloudflare-tunnel-client/src/index.ts",
				),
			},
			{
				find: /^cyrus-core$/,
				replacement: path.resolve(__dirname, "../core/src/index.ts"),
			},
			{
				find: /^cyrus-github-event-transport$/,
				replacement: path.resolve(
					__dirname,
					"../github-event-transport/src/index.ts",
				),
			},
			{
				find: /^cyrus-gitlab-event-transport$/,
				replacement: path.resolve(
					__dirname,
					"../gitlab-event-transport/src/index.ts",
				),
			},
			{
				find: /^cyrus-slack-event-transport$/,
				replacement: path.resolve(
					__dirname,
					"../slack-event-transport/src/index.ts",
				),
			},
		],
	},
});
