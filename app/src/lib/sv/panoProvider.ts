import type { Location } from "@/bindings.gen";
import { createSyncStore } from "@/lib/util/syncStore";
import { trackDisposable } from "@/plugins/scope";

/** A capture at (nearly) the same location with a distinct timestamp — powers the
 *  date picker for providers that expose per-visit historical imagery. */
export interface PanoDateEntry {
	pano: string;
	/** Capture time, ms since epoch. */
	timestamp: number;
	/** Optional per-capture camera label key (provider-defined). */
	cameraType?: string;
}

/** Provider-owned camera badge — rendered by the app without knowing the vendor. */
export interface PanoCameraBadge {
	id: string;
	label: string;
	/** Optional CSS class(es) on the badge element (e.g. "badge--apple"). */
	className?: string;
}

/**
 * Alternate panorama viewport session. `panorama` duck-types the Google
 * StreetViewPanorama surface used by PanoControls and LocationPreview Save.
 */
export interface PanoProviderSession {
	panorama: google.maps.StreetViewPanorama;
	destroy(): void;
	/** Alternate-date captures near the current pano, if the provider supports them. */
	getAlternateDates?(): PanoDateEntry[];
	/** Fires whenever `getAlternateDates()` would return a new list (e.g. after moving). */
	subscribeAlternateDates?(cb: () => void): () => void;
	/** Current pano elevation in metres, if known. */
	getAltitude?(): number | null;
	/**
	 * Root DOM node for this provider's viewport. Reparentable so fullscreen-map
	 * mini preview can own the same canvas as LocationPreview.
	 */
	viewport?: HTMLElement;
	/** Recompute layout after the viewport is resized or reparented (e.g. PSV autoSize). */
	resize?(): void;
}

/**
 * Alternate panorama viewport provider (non-Google Street View).
 * Plugins / in-app providers register one; routing is via `location.provider`.
 */
export interface PanoProvider {
	id: string;
	/** Higher priority wins when multiple providers canHandle the same location. */
	priority?: number;
	canHandle(location: Location): boolean;
	/**
	 * Own the location-preview embed host for this location (Google SV is not mounted).
	 * Resolve once the viewport is ready for embed-controls.
	 */
	open(host: HTMLElement, location: Location): Promise<PanoProviderSession>;

	/**
	 * Default / spawn pano id for this location (date-picker Default, return-to-spawn).
	 * Prefer top-level `location.panoId`.
	 */
	getSpawnPanoId?(location: Location): string | null;

	/**
	 * Extra fields to merge when saving the currently viewed pano id.
	 * Provider identity (`provider` / `panoId`) is written on the location itself by the save path.
	 */
	buildSaveExtra?(location: Location, panoId: string): Record<string, unknown>;

	/**
	 * Date-picker display granularity. `"day"` uses day-level formatting;
	 * omit / `"month"` keeps Google-style month labels.
	 */
	dateGranularity?: "month" | "day";

	/**
	 * When true, skip Google exact-date RPC and use capture timestamps from
	 * alternate-date entries / location.extra.datetime.
	 */
	ownsExactDate?: boolean;

	/**
	 * Resolve a camera badge for the date picker. Return null to fall through
	 * to Google SV metadata (or "unofficial" for non-official Google ids).
	 */
	resolveCameraBadge?(
		panoId: string,
		location: Location,
		entryCameraType?: string,
	): PanoCameraBadge | null;
}

const providers = new Map<string, PanoProvider>();
const store = createSyncStore();

/** Active alt-provider viewport (Look Around PSV, etc.) for mini-preview reparenting. */
let activeViewport: HTMLElement | null = null;
let activeViewportResize: (() => void) | null = null;
const viewportStore = createSyncStore();

export function setActivePanoViewport(
	viewport: HTMLElement | null,
	resize?: (() => void) | null,
): void {
	if (activeViewport === viewport && activeViewportResize === (resize ?? null)) return;
	activeViewport = viewport;
	activeViewportResize = viewport ? (resize ?? null) : null;
	viewportStore.notify();
}

export function getActivePanoViewport(): HTMLElement | null {
	return activeViewport;
}

export function resizeActivePanoViewport(): void {
	activeViewportResize?.();
}

export function subscribeActivePanoViewport(cb: () => void): () => void {
	return viewportStore.subscribe(cb);
}

export function getActivePanoViewportSnapshot(): number {
	return viewportStore.getSnapshot();
}

export function registerPanoProvider(provider: PanoProvider): () => void {
	providers.set(provider.id, provider);
	store.notify();
	const dispose = () => {
		if (providers.get(provider.id) === provider) {
			providers.delete(provider.id);
			store.notify();
		}
	};
	trackDisposable(dispose);
	return dispose;
}

export function getPanoProviders(): PanoProvider[] {
	return [...providers.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function findPanoProvider(location: Location): PanoProvider | null {
	for (const p of getPanoProviders()) {
		if (p.canHandle(location)) return p;
	}
	return null;
}

export function subscribePanoProviders(cb: () => void): () => void {
	return store.subscribe(cb);
}

export function getPanoProvidersSnapshot(): number {
	return store.getSnapshot();
}
