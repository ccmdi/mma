import { mdiApple, mdiEarth } from "@mdi/js";
import type { AltProviderSettings, MapSettings, ProvidersSettings } from "@/bindings.gen";
import {
	getCurrentMap,
	subscribeStore,
	updateMapMeta,
} from "@/store/useMapStore";
import type { AltSvProviderId, SvProviderCatalogEntry } from "./types";
import { bumpProviderCoverageLayers } from "./coverageLayers";

/** Re-export binding names used across the providers UI. */
export type { AltProviderSettings, ProvidersSettings };

/** Runtime settings with all fields present (bindings mark fields optional via serde default). */
export type ResolvedAltProviderSettings = Required<AltProviderSettings>;

/** Shared defaults for every alternate provider slot. */
export const DEFAULT_ALT_PROVIDER_SETTINGS: ResolvedAltProviderSettings = {
	enabled: false,
	preferred: false,
	fallbackToGoogle: false,
	showLines: true,
	showPoints: true,
	lineOpacity: 0.85,
	pointsOpacity: 1,
	lineColor: "rgba(26, 159, 176, 1)",
	trekkerLineColor: "rgba(173, 140, 191, 1)",
	pointFill: "rgba(26, 159, 176, 0.25)",
	pointStroke: "rgba(26, 159, 176, 0.9)",
	trekkerPointFill: "rgba(173, 140, 191, 0.25)",
	trekkerPointStroke: "rgba(173, 140, 191, 0.9)",
	lineWidthScale: 1,
	pointSizeScale: 1,
};

const ALT_PROVIDER_IDS: readonly AltSvProviderId[] = [
	"apple",
	"baidu",
	"tencent",
	"yandex",
];

/** Providers shown in the settings panel (Google is excluded). */
export const PROVIDER_CATALOG: SvProviderCatalogEntry[] = [
	{
		id: "apple",
		label: "Apple Look Around",
		icon: mdiApple,
		priority: 10,
		available: true,
	},
	{
		id: "baidu",
		label: "Baidu",
		icon: mdiEarth,
		priority: 5,
		available: true,
	},
	{
		id: "tencent",
		label: "Tencent",
		icon: mdiEarth,
		/** Same as Baidu — blank clicks race both; priority does not pick a winner. */
		priority: 5,
		available: true,
	},
	{
		id: "yandex",
		label: "Yandex",
		icon: mdiEarth,
		priority: 5,
		available: false,
	},
];

function normalizeProvider(
	raw: AltProviderSettings | null | undefined,
): ResolvedAltProviderSettings {
	// Shared default object when unset — stable identity for useSyncExternalStore.
	if (!raw) return DEFAULT_ALT_PROVIDER_SETTINGS;
	return { ...DEFAULT_ALT_PROVIDER_SETTINGS, ...raw };
}

function emptyProviders(): ProvidersSettings {
	return {
		apple: null,
		baidu: null,
		tencent: null,
		yandex: null,
	};
}

function readSlot(
	bag: ProvidersSettings,
	id: AltSvProviderId,
): AltProviderSettings | null | undefined {
	return bag[id];
}

function parseFromMapSettings(settings: MapSettings | undefined): ProvidersSettings {
	const raw = settings?.providers;
	if (!raw) return emptyProviders();
	const out = emptyProviders();
	for (const id of ALT_PROVIDER_IDS) {
		const slot = raw[id];
		out[id] = slot ? normalizeProvider(slot) : null;
	}
	return out;
}

/** In-memory mirror of the open map's provider settings (defaults when no map). */
let settings: ProvidersSettings = emptyProviders();
/**
 * Cached resolved settings per provider — stable identity until that slot changes.
 * Required by useSyncExternalStore (getSnapshot must return Object.is-equal values).
 */
const snapshots: Record<AltSvProviderId, ResolvedAltProviderSettings> = {
	apple: DEFAULT_ALT_PROVIDER_SETTINGS,
	baidu: DEFAULT_ALT_PROVIDER_SETTINGS,
	tencent: DEFAULT_ALT_PROVIDER_SETTINGS,
	yandex: DEFAULT_ALT_PROVIDER_SETTINGS,
};
let boundMapId: string | null = null;
const listeners = new Set<() => void>();

function refreshSnapshots() {
	for (const id of ALT_PROVIDER_IDS) {
		const slot = readSlot(settings, id);
		snapshots[id] = slot ? normalizeProvider(slot) : DEFAULT_ALT_PROVIDER_SETTINGS;
	}
}

function emit() {
	for (const l of listeners) l();
}

function syncFromOpenMap() {
	const map = getCurrentMap();
	const mapId = map?.meta.id ?? null;
	if (mapId !== boundMapId) {
		boundMapId = mapId;
		settings = map ? parseFromMapSettings(map.meta.settings) : emptyProviders();
		refreshSnapshots();
		emit();
		bumpProviderCoverageLayers();
		return;
	}
	if (!map) return;
	const next = parseFromMapSettings(map.meta.settings);
	if (JSON.stringify(next) !== JSON.stringify(settings)) {
		settings = next;
		refreshSnapshots();
		emit();
		bumpProviderCoverageLayers();
	}
}

async function persistToMap(next: ProvidersSettings): Promise<void> {
	const map = getCurrentMap();
	if (!map) return;
	await updateMapMeta({
		settings: {
			...map.meta.settings,
			providers: next,
		},
	});
}

// Keep mirror aligned when the map store changes (open / meta patch).
subscribeStore(() => {
	syncFromOpenMap();
});
syncFromOpenMap();

export function getProvidersSettings(): ProvidersSettings {
	return settings;
}

export function getProvidersSettingsSnapshot(): ProvidersSettings {
	return settings;
}

/** Stable resolved settings for one provider (useSyncExternalStore-safe). */
export function getProviderSettings(id: AltSvProviderId): ResolvedAltProviderSettings {
	return snapshots[id];
}

export function isProviderEnabled(id: AltSvProviderId): boolean {
	return snapshots[id].enabled;
}

export function updateProviderSettings(
	id: AltSvProviderId,
	patch: Partial<ResolvedAltProviderSettings>,
): void {
	const next = { ...snapshots[id], ...patch };
	// Enabling a provider does not auto-prefer it — user opts in explicitly.
	if (patch.enabled === true && patch.preferred === undefined) {
		next.preferred = false;
	}
	let bag: ProvidersSettings = { ...settings, [id]: next };

	// Prefer is exclusive across alternate providers.
	if (patch.preferred === true) {
		for (const other of ALT_PROVIDER_IDS) {
			if (other === id) continue;
			const slot = bag[other] ? normalizeProvider(bag[other]) : snapshots[other];
			if (!slot.preferred) continue;
			bag = { ...bag, [other]: { ...slot, preferred: false } };
		}
	}

	settings = bag;
	refreshSnapshots();
	emit();
	bumpProviderCoverageLayers();
	void persistToMap(settings);
	if (patch.enabled === true) rememberLastEnabledProvider(id);
}

const LAST_ENABLED_KEY = "mma.providers.lastEnabled";

export function rememberLastEnabledProvider(id: AltSvProviderId): void {
	try {
		localStorage.setItem(LAST_ENABLED_KEY, id);
	} catch {
		/* ignore */
	}
	emit();
}

export function getLastEnabledProviderId(): AltSvProviderId | null {
	try {
		const raw = localStorage.getItem(LAST_ENABLED_KEY);
		if (raw && (ALT_PROVIDER_IDS as readonly string[]).includes(raw)) {
			const id = raw as AltSvProviderId;
			if (PROVIDER_CATALOG.some((p) => p.id === id && p.available)) return id;
		}
	} catch {
		/* ignore */
	}
	const enabled = getEnabledAltProviders();
	return enabled[0]?.id ?? null;
}

/** Header icon / sidebar default tab: last enabled provider if still on, else first enabled. */
export function getHeaderProviderId(): AltSvProviderId | null {
	const last = getLastEnabledProviderId();
	if (last && snapshots[last].enabled) return last;
	const enabled = getEnabledAltProviders();
	return enabled[0]?.id ?? null;
}

/** Reset style knobs; keep enabled / preferred. */
export function resetProviderSettings(id: AltSvProviderId): void {
	const current = snapshots[id];
	settings = {
		...settings,
		[id]: {
			...DEFAULT_ALT_PROVIDER_SETTINGS,
			enabled: current.enabled,
			preferred: current.preferred,
		},
	};
	refreshSnapshots();
	emit();
	bumpProviderCoverageLayers();
	void persistToMap(settings);
}

export function subscribeProvidersSettings(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/**
 * Enabled alternate providers sorted by preferred + catalog priority.
 * Baidu/Tencent blank clicks ignore relative priority and race in parallel
 * (see createChinaLocationAtLatLng); sorting still orders China vs Apple/etc.
 */
export function getEnabledAltProviders(): SvProviderCatalogEntry[] {
	return PROVIDER_CATALOG.filter((p) => {
		if (!p.available) return false;
		return snapshots[p.id].enabled;
	}).sort((a, b) => {
		const prefA = snapshots[a.id].preferred ? 1 : 0;
		const prefB = snapshots[b.id].preferred ? 1 : 0;
		if (prefA !== prefB) return prefB - prefA;
		return b.priority - a.priority;
	});
}

/** Header icon provider (last enabled while still on). */
export function getSoleEnabledProviderId(): AltSvProviderId | null {
	return getHeaderProviderId();
}

export function getProviderLabel(id: AltSvProviderId): string {
	return PROVIDER_CATALOG.find((p) => p.id === id)?.label ?? id;
}

/** Enable a provider when opening a pin whose provider field matches. */
export function ensureProviderEnabled(provider: string): void {
	if (!(ALT_PROVIDER_IDS as readonly string[]).includes(provider)) return;
	const id = provider as AltSvProviderId;
	if (!snapshots[id].enabled) {
		updateProviderSettings(id, { enabled: true });
	}
}
