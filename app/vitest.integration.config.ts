import { defineConfig } from "vitest/config";
import path from "node:path";

// Real-network integration suite. Excluded from the default config; run explicitly via
// `npm run test:integration` with MMA_API_KEY + MMA_SYNC_TEST_MAP set. Serial (one shared
// sacrificial map), generous timeout for network round-trips.
export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
			"measuretool-googlemaps-v3": path.resolve(
				__dirname,
				"node_modules/measuretool-googlemaps-v3/dist/gmaps-measuretool.esm.js",
			),
		},
	},
	test: {
		globals: true,
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 30000,
		hookTimeout: 30000,
		fileParallelism: false,
	},
});
