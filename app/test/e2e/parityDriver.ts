import http from "node:http";
import { withApi } from "./helpers";
import { SV_STUB_FAULTS_PATH, SV_STUB_TIMELINE_PATH, svStubPort } from "./svStubServer";
import { analyzeTimeline, type NetEntry, type NetStats } from "./svLatency";
import { MOCK_GENERIC_IMAGE_DATE } from "./parityFixture";

/**
 * The one place the procedure suites talk to the app: seed a fixture, run a procedure,
 * read every row back. Keeping it here is what lets the bench, the parity golden, the
 * fault cases and the scale digest stay one short script each.
 */

const EVERYTHING = { type: "Everything" };

export interface SeedRow {
	lat: number;
	lng: number;
	imageDate: string;
}

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
		const meta = (await cmd.storeCreateMap(n, null)) as Record<string, unknown>;
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

export async function setEnrich(fields: string[]): Promise<void> {
	await withApi(async (api, f) => {
		const a = api as unknown as Record<string, unknown>;
		const state = (a.getMapState as () => Record<string, unknown>)();
		const map = state.map as Record<string, unknown>;
		const settings = { ...(map.settings as object), enrichMetadata: true, enrichFields: f };
		await (a.updateMapMeta as (p: unknown) => Promise<unknown>)({ settings });
		const persist = a.waitForInflightPersist as (() => Promise<void>) | undefined;
		if (persist) await persist();
	}, fields);
}

export async function addRows(rows: SeedRow[]): Promise<number[]> {
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
	}, rows, EVERYTHING);
}

/** Fixture rows carry a pano, flags and pre-existing extras; `addRows` only carries a
 *  capture month. Both land through the same add call. */
export async function addFixture(
	rows: { lat: number; lng: number; panoId?: string | null; flags?: number; extra?: Record<string, unknown> }[],
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
	}, rows, EVERYTHING);
}

export interface EnrichRun {
	durationMs: number;
	outcomes: { id: string; success: number; failed: number }[];
}

/** Runs the build's own enrichment over the whole map and times it end to end. */
export async function runEnrich(force = true): Promise<EnrichRun> {
	return withApi(
		async (api, doForce, scope) => {
			const a = api as unknown as Record<string, unknown>;
			const enrichAll = a.enrichAll as (t: unknown, o: unknown) => Promise<unknown>;
			const start = Date.now();
			const res = (await enrichAll(scope, { force: doForce })) as
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
		force,
		EVERYTHING,
	);
}

/** Pin every row to a resolved panorama. */
export async function runPin(force = true): Promise<EnrichRun> {
	return withApi(
		async (api, doForce, scope) => {
			const a = api as unknown as Record<string, unknown>;
			const pin = a.bulkPinToPano as (t: unknown, o: unknown) => Promise<{ succeeded: number }>;
			const start = Date.now();
			const pinned = (await pin(scope, { force: doForce })).succeeded;
			return {
				durationMs: Date.now() - start,
				outcomes: [{ id: "pinPano", success: Number(pinned ?? 0), failed: 0 }],
			};
		},
		force,
		EVERYTHING,
	);
}

/** The engine's compute path: a procedure that only calculates, so nothing is waiting
 *  on the network. `entry` is a bundled plugin procedure; rows are polled until the
 *  fields land, because the run itself is fire-and-forget. */
export async function runCompute(
	entry: string,
	fields: string[],
	timeoutMs = 20 * 60 * 1000,
): Promise<{ durationMs: number; written: number }> {
	return withApi(
		async (api, procEntry, procFields, deadlineMs, scope) => {
			const a = api as unknown as Record<string, unknown>;
			const cmd = a.cmd as Record<string, (...x: unknown[]) => Promise<unknown>>;
			const start = Date.now();
			await cmd.procedureRun(
				[
					{
						id: "scaleCompute",
						label: null,
						entry: procEntry,
						fields: procFields,
						requires: [],
						select: scope,
						batch: { mode: "chunk", size: 10_000 },
						rate: null,
						retry: null,
						inflight: null,
						instances: null,
						config: null,
					},
				],
				true,
			);
			// Not every row can produce the field (a compute pass needs its input), so the
			// run is done when the count stops moving, not when it reaches the row count.
			const key = (procFields as string[])[0];
			const deadline = Date.now() + (deadlineMs as number);
			let previous = -1;
			let stable = 0;
			for (;;) {
				const rows = (await (
					a.fetchLocations as (s: unknown) => Promise<Record<string, unknown>[]>
				)(scope)) as Record<string, unknown>[];
				const written = rows.filter(
					(l) => typeof (l.extra as Record<string, unknown> | undefined)?.[key] === "number",
				).length;
				if (written === rows.length) return { durationMs: Date.now() - start, written };
				stable = written === previous ? stable + 1 : 0;
				previous = written;
				if (stable >= 3 && written > 0) return { durationMs: Date.now() - start, written };
				if (Date.now() >= deadline) {
					throw new Error(`compute run stalled at ${written}/${rows.length}`);
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
			}
		},
		entry,
		fields,
		timeoutMs,
		EVERYTHING,
	);
}

/** Validation state per row, reduced to a count per state. */
export async function runValidate(): Promise<{
	durationMs: number;
	states: [number, number][];
}> {
	return withApi(
		async (api, scope) => {
			const a = api as unknown as Record<string, unknown>;
			const validate = a.validateLocations as (t: unknown, o: unknown) => Promise<unknown>;
			const start = Date.now();
			const res = ((await validate(scope, {})) as { states?: Map<number, unknown[]> } | undefined)
				?.states;
			const states: [number, number][] = res
				? [...res.entries()].map(([state, rows]) => [Number(state), rows.length])
				: [];
			states.sort((x, y) => x[0] - y[0]);
			return { durationMs: Date.now() - start, states };
		},
		EVERYTHING,
	);
}

/** Every row as the build left it: the parity diff's raw material. */
export async function dumpRows(): Promise<Record<string, unknown>[]> {
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
	}, EVERYTHING);
}

function stubPost(path: string, payload: string): Promise<number> {
	return new Promise((resolve) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: svStubPort(),
				path,
				method: "POST",
				timeout: 5000,
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("error", () => resolve(0));
		req.on("timeout", () => {
			req.destroy();
			resolve(0);
		});
		req.end(payload);
	});
}

/** Arms the same fault script on both mock surfaces, so a case behaves identically
 *  whichever side of the process boundary the engine fetches from. */
export async function setFaults(faults: Record<string, number[]>): Promise<void> {
	const status = await stubPost(SV_STUB_FAULTS_PATH, JSON.stringify(faults));
	// A fault case that silently fails to arm passes for the wrong reason.
	if (status !== 200) throw new Error(`sv stub refused the fault script (HTTP ${status})`);
	await browser.execute((f: Record<string, number[]>) => {
		const w = window as unknown as { __mmaSvSetFaults?: (x: Record<string, number[]>) => void };
		w.__mmaSvSetFaults?.(f);
	}, faults);
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

/** The engine fetches through the HTTP stub; anything a page fetches is patched in
 *  process. Whichever surface carries the requests is the one that did the work. */
export async function collectNet(): Promise<SidedStats> {
	const engine = (await stubTimeline(false)).filter((e) => e.kind === "SingleImageSearch");
	const webview = (await webviewTimeline(false)).filter((e) => e.kind === "SingleImageSearch");
	if (engine.length >= webview.length && engine.length > 0) {
		return { surface: "engine", stats: analyzeTimeline(engine) };
	}
	if (webview.length > 0) return { surface: "webview", stats: analyzeTimeline(webview) };
	return { surface: "none", stats: analyzeTimeline([]) };
}
