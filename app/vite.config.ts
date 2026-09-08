import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import path from "node:path";

// Lazy-only packages: an eager edge to any of these is a startup regression.
const MUST_STAY_LAZY = [
	/\/@deck\.gl\//,
	/\/@luma\.gl\//,
	/\/maplibre-gl\//,
	/\/react-dom\/(?:server|cjs\/react-dom-server)/,
	/\.mdx$/,
];

/** Fails the production build when the eager bundle grows a forbidden edge, asserting on the
 *  emitted bundle -- what actually ships -- rather than on source imports. */
function eagerBundleGuard(): Plugin {
	return {
		name: "mma:eager-bundle-guard",
		apply: "build",
		generateBundle(_options, bundle) {
			const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry);
			if (entry?.type !== "chunk") return;

			const closure = new Set<string>();
			const queue = [entry.fileName];
			while (queue.length) {
				const name = queue.pop()!;
				if (closure.has(name)) continue;
				closure.add(name);
				const chunk = bundle[name];
				if (chunk?.type === "chunk") queue.push(...chunk.imports);
			}

			let bytes = 0;
			const offenders: string[] = [];
			for (const name of closure) {
				const chunk = bundle[name];
				if (chunk?.type !== "chunk") continue;
				bytes += chunk.code.length;
				for (const id of Object.keys(chunk.modules)) {
					const hit = MUST_STAY_LAZY.find((re) => re.test(id));
					if (hit) offenders.push(`${name}: ${id}`);
				}
			}

			if (offenders.length > 0) {
				this.error(
					[
						"eager bundle pulled in code that must stay lazy:",
						...offenders.map((o) => `  ${o}`),
						"Find the import edge (usually a value import of a constant) and move it.",
					].join("\n"),
				);
			}
			this.info(`eager JS: ${bytes.toLocaleString()} bytes across ${closure.size} chunks`);
		},
	};
}

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "src"),
		},
	},
	define: {
		__APP_VERSION__: JSON.stringify(process.env.npm_package_version),
	},
	clearScreen: false,
	plugins: [
		{ ...mdx(), enforce: "pre" },
		react({ include: /\.(jsx|js|mdx|tsx|ts)$/ }),
		eagerBundleGuard(),
	],
	server: {
		strictPort: true,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
	optimizeDeps: {
		include: [
			"@deck.gl/core",
			"@deck.gl/layers",
			"@deck.gl/google-maps",
			"@luma.gl/core",
			"@luma.gl/shadertools",
			"@luma.gl/engine",
			"@luma.gl/webgl",
		],
	},
});
