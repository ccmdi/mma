/**
 * Content Security Policy regression gate.
 *
 * `tauri.conf.json` ships a real CSP. Any app change that reaches for a scheme, host or
 * eval the policy does not allow fails silently in production (a blocked fetch looks like
 * an offline error, a blocked script like a dead feature). This spec drives the broad
 * surface of the app with a `securitypolicyviolation` listener attached and asserts the
 * browser reported nothing.
 *
 * Run against REAL Street View - under --mock nothing ever contacts Google, so a mocked
 * pass would green-light a policy that blocks every Google host:
 *   bash scripts/e2e-scratch.sh --real test/e2e/csp.test.ts
 *
 * Coverage note: a `securitypolicyviolation` listener only fires in the document that
 * carries it. Everything here runs in the "list" webview (the suite drives editor state by
 * hash navigation, never by spawning an editor window), and the `/valig/index.html` iframe
 * reports into its own document. Violations raised inside that iframe, inside a separately
 * spawned editor window, or before this spec's `before` hook runs are not observed here.
 * Boot-time script/style blocks are covered indirectly: the app would not reach
 * `MMA.ready` at all.
 */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	withApi,
	openLocation,
	closeLocation,
	addLocs,
	createLocation,
	getLocCount,
	getAllLocs,
} from "./helpers";
import { LocationFlag } from "@/bindings.consts";

interface Violation {
	blockedURI: string;
	violatedDirective: string;
	effectiveDirective: string;
	sourceFile: string;
	lineNumber: number;
	sample: string;
}

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };

async function installViolationListener() {
	await browser.execute(() => {
		const w = window as unknown as { __cspViolations?: unknown[]; __cspInstalled?: boolean };
		if (w.__cspInstalled) return;
		w.__cspInstalled = true;
		w.__cspViolations = [];
		document.addEventListener("securitypolicyviolation", (e) => {
			w.__cspViolations!.push({
				blockedURI: e.blockedURI,
				violatedDirective: e.violatedDirective,
				effectiveDirective: e.effectiveDirective,
				sourceFile: e.sourceFile,
				lineNumber: e.lineNumber,
				sample: e.sample,
			});
		});
	});
}

async function readViolations(): Promise<Violation[]> {
	return browser.execute(() => {
		const w = window as unknown as { __cspViolations?: Violation[] };
		return (w.__cspViolations ?? []) as Violation[];
	}) as Promise<Violation[]>;
}

/** One line per violation, deduplicated on the fields that identify the rule that fired. */
function format(violations: Violation[]): string {
	const seen = new Map<string, { v: Violation; n: number }>();
	for (const v of violations) {
		const key = `${v.effectiveDirective}|${v.blockedURI}|${v.sourceFile}|${v.sample}`;
		const hit = seen.get(key);
		if (hit) hit.n++;
		else seen.set(key, { v, n: 1 });
	}
	return [...seen.values()]
		.map(
			({ v, n }) =>
				`  [${v.effectiveDirective}] blocked=${v.blockedURI || "(inline)"}` +
				` violated="${v.violatedDirective}"` +
				` at ${v.sourceFile || "(unknown)"}:${v.lineNumber}` +
				(v.sample ? ` sample="${v.sample.slice(0, 80)}"` : "") +
				(n > 1 ? ` (x${n})` : ""),
		)
		.join("\n");
}

/** Move the camera through the map host and resolve once the move settles. */
async function moveMap(center: { lat: number; lng: number }, zoom: number): Promise<boolean> {
	return browser.executeAsync(
		(lat: number, lng: number, z: number, done: (r: boolean) => void) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- in-page global
			const host = (window as any).MMA.getMapHost();
			if (!host) return done(false);
			const timer = setTimeout(() => done(false), 20000);
			host.once("idle", () => {
				clearTimeout(timer);
				done(true);
			});
			host.moveCamera({ center: { lat, lng }, zoom: z });
		},
		center.lat,
		center.lng,
		zoom,
	);
}

async function openPanel(trigger: string, panel: string) {
	if (await browser.$(panel).isExisting()) return;
	await browser.$(trigger).click();
	await browser.$(panel).waitForExist({ timeout: 5000, timeoutMsg: `${panel} never opened` });
}

/** Click a bottom-bar gear by title. A real pointer click misses it under software
 *  rendering (the bar animates in), so dispatch through the element itself. */
async function clickByTitle(title: string) {
	const el = await browser.$(`.settings-gear[title='${title}']`);
	await el.waitForExist({ timeout: 10000, timeoutMsg: `gear "${title}" never rendered` });
	await browser.execute((t: string) => {
		document.querySelector<HTMLElement>(`.settings-gear[title='${t}']`)?.click();
	}, title);
}

async function escapeUntilGone(panel: string) {
	await browser.keys("Escape");
	await browser.waitUntil(async () => !(await browser.$(panel).isExisting()), {
		timeout: 5000,
		timeoutMsg: `${panel} never closed`,
	});
}

describe("Content Security Policy", function () {
	let mapId: string;

	before(async () => {
		await waitForReady();
		await installViolationListener();
		mapId = await createAndOpenMap("E2E CSP");
	});

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	it("boots with the app bundle, styles and fonts loaded", async () => {
		const boot = await browser.execute(() => ({
			ready: (window as unknown as { MMA?: { ready?: boolean } }).MMA?.ready === true,
			sheets: document.styleSheets.length,
			// A blocked stylesheet leaves the body unstyled; the app paints a dark ground.
			bg: getComputedStyle(document.body).backgroundColor,
		}));
		expect(boot.ready).toBe(true);
		expect(boot.sheets).toBeGreaterThan(0);
		expect(boot.bg).not.toBe("rgba(0, 0, 0, 0)");
	});

	it("loads opensv from its blob URL and exposes google.maps", async () => {
		await browser.waitUntil(
			async () =>
				browser.execute(
					() =>
						typeof (window as unknown as { google?: { maps?: unknown } }).google?.maps === "object",
				),
			{ timeout: 30000, timeoutMsg: "google.maps never appeared (opensv blob script blocked?)" },
		);
	});

	it("renders map tiles across zoom levels", async () => {
		expect(await moveMap({ lat: 48.8566, lng: 2.3522 }, 5)).toBe(true);
		expect(await moveMap({ lat: 48.8566, lng: 2.3522 }, 14)).toBe(true);
	});

	it("imports locations by paste", async () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({
			lat: 52.1 + i * 0.001,
			lng: 34.9 + i * 0.001,
			heading: i * 10,
		}));
		await withApi(async (api, text) => api._test.importPaste(text), JSON.stringify(rows));
		expect(await getLocCount()).toBeGreaterThanOrEqual(5);
	});

	it("creates a location by clicking covered map space (real SV lookup)", async () => {
		await moveMap(OFFICIAL_COORDS, 14);
		const before = await getLocCount();
		await browser.waitUntil(
			async () => {
				await withApi(
					async (api, la, ln) => {
						const host = api.getMapHost();
						if (!host) throw new Error("no map host");
						host.triggerClickAt({ lat: la, lng: ln });
					},
					OFFICIAL_COORDS.lat,
					OFFICIAL_COORDS.lng,
				);
				return (await getLocCount()) > before;
			},
			{ timeout: 30000, interval: 1500, timeoutMsg: "covered click never created a location" },
		);
		const locs = await getAllLocs();
		expect(locs[locs.length - 1].panoId).toBeTruthy();
	});

	it("renders a pano in the location preview", async () => {
		const ids = await addLocs([
			createLocation({
				...OFFICIAL_COORDS,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				heading: 90,
			}),
		]);
		await openLocation(ids[0]);
		await browser
			.$(".location-preview canvas.widget-scene-canvas")
			.waitForExist({ timeout: 30000, timeoutMsg: "pano canvas never mounted" });
		await browser.waitUntil(
			async () =>
				browser.execute(() => {
					const c = document.querySelector<HTMLCanvasElement>(
						".location-preview canvas.widget-scene-canvas",
					);
					return !!c && c.width > 0 && c.height > 0;
				}),
			{ timeout: 30000, timeoutMsg: "pano canvas never sized" },
		);
		await closeLocation();
	});

	it("cycles every basemap, including the vector (maplibre) ones", async () => {
		const TRIGGER = ".map-type-control .map-control__menu-button";
		const PANEL = ".map-type-control .settings-popup";
		await openPanel(TRIGGER, PANEL);
		const buttons = await browser.$$(`${PANEL} .map-type-control__button`);
		expect(buttons.length).toBeGreaterThan(1);
		for (let i = 0; i < buttons.length; i++) {
			await openPanel(TRIGGER, PANEL);
			const btns = await browser.$$(`${PANEL} .map-type-control__button`);
			await btns[i].click();
			await browser.waitUntil(
				async () =>
					(await browser.$$(`${PANEL} .map-type-control__button[data-state='on']`)).length === 1,
				{ timeout: 5000, timeoutMsg: "basemap selection never settled" },
			);
		}
		// Back to the default so later cases run against the Google map.
		await openPanel(TRIGGER, PANEL);
		await (await browser.$$(`${PANEL} .map-type-control__button`))[0].click();
		await browser.$(TRIGGER).click();
	});

	// The vali plugin frames this page, and its inline bootstrap script is what applies the
	// MMA theme. script-src has no 'unsafe-inline'; the script survives only because Tauri
	// nonces the inline scripts in the HTML it serves. A frame reports its violations into
	// its own document, so this asserts the effect instead of listening for the block.
	it("runs the framed vali GUI's inline bootstrap", async () => {
		const hostClass = await browser.executeAsync((done: (r: string | null) => void) => {
			const frame = document.createElement("iframe");
			frame.src = "/valig/index.html?host=mma";
			frame.style.cssText = "position:fixed;left:-9999px;width:400px;height:300px";
			const finish = (r: string | null) => {
				frame.remove();
				done(r);
			};
			frame.onload = () => finish(frame.contentDocument?.documentElement.className ?? null);
			frame.onerror = () => finish(null);
			setTimeout(() => finish("timeout"), 15000);
			document.body.appendChild(frame);
		});
		expect(hostClass).toContain("host-mma");
	});

	it("opens the editor dialogs", async () => {
		for (const [label, panel] of [
			["Export", ".export-modal"],
			["History", ".version-history-modal"],
			["Seen", ".seen-dialog"],
		] as const) {
			await browser.$(`button=${label}`).click();
			await browser.$(panel).waitForExist({ timeout: 10000, timeoutMsg: `${label} never opened` });
			await escapeUntilGone(panel);
		}
	});

	it("opens settings, the plugin marketplace and the manual", async () => {
		await closeMap();

		await clickByTitle("Settings");
		await browser
			.$("[data-qa^='settings-nav-']")
			.waitForExist({ timeout: 10000, timeoutMsg: "settings never opened" });
		await browser.keys("Escape");

		await clickByTitle("Plugins");
		// The marketplace fetches its registry from GitHub over the network; wait for the
		// request to resolve one way or the other, then move on.
		await browser
			.$(".plugin-marketplace, .marketplace")
			.waitForExist({ timeout: 10000 })
			.catch(() => undefined);
		await browser.keys("Escape");

		await browser.execute(() => {
			location.hash = "#manual";
		});
		await browser.$(".manual").waitForExist({ timeout: 10000, timeoutMsg: "manual never opened" });
		await browser.execute(() => {
			location.hash = "#";
		});

		await withApi(async (api, id) => api._test.openMap(id), mapId);
		await browser.$(".page-map-editor").waitForExist({ timeout: 10000 });
	});

	it("reported no CSP violations", async () => {
		const violations = await readViolations();
		if (violations.length > 0) {
			throw new Error(
				`${violations.length} CSP violation(s) across the driven paths:\n${format(violations)}`,
			);
		}
		expect(violations).toHaveLength(0);
	});
});
