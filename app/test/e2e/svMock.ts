/**
 * Street View mock, installed from the test side by monkey-patching the runtime
 * boundaries the app uses -- NO app code is touched. Enabled via the wdio `beforeSuite`
 * hook when MMA_TEST_MOCK_SV is set (scripts/e2e.sh --mock).
 *
 *  - window.fetch: the app fetches Google's internal RPCs directly for GetMetadata
 *    (svMetadata) and SingleImageSearch. We return
 *    hand-built protobuf-array responses shaped exactly as the schema reader expects.
 *  - google.maps.StreetViewService.getPanorama: fetchPanoData / getPanoAtCoords go
 *    through this (opensv sets window.google). We return canned pano data.
 *  - google.maps.StreetViewPanorama (the viewer): its `status_changed` event drives
 *    seen-recording. Real tiles never load offline, so we override getStatus/getPano/
 *    getPosition and fire the event after setPano.
 *
 * Fetches made by the Rust procedure engine never reach window.fetch; those are served
 * by the Node stub (svStubServer.ts) over HTTP, built from the same svMockCore.
 *
 * The function below is serialized and run in the webview via browser.execute, so it
 * must be entirely self-contained (no imports, no outer references). The shared
 * fixtures arrive as `coreSrc`, the source text of `svMockCore`, re-evaluated here.
 * `latencyMs` delays every mocked answer, matching what the Node stub serves the engine.
 */
export function installSvMock(coreSrc: string, latencyMs = 0): void {
	type ViewerInst = { __mp?: string; __mpos?: { lat: number; lng: number } | null };
	type ProtoBag = Record<string, unknown> & { __mmaMocked?: boolean };
	interface Fix {
		lat: number;
		lng: number;
		cc: string;
		alt: number;
		dates: string[];
	}
	interface Core {
		isDead: (p: string) => boolean;
		fixFor: (pano: string, lat?: number, lng?: number) => Fix | null;
		panoAtCoords: (lat: number, lng: number) => string | null;
		viewerData: (pano: string, f: Fix) => Record<string, unknown>;
		respond: (
			url: string,
			body: Uint8Array | null,
		) => { status: number; body: Uint8Array | string } | null;
	}
	interface GoogleLike {
		maps?: {
			StreetViewService?: { prototype: ProtoBag };
			StreetViewPanorama?: { prototype: ProtoBag };
			event?: { trigger: (target: unknown, name: string) => void };
		};
	}
	const w = window as unknown as {
		fetch: typeof fetch;
		google?: GoogleLike;
		__mmaSvMocked?: boolean;
	};
	if (w.__mmaSvMocked) return;
	w.__mmaSvMocked = true;

	// esbuild's keepNames wraps every nested function in a `__name` helper that only
	// exists at the top of the emitted module, so the eval'd source needs its own.
	const core = (new Function(`var __name = (f) => f; return (${coreSrc})`)() as () => Core)();
	const { isDead, fixFor, panoAtCoords, viewerData } = core;

	// --- window.fetch -------------------------------------------------------
	const origFetch = w.fetch.bind(w);

	w.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
		const body = init?.body;
		const bytes =
			body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : null;
		const reply = core.respond(url, bytes);
		if (reply) {
			if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
			return new Response(reply.body as BodyInit, { status: reply.status });
		}
		return origFetch(input, init);
	} as typeof fetch;

	// --- google.maps.StreetViewService.getPanorama --------------------------
	type PanoRequest = {
		pano?: string;
		location?: { lat: number | (() => number); lng: number | (() => number) };
	};
	const mockGetPanorama = async (req?: PanoRequest): Promise<{ data: Record<string, unknown> }> => {
		let pano: string | null = null;
		let rlat = 0;
		let rlng = 0;
		if (req?.pano) pano = req.pano;
		else if (req?.location) {
			const ll = req.location;
			rlat = typeof ll.lat === "function" ? ll.lat() : ll.lat;
			rlng = typeof ll.lng === "function" ? ll.lng() : ll.lng;
			pano = panoAtCoords(rlat, rlng);
		}
		const f = pano ? fixFor(pano, rlat, rlng) : null;
		if (!pano || !f) return { data: {} }; // no location -> app treats as null
		return { data: viewerData(pano, f) };
	};

	// --- google.maps.StreetViewPanorama (the viewer) ------------------------
	// Drives seen-recording via status_changed. Keep the real setPano (so getPov/getZoom
	// internals stay live) and only override status/pano/position + fire the event.
	const patchViewer = (g?: GoogleLike): void => {
		const proto = g?.maps?.StreetViewPanorama?.prototype;
		if (!proto || proto.__mmaMocked) return;
		const origSetPano = proto.setPano as ((this: unknown, p: string) => void) | undefined;
		proto.setPano = function (this: ViewerInst, p: string) {
			this.__mp = p;
			const f = p && !isDead(p) ? fixFor(p) : null;
			this.__mpos = f ? { lat: f.lat, lng: f.lng } : null;
			try {
				if (origSetPano) origSetPano.call(this, p);
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				try {
					g?.maps?.event?.trigger(this, "pano_changed");
					g?.maps?.event?.trigger(this, "status_changed");
				} catch {
					/* ignore */
				}
			}, 0);
		};
		proto.getStatus = function (this: ViewerInst) {
			return this.__mp && !isDead(this.__mp) ? "OK" : "ZERO_RESULTS";
		};
		proto.getPano = function (this: ViewerInst) {
			return this.__mp || "";
		};
		proto.getPosition = function (this: ViewerInst) {
			const p = this.__mpos;
			return p ? { lat: () => p.lat, lng: () => p.lng } : null;
		};
		proto.__mmaMocked = true;
	};

	const patchSVS = (g?: GoogleLike): boolean => {
		const proto = g?.maps?.StreetViewService?.prototype;
		if (!proto) return false;
		if (!proto.__mmaMocked) {
			proto.getPanorama = mockGetPanorama;
			proto.__mmaMocked = true;
		}
		patchViewer(g);
		return true;
	};

	// opensv builds google.maps lazily and by mutation, so poll for StreetViewService
	// and patch the prototypes the moment it appears -- before the first pano lookup.
	if (!patchSVS(w.google)) {
		const iv = setInterval(() => {
			if (patchSVS((window as unknown as { google?: GoogleLike }).google)) clearInterval(iv);
		}, 10);
		setTimeout(() => clearInterval(iv), 20000);
	}
}
