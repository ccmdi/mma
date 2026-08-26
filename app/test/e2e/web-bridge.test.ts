/**
 * The web-serve HTTP bridge (`--web` only; excluded from the native suite).
 *
 * These surfaces have no desktop equivalent -- natively, Tauri serves custom schemes and
 * delivers events itself. Only the browser build goes through `/__scheme/` and `/__events`,
 * and nothing else asserts on them: the rest of the web suite exercises the relay
 * incidentally at best, so a regression there can pass ~46 of 47 tests.
 */

import { createAndOpenMap, closeMap, deleteMap, withApi, addLocs, createLocation } from "./helpers";

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
			const received = await withApi(async (api) => {
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

				const events: unknown[] = [];
				await internals.invoke("plugin:event|listen", {
					event: "bulk-export-progress",
					handler: internals.transformCallback((e) => events.push(e)),
				});

				await api.cmd.storeExportBulkZip();

				// SSE frames arrive on their own connection, so the emit can land after the
				// command resolves. Poll instead of sleeping a fixed amount.
				for (let i = 0; i < 100 && events.length === 0; i++) {
					await new Promise((r) => setTimeout(r, 50));
				}
				return events.length;
			});
			expect(received).toBeGreaterThan(0);
		});
	});
});
