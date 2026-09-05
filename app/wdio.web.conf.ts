// Web-serve variant of wdio.conf.ts: the same specs against the same frontend bundle,
// driven in Chrome over the HTTP IPC bridge instead of in the native shell. Only the
// driver and the app URL differ -- specs go through window.MMA either way.
//
// Expects `map-making-app --serve` already listening (see scripts/docker-web-e2e.sh).

import { config as base, SHARED_EXCLUDES } from "./wdio.conf";

// Drop the tauri-driver connection settings: wdio manages the chromedriver session.
const { hostname: _h, port: _p, path: _path, capabilities: _caps, ...shared } = base;

export const config: WebdriverIO.Config = {
	...shared,
	baseUrl: process.env.MMA_WEB_URL ?? "http://127.0.0.1:1430",
	exclude: [
		...SHARED_EXCLUDES,
		// Native-only paths, not bridge-emulated: the export save dialog goes through
		// showSaveFilePicker/download in a browser, and fullscreen leans on real windowing.
		"./test/e2e/export-dialog.test.ts",
		"./test/e2e/fullscreen-map.test.ts",
		// The sign-in flow builds a native webview window, which the sidecar has no
		// equivalent for.
		"./test/e2e/geoguessr.test.ts",
	],
	capabilities: [
		{
			browserName: "chrome",
			"goog:chromeOptions": {
				args: [
					"--headless=new",
					"--no-sandbox",
					"--disable-dev-shm-usage",
					// deck.gl needs a working WebGL context; there's no GPU in CI.
					"--enable-unsafe-swiftshader",
					"--use-gl=angle",
					"--use-angle=swiftshader",
					"--window-size=1920,1080",
				],
			},
			// Docker pins a prebuilt driver (no network at test time); locally wdio fetches
			// one matching the installed Chrome.
			...(process.env.CHROMEDRIVER_PATH
				? { "wdio:chromedriverOptions": { binary: process.env.CHROMEDRIVER_PATH } }
				: {}),
		},
	],
	before: async () => {
		await browser.url("/");
		await browser.waitUntil(async () => browser.execute(() => window.MMA?.ready === true), {
			timeout: 30000,
			timeoutMsg: "web app did not boot in time",
		});
	},
};
