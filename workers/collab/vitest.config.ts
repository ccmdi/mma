import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: { "cloudflare:workers": fileURLToPath(new URL("test/workers.ts", import.meta.url)) },
	},
});
