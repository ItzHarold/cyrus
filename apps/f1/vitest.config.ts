import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
	},
	resolve: {
		// Workspace dependencies resolve to SOURCE, not to `main: dist/*`.
		// Without this the tests exercise whatever was last BUILT, which makes
		// every mutation check here prove something about the last compile
		// rather than the code under review. Anchored regexes so subpath
		// imports still resolve normally.
		alias: [
			{
				find: /^cyrus-core$/,
				replacement: path.resolve(
					__dirname,
					"../../packages/core/src/index.ts",
				),
			},
			{
				find: /^cyrus-claude-runner$/,
				replacement: path.resolve(
					__dirname,
					"../../packages/claude-runner/src/index.ts",
				),
			},
			{
				find: /^cyrus-edge-worker$/,
				replacement: path.resolve(
					__dirname,
					"../../packages/edge-worker/src/index.ts",
				),
			},
			{
				find: /^cyrus-slack-event-transport$/,
				replacement: path.resolve(
					__dirname,
					"../../packages/slack-event-transport/src/index.ts",
				),
			},
		],
	},
});
