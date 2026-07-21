import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

// Credentials come from the environment, or from a gitignored `.env` in either the repo root or
// `app/`. The "" prefix loads every key, not just VITE_-prefixed ones.
const repoRoot = path.resolve(__dirname, "..");
const secrets = { ...loadEnv("", repoRoot, ""), ...loadEnv("", __dirname, "") };

// Real-network integration suite. Excluded from the default config; run explicitly via
// `npm run test:integration`. Serial (one shared sacrificial map per provider), generous
// timeout for network round-trips.
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
		env: secrets,
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 30000,
		hookTimeout: 30000,
		fileParallelism: false,
	},
});
