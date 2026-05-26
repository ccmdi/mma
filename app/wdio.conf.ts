import path from "path";
import fs from "fs";

process.env.MMA_TEST_DB = "1";

const isWorker = !!process.env.WDIO_WORKER_ID;
let logStream: fs.WriteStream | undefined;

if (!isWorker) {
	const logDir = path.resolve("./test/logs");
	fs.mkdirSync(logDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const logPath = path.join(logDir, `e2e-${timestamp}.txt`);
	logStream = fs.createWriteStream(logPath, { encoding: "utf-8" });
	process.env.MMA_E2E_LOG_PATH = logPath;

	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		logStream!.write(text.replace(/\x1b\[[0-9;]*m/g, ""));
		return origWrite(chunk, ...(args as []));
	};
}

export const config: WebdriverIO.Config = {
	runner: "local",
	specs: ["./test/e2e/**/*.test.ts"],
	maxInstances: 1,
	capabilities: [
		{
			"tauri:options": {
				application: path.resolve("./src-tauri/target/debug/map-making-app.exe"),
				args: ["--test-db"],
			},
		},
	],
	hostname: "localhost",
	port: 4444,
	path: "/",
	logLevel: "warn",
	waitforTimeout: 10000,
	connectionRetryTimeout: 20000,
	connectionRetryCount: 2,
	framework: "mocha",
	reporters: ["spec"],
	mochaOpts: {
		ui: "bdd",
		timeout: 120000,
	},
	onComplete: () => {
		if (logStream) {
			const p = process.env.MMA_E2E_LOG_PATH;
			logStream.end();
			console.log(`\nLog: ${p}`);
		}
	},
};
