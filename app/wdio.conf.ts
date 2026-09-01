import path from "path";
import fs from "fs";
import { installSvMock } from "./test/e2e/svMock";
import { svMockCore } from "./test/e2e/svMockCore";
import { startSvStub, svMockConfig, type SvStub } from "./test/e2e/svStubServer";

process.env.MMA_TEST_DB = "1";
process.env.TSX_TSCONFIG_PATH = path.resolve("tsconfig.app.json");

// wdio.conf is imported once per process -- the launcher plus one worker per spec --
// so only the launcher may open the log.
const isWorker = !!process.env.WDIO_WORKER_ID;
let logStream: fs.WriteStream | undefined;
let logPath: string | undefined;
let svStub: SvStub | undefined;

// Two ways in, one record either way. Under scripts/e2e.sh the shell tees the container's
// whole output -- wdio plus tauri-driver and the sv-stub -- to a file it names, and hands
// the path in as MMA_E2E_LOG_PATH, so this stands down. A bare `npm run test:e2e` has no
// shell above it, so wdio records itself.
if (!isWorker && !process.env.MMA_E2E_LOG_PATH) {
	const logDir = path.resolve("./test/logs");
	fs.mkdirSync(logDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	logPath = path.join(logDir, `e2e-native-${timestamp}.txt`);
	logStream = fs.createWriteStream(logPath, { encoding: "utf-8" });

	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		logStream!.write(text.replace(/\x1b\[[0-9;]*m/g, ""));
		return origWrite(chunk, ...(args as []));
	};
}

/** Excluded from both suites: scratch and the benchmark suite, run explicitly
 *  (`scripts/e2e.sh --bench`, or `--spec`). */
export const SHARED_EXCLUDES = [
	"./test/e2e/scratch.test.ts",
	"./test/e2e/performance.test.ts",
	// Wipes every map in the list during cleanup, so it can't share a run with other specs.
	"./test/e2e/bulk-import-rust.test.ts",
	// Engine A/B suites: driven explicitly against two images, never part of a suite run.
	"./test/e2e/procedure-bench.test.ts",
	"./test/e2e/procedure-parity.test.ts",
	"./test/e2e/procedure-faults.test.ts",
	"./test/e2e/procedure-scale.test.ts",
	"./test/e2e/parity-probe.test.ts",
];

export const config: WebdriverIO.Config = {
	runner: "local",
	specs: ["./test/e2e/**/*.test.ts"],
	// web-bridge asserts on the HTTP bridge, which only exists under --web.
	exclude: [...SHARED_EXCLUDES, "./test/e2e/web-bridge.test.ts"],
	maxInstances: 1,
	capabilities: [
		{
			"tauri:options": {
				application:
					process.env.MMA_E2E_BINARY ??
					(process.platform === "win32"
						? path.resolve("./src-tauri/target/debug/map-making-app.exe")
						: fs.existsSync("/usr/local/bin/map-making-app")
							? "/usr/local/bin/map-making-app"
							: path.resolve("./src-tauri/target/debug/map-making-app")),
				args: ["--test-db"],
			},
		},
	],
	hostname: "localhost",
	port: 4444,
	path: "/",
	logLevel: "warn",
	waitforTimeout: 10000,
	// A single in-page block can legitimately run for minutes (the benchmark suite imports
	// hundreds of thousands of rows inside one `execute/async`). Mocha's per-test timeout is
	// the real bound on a wedged app; this only has to be larger than the slowest command.
	connectionRetryTimeout: 900000,
	connectionRetryCount: 2,
	framework: "mocha",
	reporters: ["spec"],
	mochaOpts: {
		ui: "bdd",
		// Runtime `this.timeout()` is not honored under wdio's mocha runner, so the
		// benchmark suite (MMA_BENCH_REVISION set by e2e.sh --bench) gets its whole
		// per-scale budget here; everything else keeps the 5-minute hang bound.
		timeout: process.env.MMA_BENCH_REVISION ? 7_200_000 : 300000,
	},
	// Monkey-patch Street View (window.fetch + google.maps) from the test side when
	// --mock is on, so the network-bound specs run deterministically with no network.
	// Per-suite + idempotent so it survives any per-spec session reset.
	beforeSuite: async () => {
		if (process.env.MMA_TEST_MOCK_SV) {
			try {
				await browser.execute(installSvMock, svMockCore.toString(), JSON.stringify(svMockConfig()));
			} catch (e) {
				console.log("[sv-mock] install failed:", (e as Error).message);
			}
		}
	},
	// The Rust procedure engine fetches outside the webview, so it gets an HTTP stub instead
	// of the monkey-patch. The app was launched with MMA_E2E_SV_ORIGIN pointing here
	// (scripts/internal/e2e-*.sh); this only has to be listening before the first session.
	onPrepare: async () => {
		if (!process.env.MMA_TEST_MOCK_SV) return;
		svStub = await startSvStub();
	},
	onComplete: async () => {
		await svStub?.close();
		if (logStream) {
			logStream.end();
			console.log(`\nLog: ${logPath}`);
		}
	},
};
