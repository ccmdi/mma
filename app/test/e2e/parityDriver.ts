import http from "node:http";
import { withApi } from "./helpers";
import { SV_STUB_TIMELINE_PATH, svStubPort } from "./svStubServer";
import { analyzeTimeline, type NetEntry, type NetStats } from "./svLatency";

/**
 * One driver, two engines. v0.9.2 ran enrichment in the webview off a Location[]; the
 * current build runs it in Rust off a Selector, and the map metadata moved from
 * `map.meta.settings` to `map.settings`. Every difference the harness must know about
 * lives here, so the bench and the parity diff stay one script each.
 */

export interface Build {
	legacy: boolean;
	version: string;
}

/** "Every location" is a `Scope` on v0.9.2 and a `Selector` on the current build. */
export const everything = (legacy: boolean): unknown => (legacy ? { kind: "all" } : { type: "Everything" });

/** Detected from the API itself rather than an env flag: the harness cannot mislabel
 *  which binary it is actually driving. */
export async function detectBuild(): Promise<Build> {
	return withApi(async (api) => {
		const a = api as unknown as Record<string, unknown>;
		const cmd = a.cmd as Record<string, (...x: unknown[]) => Promise<unknown>>;
		const created = (await cmd.storeCreateMap("__probe__", null)) as Record<string, unknown>;
		const legacy = !!created && "meta" in created;
		const meta = (created.meta ?? created) as Record<string, unknown>;
		await (a.deleteMap as (id: string) => Promise<void>)(String(meta.id));
		const version = String((a.version as string | undefined) ?? (legacy ? "0.9.2" : "head"));
		return { legacy, version };
	});
}

export interface SeedRow {
	lat: number;
	lng: number;
	imageDate: string;
}

/** The capture month the mock reports for a coordinate it has no fixture for. A seeded
 *  row must carry it, or the hidden capture second falls outside the searched window and
 *  every probe honestly answers "no coverage". */
export const MOCK_GENERIC_IMAGE_DATE = "2022-06";

/** Deterministic rows spread over land coordinates the mock answers for. */
export function seedRows(n: number, seed = 1): SeedRow[] {
	const rows: SeedRow[] = [];
	let h = seed >>> 0;
	const next = () => {
		h = (h * 1664525 + 1013904223) >>> 0;
		return h / 0x100000000;
	};
	for (let i = 0; i < n; i++) {
		const lat = Number((-55 + next() * 110).toFixed(4));
		const lng = Number((-170 + next() * 340).toFixed(4));
		rows.push({ lat, lng, imageDate: MOCK_GENERIC_IMAGE_DATE });
	}
	return rows;
}

export async function createMap(name: string): Promise<string> {
	return withApi(async (api, n) => {
		const a = api as unknown as Record<string, unknown>;
		const cmd = a.cmd as Record<string, (...x: unknown[]) => Promise<unknown>>;
		const created = (await cmd.storeCreateMap(n, null)) as Record<string, unknown>;
		const meta = (created.meta ?? created) as Record<string, unknown>;
		const test = a._test as Record<string, (...x: unknown[]) => Promise<unknown>> | undefined;
		const id = String(meta.id);
		if (test?.openMap) await test.openMap(id);
		else await (a.openMap as (i: string) => Promise<unknown>)(id);
		return id;
	}, name);
}

export async function dropMap(id: string): Promise<void> {
	await withApi(async (api, mapId) => {
		const a = api as unknown as Record<string, unknown>;
		try {
			await (a.closeMap as () => Promise<void>)();
		} catch {
			/* already closed */
		}
		await (a.deleteMap as (i: string) => Promise<void>)(mapId);
	}, id);
}

/** Enrichment settings live at a different depth per build; both are written here. */
export async function setEnrich(fields: string[]): Promise<void> {
	await withApi(async (api, f) => {
		const a = api as unknown as Record<string, unknown>;
		const state = (a.getMapState as () => Record<string, unknown>)();
		const map = state.map as Record<string, unknown>;
		const holder = ("meta" in map ? map.meta : map) as Record<string, unknown>;
		const settings = { ...(holder.settings as object), enrichMetadata: true, enrichFields: f };
		await (a.updateMapMeta as (p: unknown) => Promise<unknown>)({ settings });
		const persist = a.waitForInflightPersist as (() => Promise<void>) | undefined;
		if (persist) await persist();
	}, fields);
}

export async function addRows(rows: SeedRow[], legacy = false): Promise<number[]> {
	return withApi(async (api, batch, scope) => {
		const a = api as unknown as Record<string, unknown>;
		const make = a.createLocation as ((lat: number, lng: number) => Record<string, unknown>) | undefined;
		const locs = (batch as SeedRow[]).map((r) => {
			const base = make
				? make(r.lat, r.lng)
				: {
						id: 0,
						lat: r.lat,
						lng: r.lng,
						heading: 0,
						pitch: 0,
						zoom: 0,
						panoId: null,
						flags: 0,
						tags: [],
						createdAt: Math.floor(Date.now() / 1000),
						modifiedAt: null,
					};
			return { ...base, lat: r.lat, lng: r.lng, extra: { imageDate: r.imageDate } };
		});
		await (a.addLocations as (l: unknown[]) => Promise<unknown>)(locs);
		const all = (await (a.fetchLocations as (s: unknown) => Promise<Record<string, unknown>[]>)(
			scope,
		)) as Record<string, unknown>[];
		return all.map((l) => Number(l.id));
	}, rows, everything(legacy));
}

/** Fixture rows carry a pano, flags and pre-existing extras; `addRows` only carries a
 *  capture month. Both land through the same add call. */
export async function addFixture(
	rows: { lat: number; lng: number; panoId?: string | null; flags?: number; extra?: Record<string, unknown> }[],
	legacy = false,
): Promise<number[]> {
	return withApi(async (api, batch, scope) => {
		const a = api as unknown as Record<string, unknown>;
		const make = a.createLocation as
			| ((lat: number, lng: number) => Record<string, unknown>)
			| undefined;
		const locs = (batch as Record<string, unknown>[]).map((r) => {
			const lat = Number(r.lat);
			const lng = Number(r.lng);
			const base = make
				? make(lat, lng)
				: {
						id: 0,
						lat,
						lng,
						heading: 0,
						pitch: 0,
						zoom: 0,
						panoId: null,
						flags: 0,
						tags: [],
						createdAt: Math.floor(Date.now() / 1000),
						modifiedAt: null,
					};
			return {
				...base,
				lat,
				lng,
				panoId: (r.panoId as string | undefined) ?? null,
				flags: Number(r.flags ?? 0),
				extra: (r.extra as Record<string, unknown> | undefined) ?? {},
			};
		});
		await (a.addLocations as (l: unknown[]) => Promise<unknown>)(locs);
		const all = (await (a.fetchLocations as (s: unknown) => Promise<Record<string, unknown>[]>)(
			scope,
		)) as Record<string, unknown>[];
		return all.map((l) => Number(l.id));
	}, rows, everything(legacy));
}

export interface EnrichRun {
	durationMs: number;
	outcomes: { id: string; success: number; failed: number }[];
}

/** Runs the build's own enrichment over the whole map and times it end to end. */
export async function runEnrich(build: Build, force = true): Promise<EnrichRun> {
	return withApi(
		async (api, legacy, doForce, scope) => {
			const a = api as unknown as Record<string, unknown>;
			const enrichAll = a.enrichAll as (t: unknown, o: unknown) => Promise<unknown>;
			const target = legacy
				? await (a.fetchLocations as (s: unknown) => Promise<unknown[]>)(scope)
				: scope;
			const start = Date.now();
			const res = (await enrichAll(target, { force: doForce })) as
				| { id?: string; success?: unknown[]; failed?: unknown[] }[]
				| undefined;
			const durationMs = Date.now() - start;
			const outcomes = (res ?? []).map((o) => ({
				id: String(o.id ?? "?"),
				success: (o.success ?? []).length,
				failed: (o.failed ?? []).length,
			}));
			return { durationMs, outcomes };
		},
		build.legacy,
		force,
		everything(build.legacy),
	);
}

/** Every row as the build left it: the parity diff's raw material. */
export async function dumpRows(legacy = false): Promise<Record<string, unknown>[]> {
	return withApi(async (api, scope) => {
		const a = api as unknown as Record<string, unknown>;
		const rows = (await (a.fetchLocations as (s: unknown) => Promise<Record<string, unknown>[]>)(
			scope,
		)) as Record<string, unknown>[];
		return rows
			.map((l) => ({
				lat: l.lat,
				lng: l.lng,
				panoId: l.panoId ?? null,
				flags: l.flags ?? 0,
				heading: l.heading,
				extra: (l.extra ?? {}) as Record<string, unknown>,
			}))
			.sort((x, y) => (x.lat as number) - (y.lat as number) || (x.lng as number) - (y.lng as number));
	}, everything(legacy));
}

async function stubTimeline(reset: boolean): Promise<NetEntry[]> {
	return new Promise((resolve) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: svStubPort(),
				path: SV_STUB_TIMELINE_PATH,
				method: reset ? "DELETE" : "GET",
				timeout: 5000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as NetEntry[]);
					} catch {
						resolve([]);
					}
				});
			},
		);
		req.on("error", () => resolve([]));
		req.on("timeout", () => {
			req.destroy();
			resolve([]);
		});
		req.end();
	});
}

async function webviewTimeline(reset: boolean): Promise<NetEntry[]> {
	return browser.execute((clear: boolean) => {
		const w = window as unknown as { __mmaSvTimeline?: NetEntry[] };
		const t = w.__mmaSvTimeline ?? [];
		const copy = t.slice();
		if (clear) t.length = 0;
		return copy;
	}, reset) as unknown as NetEntry[];
}

export async function resetTimelines(): Promise<void> {
	await stubTimeline(true);
	await webviewTimeline(true);
}

export interface SidedStats {
	surface: "engine" | "webview" | "none";
	stats: NetStats;
}

/** Whichever surface served the run is the one that did the work: the Rust engine goes
 *  through the HTTP stub, the v0.9.2 runner through the patched window.fetch. */
export async function collectNet(): Promise<SidedStats> {
	const engine = (await stubTimeline(false)).filter((e) => e.kind === "SingleImageSearch");
	const webview = (await webviewTimeline(false)).filter((e) => e.kind === "SingleImageSearch");
	if (engine.length >= webview.length && engine.length > 0) {
		return { surface: "engine", stats: analyzeTimeline(engine) };
	}
	if (webview.length > 0) return { surface: "webview", stats: analyzeTimeline(webview) };
	return { surface: "none", stats: analyzeTimeline([]) };
}
