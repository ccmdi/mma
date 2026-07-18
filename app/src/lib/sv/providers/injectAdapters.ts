/**
 * Registry of Google-opensv inject adapters (BAIDU: / TENCENT: / future prefixes).
 *
 * One shared bridge installs fetch/XHR/Image hooks once; adapters claim requests
 * by pano-id prefix. New providers (any region) register here the same way.
 */
import type { Location } from "@/bindings.gen";
import {
	fetchBaiduMeta,
	resolveBaiduNear,
	type BaiduPanoMeta,
} from "@/lib/sv/baidu/api";
import { buildBaiduExtra } from "@/lib/sv/baidu/panoExtra";
import { supportsBaiduAt } from "@/lib/sv/baidu/chinaPolygon";
import { isBaiduPanoId, stripBaidu, prefixBaidu } from "@/lib/sv/baidu/prefix";
import {
	baiduIdsFromGetMetadataRequest,
	buildGetMetadataResponse as buildBaiduGetMetadataResponse,
	buildSingleImageSearchOk as buildBaiduSingleImageSearchOk,
} from "@/lib/sv/baidu/officialMeta";
import {
	baiduTileUrlAtZoom,
	buildExpandedZoom0 as buildBaiduExpandedZoom0,
	rememberBaiduMeta,
} from "@/lib/sv/baidu/service";
import { baiduDateToUnix } from "@/lib/sv/baidu/panoExtra";
import {
	fetchTencentMeta,
	resolveTencentNear,
	type TencentPanoMeta,
} from "@/lib/sv/tencent/api";
import { buildTencentExtra } from "@/lib/sv/tencent/panoExtra";
import { isTencentPanoId, stripTencent, prefixTencent } from "@/lib/sv/tencent/prefix";
import {
	tencentIdsFromGetMetadataRequest,
	buildGetMetadataResponse as buildTencentGetMetadataResponse,
	buildSingleImageSearchOk as buildTencentSingleImageSearchOk,
} from "@/lib/sv/tencent/officialMeta";
import {
	buildExpandedZoom0 as buildTencentExpandedZoom0,
	rememberTencentMeta,
	tencentTileUrlAtGoogleZoom,
} from "@/lib/sv/tencent/service";
import { createLocation, LocationFlag } from "@/types";
import type { InjectAlternateHit } from "./alternates";
import { isProviderEnabled } from "./settings";
import type { AltSvProviderId } from "./types";

/** Result of a nearby search used by map-click race and SIS fallback. */
export interface InjectRaceHit {
	provider: AltSvProviderId;
	lat: number;
	lng: number;
	sisBody: unknown;
	toLocation(): Location;
	toAlternate(): InjectAlternateHit;
}

export interface InjectAdapter {
	id: AltSvProviderId;
	/** Match GetMetadata request bodies that belong to this provider. */
	idsFromGetMetadata(body: unknown): string[] | null;
	/** Legacy JSONP pb substring, e.g. `BAIDU:` / `TENCENT:`. */
	legacyPbMarker: RegExp;
	legacyIdPattern: RegExp;
	isPanoId(id: string): boolean;
	/** Hijack GetMetadata for the given prefixed ids → json+protobuf body. */
	handleGetMetadata(ids: string[]): Promise<unknown>;
	/** Handle legacy JSONP GetMetadata; returns payload or null. */
	handleLegacyGetMetadata(ids: string[]): Promise<unknown | null>;
	/** Rewrite a Google tile URL for a prefixed panoid. */
	rewriteTile(
		panoId: string,
		zoom: number,
		x: number,
		y: number,
	): string | Promise<string> | null;
	/**
	 * Participate in blank-click / SIS races when enabled.
	 * Omit for providers that use a separate PanoProvider (e.g. Apple).
	 */
	resolveNear?(lat: number, lng: number, radiusM?: number): Promise<InjectRaceHit | null>;
	/** Geographic gate for SIS fallback (optional). */
	supportsAt?(lng: number, lat: number): boolean;
}

const adapters = new Map<AltSvProviderId, InjectAdapter>();

export function registerInjectAdapter(adapter: InjectAdapter): void {
	adapters.set(adapter.id, adapter);
}

export function getInjectAdapter(id: AltSvProviderId): InjectAdapter | undefined {
	return adapters.get(id);
}

export function getInjectAdapters(): InjectAdapter[] {
	return [...adapters.values()];
}

/** Enabled adapters that can resolve a nearby pano for map click / SIS. */
export function getRaceableInjectAdapters(): InjectAdapter[] {
	return getInjectAdapters().filter(
		(a) => a.resolveNear != null && isProviderEnabled(a.id),
	);
}

export function isInjectProviderId(id: string): id is AltSvProviderId {
	ensureBuiltinInjectAdapters();
	return adapters.has(id as AltSvProviderId);
}

/** @deprecated Use isInjectProviderId */
export const isChinaProviderId = isInjectProviderId;

const baiduAdapter: InjectAdapter = {
	id: "baidu",
	idsFromGetMetadata: baiduIdsFromGetMetadataRequest,
	legacyPbMarker: /!2sBAIDU:/,
	legacyIdPattern: /!2s(BAIDU:[A-Za-z0-9_-]+)/g,
	isPanoId: isBaiduPanoId,
	supportsAt: supportsBaiduAt,
	async handleGetMetadata(ids) {
		const metas = await Promise.all(ids.map((id) => fetchBaiduMeta(id)));
		const ok = metas.filter((m): m is NonNullable<typeof m> => m != null);
		if (ok.length !== ids.length) {
			const err: unknown[] = [];
			err[0] = 5;
			err[2] = "Baidu panorama not found";
			return [err];
		}
		for (const m of ok) rememberBaiduMeta(m);
		for (const m of ok) void buildBaiduExpandedZoom0(m.id).catch(() => undefined);
		return buildBaiduGetMetadataResponse(ok);
	},
	async handleLegacyGetMetadata(ids) {
		const metas = await Promise.all(ids.map((id) => fetchBaiduMeta(id)));
		const ok = metas.filter((m): m is NonNullable<typeof m> => m != null);
		if (ok.length !== ids.length) return null;
		for (const m of ok) rememberBaiduMeta(m);
		return buildBaiduGetMetadataResponse(ok);
	},
	rewriteTile(panoId, zoom, x, y) {
		const sid = stripBaidu(panoId);
		if (zoom === 0) return buildBaiduExpandedZoom0(sid);
		return baiduTileUrlAtZoom(sid, zoom, x, y);
	},
	async resolveNear(lat, lng, radiusM) {
		const meta = await resolveBaiduNear(lat, lng, radiusM);
		if (!meta) return null;
		rememberBaiduMeta(meta);
		void buildBaiduExpandedZoom0(meta.id).catch(() => undefined);
		return baiduRaceHit(meta);
	},
};

function baiduRaceHit(meta: BaiduPanoMeta): InjectRaceHit {
	return {
		provider: "baidu",
		lat: meta.lat,
		lng: meta.lng,
		sisBody: buildBaiduSingleImageSearchOk(meta),
		toLocation: () =>
			createLocation({
				lat: meta.lat,
				lng: meta.lng,
				heading: meta.heading,
				pitch: meta.pitch,
				panoId: meta.id,
				provider: "baidu",
				extra: buildBaiduExtra(meta),
			}),
		toAlternate: () => {
			const unix = baiduDateToUnix(meta.date);
			return {
				provider: "baidu",
				pano: prefixBaidu(meta.id),
				lat: meta.lat,
				lng: meta.lng,
				timestamp: unix != null ? unix * 1000 : Date.now(),
				cameraType: "baidu",
			};
		},
	};
}

const tencentAdapter: InjectAdapter = {
	id: "tencent",
	idsFromGetMetadata: tencentIdsFromGetMetadataRequest,
	legacyPbMarker: /!2sTENCENT:/,
	legacyIdPattern: /!2s(TENCENT:[A-Za-z0-9_-]+)/g,
	isPanoId: isTencentPanoId,
	supportsAt: supportsBaiduAt,
	async handleGetMetadata(ids) {
		const metas = await Promise.all(ids.map((id) => fetchTencentMeta(id)));
		const ok = metas.filter((m): m is NonNullable<typeof m> => m != null);
		if (ok.length !== ids.length) {
			const err: unknown[] = [];
			err[0] = 5;
			err[2] = "Tencent panorama not found";
			return [err];
		}
		for (const m of ok) rememberTencentMeta(m);
		for (const m of ok) void buildTencentExpandedZoom0(m.id).catch(() => undefined);
		return buildTencentGetMetadataResponse(ok);
	},
	async handleLegacyGetMetadata(ids) {
		const metas = await Promise.all(ids.map((id) => fetchTencentMeta(id)));
		const ok = metas.filter((m): m is NonNullable<typeof m> => m != null);
		if (ok.length !== ids.length) return null;
		for (const m of ok) rememberTencentMeta(m);
		return buildTencentGetMetadataResponse(ok);
	},
	rewriteTile(panoId, zoom, x, y) {
		return tencentTileUrlAtGoogleZoom(stripTencent(panoId), zoom, x, y);
	},
	async resolveNear(lat, lng, radiusM) {
		const meta = await resolveTencentNear(lat, lng, radiusM);
		if (!meta) return null;
		rememberTencentMeta(meta);
		void buildTencentExpandedZoom0(meta.id).catch(() => undefined);
		return tencentRaceHit(meta);
	},
};

function tencentRaceHit(meta: TencentPanoMeta): InjectRaceHit {
	return {
		provider: "tencent",
		lat: meta.lat,
		lng: meta.lng,
		sisBody: buildTencentSingleImageSearchOk(meta),
		toLocation: () =>
			createLocation({
				lat: meta.lat,
				lng: meta.lng,
				heading: meta.heading,
				pitch: 0,
				panoId: meta.id,
				provider: "tencent",
				flags: LocationFlag.LoadAsPanoId,
				extra: buildTencentExtra(meta),
			}),
		toAlternate: () => ({
			provider: "tencent",
			pano: prefixTencent(meta.id),
			lat: meta.lat,
			lng: meta.lng,
			timestamp: meta.captureDate.getTime(),
			cameraType: "tencent",
		}),
	};
}

/** Built-in inject adapters. Call once before installing the bridge. */
export function ensureBuiltinInjectAdapters(): void {
	if (!adapters.has("baidu")) registerInjectAdapter(baiduAdapter);
	if (!adapters.has("tencent")) registerInjectAdapter(tencentAdapter);
}
