/**
 * The web-serve HTTP bridge (`--web` only; excluded from the native suite).
 *
 * These surfaces have no desktop equivalent -- natively, Tauri serves custom schemes and
 * delivers events itself. Only the browser build goes through `/__scheme/` and `/__events`,
 * and nothing else asserts on them: the rest of the web suite exercises the relay
 * incidentally at best, so a regression there can pass ~46 of 47 tests.
 */

import {
	createAndOpenMap,
	closeMap,
	deleteMap,
	withApi,
	addLocs,
	createLocation,
	getLocCount,
	waitForReady,
} from "./helpers";

describe("Web bridge", () => {
	let mapId: string;

	before(async () => {
		mapId = await createAndOpenMap("web-bridge");
		await addLocs([
			createLocation({ lat: 40.1, lng: -74.2 }),
			createLocation({ lat: 41.3, lng: -75.4 }),
		]);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	// Guards the rest of the file: without this, a misconfigured run could pass every
	// assertion below against the native shell and prove nothing about the bridge.
	it("is actually running on the HTTP bridge", async () => {
		const web = await withApi(async () =>
			Boolean(
				// eslint-disable-next-line no-restricted-syntax -- the bridge itself is under test
				(window as { __TAURI_INTERNALS__?: { __webserve?: boolean } }).__TAURI_INTERNALS__
					?.__webserve,
			),
		);
		expect(web).toBe(true);
	});

	describe("scheme relay (/__scheme/)", () => {
		it("serves a real file", async () => {
			const res = await withApi(async (api) => {
				const path = await api.cmd.storeExportCsv({ type: "Everything" });
				const r = await fetch(api.mmaBufUrl(path));
				return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
			});
			expect(res.status).toBe(200);
			expect(res.body.length).toBeGreaterThan(0);
			expect(res.type).toBeTruthy();
		});

		it("relays a miss as 404 rather than a phantom success", async () => {
			const res = await withApi(async (api) => {
				const r = await fetch(api.mmaBufUrl("/nonexistent/web-bridge-probe.bin"));
				return { ok: r.ok, status: r.status };
			});
			expect(res.ok).toBe(false);
			expect(res.status).toBe(404);
		});
	});

	describe("event stream (/__events)", () => {
		it("delivers a backend-emitted event to a JS listener", async () => {
			await withApi(async (api) => {
				// listen() can't cross the withApi serialization boundary, and the emulated
				// event API is the thing under test, not a shortcut around withApi.
				// eslint-disable-next-line no-restricted-syntax -- the bridge itself is under test
				const internals = (
					window as unknown as {
						__TAURI_INTERNALS__: {
							invoke: (cmd: string, args: unknown) => Promise<unknown>;
							transformCallback: (cb: (p: unknown) => void) => number;
						};
					}
				).__TAURI_INTERNALS__;

				const received = window as unknown as { __e2eBridgeEvents: unknown[] };
				received.__e2eBridgeEvents = [];
				await internals.invoke("plugin:event|listen", {
					event: "bulk-export-progress",
					handler: internals.transformCallback((e) => received.__e2eBridgeEvents.push(e)),
				});

				await api.cmd.storeExportBulkZip();
			});

			// SSE frames arrive on their own connection, so the emit can land after the command resolves.
			await browser.waitUntil(
				() =>
					browser.execute(
						() =>
							(window as unknown as { __e2eBridgeEvents: unknown[] }).__e2eBridgeEvents.length > 0,
					),
				{ timeoutMsg: "the backend-emitted event never reached the listener" },
			);
		});
	});

	describe("clients", () => {
		it("keeps each tab's open map its own", async () => {
			const first = await browser.getWindowHandle();
			await browser.newWindow(new URL(await browser.getUrl()).origin);
			const second = await browser.getWindowHandle();
			await waitForReady();
			const other = await createAndOpenMap("web-bridge-other");
			await addLocs([0, 1, 2].map((i) => createLocation({ lat: 10 + i, lng: 20 + i })));
			expect(await getLocCount()).toBe(3);

			await browser.switchToWindow(first);
			expect(await getLocCount()).toBe(2);

			await browser.switchToWindow(second);
			await closeMap();
			await deleteMap(other);
			await browser.closeWindow();
			await browser.switchToWindow(first);
		});
	});
});
