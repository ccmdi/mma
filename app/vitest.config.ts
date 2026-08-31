import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	test: {
		globals: true,
		setupFiles: ["test/unit/setup.ts"],
		// procedures/** hold wasm modules with their own node:test suites.
		exclude: ["test/e2e/**", "test/integration/**", "procedures/**", "node_modules/**"],
		// Pinned to a positive half-hour offset: local-vs-UTC frame bugs are invisible when
		// tests run in UTC, and a whole-hour zone hides sub-hour arithmetic.
		env: { TZ: "Asia/Kolkata" },
	},
});
