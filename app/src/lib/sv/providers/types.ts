/**
 * Multi-provider Street View model.
 * Google remains the default host; alternate providers register here for settings,
 * coverage overlays, click priority, and location.provider routing.
 */

import type { Location } from "@/bindings.gen";
import { normalizeStoragePanoId } from "./panoIdStorage";

/** Known panorama imagery providers. Google is always available and not configured here. */
export type SvProvider =
	| "google"
	| "apple"
	| "baidu"
	| "tencent"
	| "yandex"

/** Alternate (non-Google) providers that appear in the providers settings panel. */
export type AltSvProviderId = Exclude<SvProvider, "google">;

/** Alias of the MapSettings provider settings shape from bindings. */
export type { AltProviderSettings as AltSvProviderSettings } from "@/bindings.gen";

/** Catalog entry for the providers sidebar (UI + registration metadata). */
export interface SvProviderCatalogEntry {
	id: AltSvProviderId;
	label: string;
	/** MDI path data for the header toggle when this provider is the sole enabled one. */
	icon: string;
	/** Sort key for click priority (higher first). */
	priority: number;
	/** Coming-soon providers are shown but not interactive. */
	available: boolean;
}

/**
 * Location.extra fields shared across providers (Google-semantic where possible).
 * Provider identity lives on `location.provider` / `location.panoId`.
 */
export interface LocationSvExtra {
	altitude?: number;
	imageDate?: string;
	datetime?: number;
	timezone?: string;
	cameraType?: string;
	panoType?: number;
	drivingDirection?: number;
	countryCode?: string;
	[key: string]: unknown;
}

const KNOWN_PROVIDERS: readonly SvProvider[] = [
	"google",
	"apple",
	"baidu",
	"tencent",
	"yandex",
];

function parseProvider(raw: unknown): SvProvider | null {
	if (typeof raw !== "string") return null;
	return (KNOWN_PROVIDERS as readonly string[]).includes(raw) ? (raw as SvProvider) : null;
}

/** Resolve imagery provider from top-level `location.provider`. */
export function getLocationProvider(
	loc: Pick<Location, "provider"> | null | undefined,
): SvProvider {
	if (!loc) return "google";
	const top = parseProvider(loc.provider);
	if (top) return top;
	return "google";
}

export function isAppleLocation(loc: Pick<Location, "provider"> | null | undefined): boolean {
	return getLocationProvider(loc) === "apple";
}

/** Spawn / open pano id — top-level, always storage form (no provider prefix). */
export function getLocationPanoId(loc: Location | null | undefined): string | null {
	if (!loc) return null;
	return normalizeStoragePanoId(loc.panoId);
}

export function isGoogleProvider(provider: SvProvider): boolean {
	return provider === "google";
}

/** Wire `source` values used in GeoGuessr-style JSON for non-Google providers. */
export type SvWireSource =
	| "apple_pano"
	| "baidu_pano"
	| "qq_pano"
	| "yandex_pano";

const PROVIDER_TO_WIRE: Record<AltSvProviderId, SvWireSource> = {
	apple: "apple_pano",
	baidu: "baidu_pano",
	tencent: "qq_pano",
	yandex: "yandex_pano",
};

const WIRE_TO_PROVIDER: Record<string, AltSvProviderId> = {
	apple_pano: "apple",
	baidu_pano: "baidu",
	qq_pano: "tencent",
	yandex_pano: "yandex",
};

/** Internal provider → JSON export `source` (null for Google). */
export function providerToWireSource(provider: SvProvider): SvWireSource | null {
	if (provider === "google") return null;
	return PROVIDER_TO_WIRE[provider] ?? null;
}

/**
 * Map a JSON `source` or legacy `provider` wire value to an internal provider id.
 * Accepts both `apple` / `baidu` and `apple_pano` / `baidu_pano` forms.
 */
export function wireValueToProvider(raw: string | null | undefined): SvProvider | null {
	if (!raw) return null;
	const fromWire = WIRE_TO_PROVIDER[raw];
	if (fromWire) return fromWire;
	return parseProvider(raw);
}
