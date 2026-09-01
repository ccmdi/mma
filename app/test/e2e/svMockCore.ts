/**
 * Street View mock fixtures + response builders, shared by the two consumers:
 *
 *  - the webview mock (`svMock.ts` -> `installSvMock`), which patches window.fetch
 *    and google.maps for app code that fetches from JS;
 *  - the Node stub server (`svStubServer.ts`), which serves the same three RPCs over
 *    HTTP for the Rust procedure engine (it fetches with reqwest, out of the
 *    webview's reach).
 *
 * `installSvMock` is serialized by `browser.execute`, so it cannot import this module.
 * Instead the whole thing is ONE self-contained function whose source is shipped into
 * the page as a string and re-evaluated there. That is why nothing below may reference
 * an import or an outer binding.
 */
export interface SvNetModel {
	depths: { inflight: number; ms: number[] }[];
}

export interface SvMockConfig {
	net?: SvNetModel | null;
	fixedMs?: number;
	hiddenCapture?: boolean;
	/** Requests served at once; the rest queue. 0 = unbounded, which lets an engine
	 *  claim width no real endpoint would grant it. */
	maxInflight?: number;
}

export function svMockCore(cfg: SvMockConfig = {}) {
	interface Fix {
		lat: number;
		lng: number;
		cc: string;
		alt: number;
		dates: string[];
	}
	const FIX: Record<string, Fix> = {
		"-zrYsLR4Fh-cfJG_EMZ1-A": {
			lat: 52.10947502806108,
			lng: 34.90131410856584,
			cc: "RU",
			alt: 142,
			dates: ["2012-08", "2015-06", "2021-09"],
		},
		CAoSF0NJSE0wb2dLRUlDQWdJQ3FpZG1xM3dF: {
			lat: 64.44241333767505,
			lng: 46.193924009405855,
			cc: "RU",
			alt: 90,
			dates: ["2019-07"],
		},
		"5upMz1_zTGPdkIXG6_QM3g": {
			lat: 55.510656,
			lng: 157.636627,
			cc: "RU",
			alt: 30,
			dates: ["2018-05"],
		},
	};
	const isDead = (p: string) => !p || /DEAD|DOES_NOT_EXIST/i.test(p);
	const fixFor = (pano: string, lat = 0, lng = 0): Fix | null => {
		if (isDead(pano)) return null;
		if (FIX[pano]) return FIX[pano];
		// Coords are encoded in synthetic ids (MOCK_lat_lng) so a pano fetched by id
		// resolves to the same position it did when found by coordinate.
		const m = /^MOCK_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)$/.exec(pano);
		const [la, ln] = m ? [+m[1], +m[2]] : [lat, lng];
		return { lat: la, lng: ln, cc: "US", alt: 100, dates: ["2020-06", "2022-06"] };
	};
	const panoAtCoords = (lat: number, lng: number): string | null => {
		if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) return null; // ocean
		for (const [p, f] of Object.entries(FIX)) {
			if (Math.abs(f.lat - lat) < 0.01 && Math.abs(f.lng - lng) < 0.01) return p;
		}
		return `MOCK_${lat.toFixed(4)}_${lng.toFixed(4)}`;
	};
	const ymDate = (ym: string): Date => {
		const [y, m] = ym.split("-").map(Number);
		return new Date(y, (m ?? 1) - 1, 1);
	};
	/** Ids of a pano's earlier captures, one per date but the last (which is the pano itself). */
	const olderPanos = (pano: string, f: Fix): string[] =>
		f.dates.slice(0, -1).map((_, i) => `${pano}~${i}`);

	// Minimal protobuf wire-format writer: GetMetadata is requested with alt=proto and
	// the response is parsed with the generated schema reader.
	const varint = (n: number): number[] => {
		const o = [];
		while (n > 127) {
			o.push((n & 127) | 128);
			n >>>= 7;
		}
		o.push(n);
		return o;
	};
	const fVar = (field: number, v: number): number[] => [...varint(field << 3), ...varint(v)];
	const fMsg = (field: number, payload: number[]): number[] => [
		...varint((field << 3) | 2),
		...varint(payload.length),
		...payload,
	];
	const fStr = (field: number, s: string): number[] =>
		fMsg(field, [...new TextEncoder().encode(s)]);
	const fDbl = (field: number, v: number): number[] => {
		const b = new Uint8Array(8);
		new DataView(b.buffer).setFloat64(0, v, true);
		return [...varint((field << 3) | 1), ...b];
	};
	const fFlt = (field: number, v: number): number[] => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setFloat32(0, v, true);
		return [...varint((field << 3) | 5), ...b];
	};

	// One GetMetadata ImageMetadata message, matching the schema svMeta reads.
	// imageKey is echoed into pano (f2) so imageKeyToPanoId round-trips to the original id.
	const metaResult = (imageKey: [number, string] | undefined): number[] => {
		const pano = imageKey && imageKey[1] ? imageKey[1] : "";
		const f = fixFor(pano);
		if (!f) return fMsg(1, fVar(1, 3)); // status != 1 -> the decode yields null
		const [y, m] = f.dates[f.dates.length - 1].split("-").map(Number);
		const locData = [
			...fMsg(1, [...fDbl(3, f.lat), ...fDbl(4, f.lng)]),
			...fMsg(2, fFlt(1, f.alt)),
			...fMsg(3, fFlt(1, 0)),
			...fStr(5, f.cc),
		];
		const tiles = [
			...fMsg(3, [...fVar(1, 8192), ...fVar(2, 16384)]), // worldH 8192 -> gen4
			...fMsg(4, fMsg(2, [...fVar(1, 512), ...fVar(2, 512)])),
		];
		// The older captures are relations (f4) the timeline (f9) points into; the pano's own
		// capture comes from the top-level date, as on the wire.
		const older = olderPanos(pano, f);
		const relations = fMsg(
			4,
			older.flatMap((id) => fMsg(1, fMsg(1, [...fVar(1, 2), ...fStr(2, id)]))),
		);
		const time = older.flatMap((_, i) => {
			const [ty, tm] = f.dates[i].split("-").map(Number);
			return fMsg(9, [...fVar(1, i), ...fMsg(2, [...fVar(1, ty), ...fVar(2, tm), ...fVar(3, 1)])]);
		});
		return [
			...fMsg(1, fVar(1, 1)),
			...fMsg(2, [...fVar(1, imageKey?.[0] ?? 2), ...fStr(2, pano)]),
			...fMsg(3, tiles),
			...fMsg(6, [...fMsg(2, locData), ...relations, ...time]),
			...fMsg(7, fMsg(8, [...fVar(1, y), ...fVar(2, m), ...fVar(3, 1)])),
		];
	};

	/** The same `ImageMetadata` as `metaResult`, in the array-JSON form a location search
	 *  answers: index i is field i+1. */
	const metaArray = (pano: string, lat = 0, lng = 0): unknown[] | null => {
		const f = fixFor(pano, lat, lng);
		if (!f) return null;
		const [y, m] = f.dates[f.dates.length - 1].split("-").map(Number);
		const older = olderPanos(pano, f);
		const relations = [older.map((id) => [[2, id]])];
		const time = older.map((_, i) => {
			const [ty, tm] = f.dates[i].split("-").map(Number);
			return [i, [ty, tm, 1]];
		});
		const information = [
			[1],
			[[null, null, f.lat, f.lng], [f.alt], [0, 90, 0], null, f.cc],
			null,
			relations,
			null,
			null,
			null,
			null,
			time,
		];
		return [
			[1], // status
			[2, pano], // pano key
			[null, null, [8192, 16384], [null, [512, 512]]], // tiles: worldSize, tileSize
			null, // description
			null, // attribution
			[information],
			[null, null, null, null, null, null, null, [y, m, 1]], // date
		];
	};

	// Decode the binary GetMetadataRequest just enough to pull the requested image keys
	// (field 3 = KeyWrapper { 1: ImageKey { 1: type, 2: id } }).
	const readVarint = (b: Uint8Array, p: { i: number }): number => {
		let v = 0;
		let s = 0;
		for (;;) {
			const x = b[p.i++];
			v |= (x & 127) << s;
			if (x < 128) return v >>> 0;
			s += 7;
		}
	};
	const skipField = (b: Uint8Array, p: { i: number }, wire: number): void => {
		if (wire === 0) readVarint(b, p);
		else if (wire === 1) p.i += 8;
		else if (wire === 5) p.i += 4;
		else {
			const len = readVarint(b, p); // read first: it advances p.i
			p.i += len;
		}
	};
	const requestKeys = (body: unknown): [number, string][] => {
		const b =
			body instanceof Uint8Array
				? body
				: new Uint8Array(body instanceof ArrayBuffer ? body : new ArrayBuffer(0));
		const keys: [number, string][] = [];
		const p = { i: 0 };
		while (p.i < b.length) {
			const tag = readVarint(b, p);
			if (tag >> 3 !== 3 || (tag & 7) !== 2) {
				skipField(b, p, tag & 7);
				continue;
			}
			const wrapLen = readVarint(b, p);
			const wrapEnd = p.i + wrapLen;
			let type = 2;
			let id = "";
			while (p.i < wrapEnd) {
				const t2 = readVarint(b, p);
				if (t2 >> 3 === 1 && (t2 & 7) === 2) {
					const keyLen = readVarint(b, p);
					const keyEnd = p.i + keyLen;
					while (p.i < keyEnd) {
						const t3 = readVarint(b, p);
						if (t3 >> 3 === 1 && (t3 & 7) === 0) type = readVarint(b, p);
						else if (t3 >> 3 === 2 && (t3 & 7) === 2) {
							const len = readVarint(b, p);
							id = new TextDecoder().decode(b.slice(p.i, p.i + len));
							p.i += len;
						} else skipField(b, p, t3 & 7);
					}
				} else skipField(b, p, t2 & 7);
			}
			keys.push([type, id]);
			p.i = wrapEnd;
		}
		return keys;
	};

	/** Pano data as google.maps.StreetViewService.getPanorama returns it. Browser-only. */
	const viewerData = (pano: string, f: Fix): Record<string, unknown> => {
		const last = f.dates.length - 1;
		return {
			copyright: "",
			location: {
				latLng: { lat: () => f.lat, lng: () => f.lng },
				pano,
				shortDescription: "",
				description: "",
			},
			imageDate: f.dates[last],
			time: f.dates.map((d, i) => ({
				pano: i === last ? pano : olderPanos(pano, f)[i],
				AA: ymDate(d),
			})),
			links: [],
			tiles: {
				worldSize: { width: 16384, height: 8192 },
				tileSize: { width: 512, height: 512 },
				centerHeading: 0,
				originHeading: 0,
			},
		};
	};

	const depths = (cfg.net?.depths ?? []).slice().sort((a, b) => a.inflight - b.inflight);
	const fixedMs = cfg.fixedMs ?? 0;
	let live = 0;
	let rnd = 1;
	const pickMs = (depth: number): number => {
		if (!depths.length) return fixedMs;
		let best = depths[0];
		for (const d of depths) {
			if (Math.abs(d.inflight - depth) < Math.abs(best.inflight - depth)) best = d;
		}
		rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
		return best.ms[rnd % best.ms.length];
	};

	interface NetEntry {
		kind: string;
		/** When the caller asked. `start` is when a slot opened: the gap is queueing. */
		queued: number;
		start: number;
		end: number;
		depth: number;
		ms: number;
	}
	const timeline: NetEntry[] = [];
	const cap = cfg.maxInflight && cfg.maxInflight > 0 ? cfg.maxInflight : Infinity;
	const waiting: (() => void)[] = [];
	const pump = (): void => {
		while (live < cap && waiting.length) {
			const next = waiting.shift();
			if (next) next();
		}
	};
	const serve = (kind: string): Promise<void> =>
		new Promise<void>((resolve) => {
			const e: NetEntry = {
				kind,
				queued: Date.now(),
				start: 0,
				end: 0,
				depth: 0,
				ms: 0,
			};
			timeline.push(e);
			const begin = () => {
				live++;
				e.start = Date.now();
				e.depth = live;
				e.ms = pickMs(live);
				setTimeout(() => {
					e.end = Date.now();
					live--;
					resolve();
					pump();
				}, e.ms);
			};
			waiting.push(begin);
			pump();
		});
	const net = { serve, timeline };

	/** The pano's true capture second, hashed into the month its newest date names, so a
	 *  range probe can answer honestly and a bisection converges on a real value. */
	const captureTs = (pano: string, f: Fix): number => {
		const ym = f.dates[f.dates.length - 1];
		const [y, mo] = ym.split("-").map(Number);
		let h = 2166136261;
		for (let i = 0; i < pano.length; i++) {
			h = ((h ^ pano.charCodeAt(i)) * 16777619) >>> 0;
		}
		const first = Date.UTC(y, (mo ?? 1) - 1, 1) / 1000;
		const days = new Date(Date.UTC(y, mo ?? 1, 0)).getUTCDate();
		return first + (h % (days * 86400));
	};

	interface MockReply {
		kind: "GetMetadata" | "photometa" | "SingleImageSearch";
		status: number;
		contentType: string;
		body: Uint8Array | string;
	}

	/**
	 * The one router. `url` is matched by substring exactly as the browser mock always
	 * did, so an origin-rewritten engine request hits the same branch. Returns null for
	 * anything unrecognized (browser: fall through to the real fetch; Node: 404).
	 */
	const respond = (url: string, body: Uint8Array | null): MockReply | null => {
		if (url.includes("GetMetadata")) {
			const results = requestKeys(body).flatMap((k) => fMsg(2, metaResult(k)));
			return {
				kind: "GetMetadata",
				status: 200,
				contentType: "application/x-protobuf",
				body: new Uint8Array([...fMsg(1, fVar(1, 0)), ...results]),
			};
		}
		if (url.includes("/maps/photometa/")) {
			// Coverage-dot tile used by photometaSnap (map-click lookup): one dot at the
			// tile center, shaped as parsePanoDots reads it (data[1][1][n][0] = info,
			// info[0][1] = panoId, info[2][0] = [,,lat,lng]).
			const m = /!6m3!1i(\d+)!2i(\d+)!3i(\d+)/.exec(url);
			let entries: unknown[] = [];
			if (m) {
				const n = 2 ** +m[3];
				const lng = ((+m[1] + 0.5) / n) * 360 - 180;
				const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (+m[2] + 0.5)) / n))) * 180) / Math.PI;
				const pano = panoAtCoords(lat, lng);
				if (pano) entries = [[[[null, pano], null, [[null, null, lat, lng]]]]];
			}
			return {
				kind: "photometa",
				status: 200,
				contentType: "application/json",
				body: ")]}'\n" + JSON.stringify([null, [null, entries]]),
			};
		}
		if (url.includes("SingleImageSearch")) {
			// Two callers share this RPC. Both send field 2 = [[null,null,lat,lng],radius];
			// only the exact-date probe fills the imagery date range at options[0][10].
			// Without it the request is a location search -- the mirror of
			// StreetViewService.getPanorama({location, radius}).
			let req: unknown[] | null = null;
			try {
				const text =
					body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
				const parsed: unknown = JSON.parse(text);
				if (Array.isArray(parsed)) req = parsed;
			} catch {
				req = null;
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const r = req as any;
			const ll = r?.[1]?.[0];
			const located = Array.isArray(ll) && typeof ll[2] === "number" && typeof ll[3] === "number";
			if (located && !r?.[2]?.[0]?.[10]) {
				const pano = panoAtCoords(ll[2], ll[3]);
				const meta = pano ? metaArray(pano, ll[2], ll[3]) : null;
				return {
					kind: "SingleImageSearch",
					status: 200,
					contentType: "application/json",
					// [status, ImageMetadata] -- the whole image, as the real RPC answers it.
					body: meta
						? JSON.stringify([[0], meta, null])
						: JSON.stringify([[5, "generic", "Search returned no images."]]),
				};
			}
			const range = r?.[2]?.[0]?.[10];
			if (cfg.hiddenCapture && located && Array.isArray(range)) {
				const pano = panoAtCoords(ll[2], ll[3]);
				const f = pano ? fixFor(pano, ll[2], ll[3]) : null;
				const ts = pano && f ? captureTs(pano, f) : null;
				const hit = ts != null && ts > Number(range[0]) && ts <= Number(range[1]);
				return {
					kind: "SingleImageSearch",
					status: 200,
					contentType: "application/json",
					body: hit
						? JSON.stringify([["img"]])
						: JSON.stringify([[5, "generic", "Search returned no images."]]),
				};
			}
			// Any non-"no images" body counts as "image found", so the exactDate procedure's
			// binary search always narrows downward and converges to a valid timestamp.
			return {
				kind: "SingleImageSearch",
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([["img"]]),
			};
		}
		return null;
	};

	return { FIX, isDead, fixFor, panoAtCoords, ymDate, viewerData, respond, net, captureTs };
}

export type SvMockCore = ReturnType<typeof svMockCore>;
