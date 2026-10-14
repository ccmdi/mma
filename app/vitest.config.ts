import { defineConfig } from "vitest/config";
import path from "node:path";
import { globSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const excludes = ["test/e2e/**", "test/integration/**", "procedures/**", "node_modules/**"];
const unitTests = globSync("test/unit/**/*.{test,spec}.{ts,tsx}", { cwd: import.meta.dirname }).map(
	(file) => file.replaceAll("\\", "/"),
);
const containing = (marker: string) =>
	unitTests.filter((file) =>
		readFileSync(path.join(import.meta.dirname, file), "utf8").includes(marker),
	);
const jsdomTests = containing("@vitest-environment jsdom");
const lintTests = containing('from "oxlint/plugins-dev"');

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "src"),
		},
	},
	test: {
		globals: true,
		fsModuleCache: true,
		// Past eight workers, worker and environment setup costs more than the parallelism saves.
		maxWorkers: Math.max(1, Math.min(8, availableParallelism() - 1)),
		// Reuse workers for jsdom; app-state tests retain isolated workers. Lint rules load
		// oxlint's native module, which crashes when several worker threads load it at once.
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					pool: "threads",
					exclude: [...excludes, ...jsdomTests, ...lintTests],
				},
			},
			{
				extends: true,
				test: { name: "vm", pool: "vmThreads", vmMemoryLimit: "512MiB", include: jsdomTests },
			},
			{
				extends: true,
				test: { name: "lint", pool: "forks", include: lintTests },
			},
		],
		setupFiles: ["test/unit/setup.ts"],
		// procedures/** hold wasm modules with their own node:test suites.
		exclude: excludes,
		// Pinned to a positive half-hour offset: local-vs-UTC frame bugs are invisible when
		// tests run in UTC, and a whole-hour zone hides sub-hour arithmetic.
		env: { TZ: "Asia/Kolkata" },
		// A lazy `import()` inside a test pays the module graph transform against the
		// test timeout, which a saturated pool blows through at the 5 s default.
		testTimeout: 30_000,
		// Node's own Web Storage holds nothing without a backing file and warns on every read.
		execArgv: ["--no-webstorage"],
	},
});
