/**
 * Shared Google opensv inject bridge for all prefix-based alt providers.
 *
 * One fetch/XHR/Image/legacy hook stack (stacking per-provider bridges breaks
 * XHR: subclass open() overwrites this.send). GetMetadata/tiles route via
 * {@link registerInjectAdapter}; SIS miss races adapters that expose resolveNear.
 *
 * Not China-scoped — Yandex / Kakao / etc. can register the same way.
 */
import { loadOpenSV } from "@/lib/sv/opensv";
import { schemeBase } from "@/lib/util/util";
import { latLngFromSingleImageSearchRequest } from "@/lib/sv/baidu/officialMeta";
import {
	ensureBuiltinInjectAdapters,
	getInjectAdapters,
	getRaceableInjectAdapters,
} from "./injectAdapters";
import { raceInjectProvidersNear } from "./race";

const RPC_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/";
const GET_METADATA_LEGACY =
	"https://maps.googleapis.com/maps/api/js/GeoPhotoService.GetMetadata";
const SV_TILE_URL = "https://streetviewpixels-pa.googleapis.com/v1/tile";
const SVTILE_BASE = schemeBase("svtile");
const JSON_PROTO = "application/json+protobuf; charset=UTF-8";

let installed = false;
let installCount = 0;
let unpatchFetch: (() => void) | null = null;
let unpatchXhr: (() => void) | null = null;
let unpatchImage: (() => void) | null = null;
let unpatchLegacy: (() => void) | null = null;

type FetchFn = typeof fetch;

function rpcMethod(url: string): string | null {
	if (!url.startsWith(RPC_URL)) return null;
	const method = url.slice(RPC_URL.length).split("?")[0] ?? "";
	return method || null;
}

function bodyAsJsonText(body: Document | XMLHttpRequestBodyInit | null | undefined): string | null {
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	if (ArrayBuffer.isView(body)) {
		const view = body as ArrayBufferView;
		return new TextDecoder().decode(
			new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
		);
	}
	return null;
}

function jsonProtoResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": JSON_PROTO },
	});
}

async function handleGetMetadata(body: unknown): Promise<Response | null> {
	ensureBuiltinInjectAdapters();
	for (const adapter of getInjectAdapters()) {
		const ids = adapter.idsFromGetMetadata(body);
		if (!ids) continue;
		const payload = await adapter.handleGetMetadata(ids);
		return jsonProtoResponse(payload);
	}
	return null;
}

/**
 * Google SIS miss → race enabled inject adapters. First success becomes the
 * pano Google loads; slower siblings are stored for the date picker.
 */
async function handleSingleImageSearchBody(body: unknown): Promise<unknown | null> {
	ensureBuiltinInjectAdapters();
	if (getRaceableInjectAdapters().length === 0) return null;

	const ll = latLngFromSingleImageSearchRequest(body);
	if (!ll) return null;

	const hit = await raceInjectProvidersNear(ll.lat, ll.lng, ll.radius);
	return hit?.sisBody ?? null;
}

async function handleSingleImageSearch(
	body: unknown,
	nativeFetch: FetchFn,
	request: Request,
	init?: RequestInit,
): Promise<Response> {
	const nativeRes = await nativeFetch(request, init);
	let nativeJson: unknown;
	try {
		nativeJson = await nativeRes.clone().json();
	} catch {
		return nativeRes;
	}
	const statusCode = Array.isArray(nativeJson)
		? (nativeJson[0] as unknown[])?.[0]
		: undefined;
	if (statusCode === 0) return nativeRes;

	const altBody = await handleSingleImageSearchBody(body);
	if (!altBody) return nativeRes;
	return jsonProtoResponse(altBody);
}

function installFetchHook(): () => void {
	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const req =
			input instanceof Request
				? input
				: new Request(typeof input === "string" ? input : input.toString(), init);
		const method = rpcMethod(req.url);
		if (!method) return nativeFetch(input, init);

		if (method === "GetMetadata") {
			try {
				const body = await req.clone().json();
				const hijacked = await handleGetMetadata(body);
				if (hijacked) return hijacked;
				return nativeFetch(new Request(req, { body: JSON.stringify(body) }), init);
			} catch {
				return nativeFetch(input, init);
			}
		}

		if (method === "SingleImageSearch") {
			try {
				const body = await req.clone().json();
				return await handleSingleImageSearch(
					body,
					nativeFetch,
					new Request(req, { body: JSON.stringify(body) }),
					init,
				);
			} catch {
				return nativeFetch(input, init);
			}
		}

		return nativeFetch(input, init);
	};
	return () => {
		window.fetch = nativeFetch;
	};
}

function installXhrHook(): () => void {
	const NativeXHR = window.XMLHttpRequest;

	window.XMLHttpRequest = class InjectXhrHook extends NativeXHR {
		#rpc: string | null = null;
		#readyOverride: number | undefined;
		#simulated = false;
		#headers: Record<string, string> = {};
		#nativeSend = NativeXHR.prototype.send;

		override open(
			method: string,
			url: string | URL,
			async = true,
			username?: string | null,
			password?: string | null,
		): void {
			const href = typeof url === "string" ? url : url.toString();
			this.#rpc = rpcMethod(href);
			this.#simulated = false;
			this.#headers = {};
			this.#readyOverride = undefined;
			if (this.#rpc === "GetMetadata" || this.#rpc === "SingleImageSearch") {
				this.send = this.#hookedSend;
			} else {
				this.send = this.#nativeSend;
			}
			super.open(method, url, async, username, password);
		}

		get readyState(): number {
			return this.#readyOverride ?? super.readyState;
		}

		override getResponseHeader(name: string): string | null {
			if (this.#simulated) return this.#headers[name.toLowerCase()] ?? null;
			return super.getResponseHeader(name);
		}

		override getAllResponseHeaders(): string {
			if (this.#simulated) {
				return Object.entries(this.#headers)
					.map(([k, v]) => `${k}: ${v}`)
					.join("\r\n");
			}
			return super.getAllResponseHeaders();
		}

		#setReady(state: number): void {
			this.#readyOverride = state;
			this.dispatchEvent(new Event("readystatechange"));
		}

		#simulate(impl: () => Promise<string>): void {
			this.#simulated = true;
			this.#headers = { "content-type": JSON_PROTO };
			this.#setReady(1);
			const progress = { lengthComputable: false, loaded: 0, total: 0 };
			this.dispatchEvent(new ProgressEvent("loadstart", { ...progress }));
			impl()
				.then((text) => {
					this.#setReady(2);
					Object.defineProperty(this, "status", { configurable: true, get: () => 200 });
					Object.defineProperty(this, "statusText", {
						configurable: true,
						get: () => "OK",
					});
					Object.defineProperty(this, "response", {
						configurable: true,
						get: () => text,
					});
					Object.defineProperty(this, "responseText", {
						configurable: true,
						get: () => text,
					});
					this.#setReady(3);
					progress.lengthComputable = true;
					progress.loaded = text.length;
					progress.total = text.length;
					this.#setReady(4);
					this.dispatchEvent(new ProgressEvent("load", { ...progress }));
				})
				.catch(() => {
					this.#setReady(4);
					this.dispatchEvent(new ProgressEvent("error", { ...progress }));
				})
				.finally(() => {
					this.dispatchEvent(new ProgressEvent("loadend", { ...progress }));
				});
		}

		#hookedSend = (body?: Document | XMLHttpRequestBodyInit | null): void => {
			const text = bodyAsJsonText(body);
			if (text == null) {
				this.#nativeSend.call(this, body);
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				this.#nativeSend.call(this, body);
				return;
			}

			if (this.#rpc === "GetMetadata") {
				ensureBuiltinInjectAdapters();
				const claimed = getInjectAdapters().some(
					(a) => a.idsFromGetMetadata(parsed) != null,
				);
				if (!claimed) {
					this.#nativeSend.call(this, body);
					return;
				}
				this.#simulate(async () => {
					const hijacked = await handleGetMetadata(parsed);
					if (hijacked) return hijacked.text();
					const err: unknown[] = [];
					err[0] = 5;
					err[2] = "Inject panorama not found";
					return jsonProtoResponse([err]).text();
				});
				return;
			}

			if (this.#rpc === "SingleImageSearch") {
				this.#simulate(async () => {
					const nativeRes = await new Promise<string>((resolve, reject) => {
						const xhr = new NativeXHR();
						xhr.open("POST", `${RPC_URL}SingleImageSearch`);
						xhr.setRequestHeader("Content-Type", "application/json+protobuf");
						xhr.setRequestHeader("X-User-Agent", "grpc-web-javascript/0.1");
						xhr.onload = () => resolve(xhr.responseText);
						xhr.onerror = () => reject(new Error("SIS network error"));
						xhr.send(text);
					});
					let nativeJson: unknown;
					try {
						nativeJson = JSON.parse(nativeRes);
					} catch {
						return nativeRes;
					}
					const statusCode = Array.isArray(nativeJson)
						? (nativeJson[0] as unknown[])?.[0]
						: undefined;
					if (statusCode === 0) return nativeRes;
					const altBody = await handleSingleImageSearchBody(parsed);
					if (!altBody) return nativeRes;
					return JSON.stringify(altBody);
				});
				return;
			}

			this.#nativeSend.call(this, body);
		};
	} as unknown as typeof XMLHttpRequest;

	return () => {
		window.XMLHttpRequest = NativeXHR;
	};
}

function installLegacyGetMetadataHook(): () => void {
	const nativeAppend = document.head.appendChild.bind(document.head);
	document.head.appendChild = function appendChildHook<T extends Node>(node: T): T {
		if (
			node instanceof HTMLScriptElement &&
			typeof node.src === "string" &&
			node.src.startsWith(GET_METADATA_LEGACY)
		) {
			void interceptLegacyGetMetadata(node).then((handled) => {
				if (!handled) nativeAppend(node);
			});
			return node;
		}
		return nativeAppend(node);
	} as typeof document.head.appendChild;

	return () => {
		document.head.appendChild = nativeAppend;
	};
}

function decodeOverlayDataForLegacy(payload: unknown): void {
	if (!Array.isArray(payload)) return;
	const results = payload[1];
	if (!Array.isArray(results)) return;
	for (const meta of results) {
		if (!Array.isArray(meta)) continue;
		const locs = meta[5];
		if (!Array.isArray(locs)) continue;
		for (const loc of locs) {
			if (!Array.isArray(loc)) continue;
			const overlays = loc[5];
			if (!Array.isArray(overlays)) continue;
			for (const idx of [1, 3] as const) {
				const overlay = overlays[idx];
				if (!Array.isArray(overlay)) continue;
				const data = overlay[2];
				if (typeof data === "string" && data.length > 0) {
					try {
						overlay[2] = atob(data);
					} catch {
						/* keep original */
					}
				}
			}
		}
	}
}

async function interceptLegacyGetMetadata(node: HTMLScriptElement): Promise<boolean> {
	try {
		ensureBuiltinInjectAdapters();
		const url = new URL(node.src);
		const callbackName = url.searchParams.get("callback");
		const pb = url.searchParams.get("pb");
		if (!callbackName || !pb) return false;

		const cb = (globalThis as Record<string, unknown>)[callbackName];
		if (typeof cb !== "function") return false;

		for (const adapter of getInjectAdapters()) {
			if (!adapter.legacyPbMarker.test(pb)) continue;
			const ids = [...pb.matchAll(adapter.legacyIdPattern)].map((m) => m[1]!);
			if (ids.length === 0) return false;
			const payload = await adapter.handleLegacyGetMetadata(ids);
			if (!payload) return false;
			decodeOverlayDataForLegacy(payload);
			(cb as (data: unknown) => void)(payload);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

function isGooglePanoTileUrl(url: URL, href: string): boolean {
	if (href.startsWith(SV_TILE_URL)) return true;
	if (/^geo[0-3]\.ggpht\.com$/i.test(url.hostname) && /\/cbk\/?$/i.test(url.pathname)) {
		return true;
	}
	if (/^cbks[0-3]\.googleapis\.com$/i.test(url.hostname)) return true;
	if (href.startsWith(SVTILE_BASE)) return true;
	return false;
}

function rewriteTileSrc(value: string): string | Promise<string> | null {
	if (typeof value !== "string") return null;
	let url: URL;
	try {
		url = new URL(value, location.href);
	} catch {
		return null;
	}
	if (!isGooglePanoTileUrl(url, value)) return null;

	const panoid = url.searchParams.get("panoid");
	if (!panoid) return null;
	const x = Number(url.searchParams.get("x"));
	const y = Number(url.searchParams.get("y"));
	const zoom = Number(url.searchParams.get("zoom"));
	if (![x, y, zoom].every(Number.isFinite)) return null;

	ensureBuiltinInjectAdapters();
	for (const adapter of getInjectAdapters()) {
		if (!adapter.isPanoId(panoid)) continue;
		return adapter.rewriteTile(panoid, zoom, x, y);
	}
	return null;
}

function installImageTileHook(): () => void {
	const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
	if (!desc?.get || !desc?.set) {
		const NativeImage = window.Image;
		window.Image = class InjectImageHook extends NativeImage {
			override set src(value: string) {
				const rewritten = rewriteTileSrc(value);
				if (rewritten == null) {
					super.src = value;
					return;
				}
				if (typeof rewritten === "string") {
					super.src = rewritten;
					return;
				}
				(this as unknown as { decode: null }).decode = null;
				void rewritten.then(
					(u) => {
						super.src = u;
					},
					() => {
						this.dispatchEvent(new Event("error"));
					},
				);
			}
			override get src(): string {
				return super.src;
			}
		} as typeof Image;
		return () => {
			window.Image = NativeImage;
		};
	}

	const nativeSet = desc.set;
	const nativeGet = desc.get;
	Object.defineProperty(HTMLImageElement.prototype, "src", {
		configurable: true,
		enumerable: desc.enumerable,
		get() {
			return nativeGet.call(this);
		},
		set(value: string) {
			const rewritten = rewriteTileSrc(value);
			if (rewritten == null) {
				nativeSet.call(this, value);
				return;
			}
			if (typeof rewritten === "string") {
				nativeSet.call(this, rewritten);
				return;
			}
			(this as unknown as { decode: null }).decode = null;
			void rewritten.then(
				(u) => {
					nativeSet.call(this, u);
				},
				() => {
					this.dispatchEvent(new Event("error"));
				},
			);
		},
	});

	return () => {
		Object.defineProperty(HTMLImageElement.prototype, "src", desc);
	};
}

function uninstall(): void {
	unpatchFetch?.();
	unpatchFetch = null;
	unpatchXhr?.();
	unpatchXhr = null;
	unpatchImage?.();
	unpatchImage = null;
	unpatchLegacy?.();
	unpatchLegacy = null;
	installed = false;
}

/** Install the shared Google inject bridge. Ref-counted / idempotent. */
export async function installGoogleInjectBridge(): Promise<() => void> {
	ensureBuiltinInjectAdapters();
	await loadOpenSV();

	if (!installed) {
		unpatchFetch = installFetchHook();
		unpatchXhr = installXhrHook();
		unpatchImage = installImageTileHook();
		unpatchLegacy = installLegacyGetMetadataHook();
		installed = true;
	}
	installCount += 1;

	let released = false;
	return () => {
		if (released) return;
		released = true;
		installCount = Math.max(0, installCount - 1);
		if (installCount === 0) uninstall();
	};
}

export function isGoogleInjectBridgeInstalled(): boolean {
	return installed;
}

/** @deprecated Use installGoogleInjectBridge */
export const installChinaGoogleBridge = installGoogleInjectBridge;
/** @deprecated Use installGoogleInjectBridge */
export const installBaiduGoogleBridge = installGoogleInjectBridge;
/** @deprecated Use installGoogleInjectBridge */
export const installTencentGoogleBridge = installGoogleInjectBridge;
/** @deprecated Use isGoogleInjectBridgeInstalled */
export const isChinaBridgeInstalled = isGoogleInjectBridgeInstalled;
