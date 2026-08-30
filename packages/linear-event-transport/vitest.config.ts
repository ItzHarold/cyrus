import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules/",
				"dist/",
				"test/",
				"**/*.d.ts",
				"**/*.config.*",
				"**/mockData.ts",
			],
		},
	},
	resolve: {
		// Workspace dependencies resolve to SOURCE, not to `main: dist/*`.
		// Without this the tests exercise whatever was last BUILT, which makes
		// every mutation check in this package prove something about the last
		// compile rather than the code under review. Anchored regexes so
		// subpath imports (`pkg/test/fixtures`) still resolve normally.
		alias: [
			{
				find: /^cyrus-core$/,
				replacement: path.resolve(__dirname, "../core/src/index.ts"),
			},
		],
	},
});
