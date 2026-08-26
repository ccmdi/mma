import { cmd } from "@/lib/commands";
import { google } from "@/lib/sv/opensv";
import { getEnabledPlugins } from "@/plugins/registry";
import { DEFAULTS, PRIVATE_SETTINGS, getSettings, type AppSettings } from "@/store/settings";
import { getMapState } from "@/store/useMapStore";
import { formatBytes } from "@/lib/util/format";
import { appVersion } from "@/lib/version";

export interface Diagnostics {
	appVersion: string;
	buildMode: string;
	userAgent: string;
	webglRenderer: string;
	viewport: string;
	devicePixelRatio: number;
	opensvVersion: string;
	startupMs: number;
	uptimeSecs: number;
	jsHeap: { usedBytes: number; limitBytes: number } | null;
	panoSingleton: boolean;
	db: {
		maps: number;
		locations: number;
		tags: number;
		commits: number;
		sizeBytes: number;
		journalMode: string;
		foreignKeys: boolean;
	};
	/** Enabled plugin ids, with `@version` where the plugin is user-installed. */
	plugins: string[];
	/** Only settings the user has changed. The full set is 80-odd keys of noise. */
	changedSettings: Record<string, unknown>;
	map: MapDiagnostics | null;
}

export interface MapDiagnostics {
	locationCount: number;
	tagCount: number;
	/** Unsaved locations at the time of reporting. */
	dirtyCount: number;
	/** Per-map settings are undefined until set, so presence alone marks them as changed. */
	changedSettings: Record<string, unknown>;
}

function webglRenderer(): string {
	try {
		const canvas = document.createElement("canvas");
		const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
		if (!gl) return "no webgl";
		const ext = gl.getExtension("WEBGL_debug_renderer_info");
		return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
	} catch {
		return "unknown";
	}
}

/** Settings values are unbounded: custom CSS, saved selections carrying polygon geometry, per-map
 *  key bindings. A report needs to know a setting was changed and roughly how big it got, not to
 *  carry its contents -- and GitHub caps an issue body at 65536 characters. */
const MAX_VALUE_CHARS = 400;

function summarize(value: unknown): unknown {
	const json = JSON.stringify(value) ?? "null";
	if (json.length <= MAX_VALUE_CHARS) return value;
	const size = formatBytes(json.length);
	if (Array.isArray(value)) return `<omitted: ${value.length} items, ${size}>`;
	if (typeof value === "string") return `<omitted: ${value.length} chars, ${size}>`;
	if (value && typeof value === "object") {
		return `<omitted: ${Object.keys(value).length} keys, ${size}>`;
	}
	return `<omitted: ${size}>`;
}

/** Keys of `current` whose value differs from `defaults`, with oversized values summarized and
 *  `private` keys reduced to a presence marker -- a report should say the user has an API key
 *  configured, never what it is. */
export function changedFrom<T extends Record<string, unknown>>(
	current: T,
	defaults: T,
	isPrivate: (key: string) => boolean = () => false,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(current)) {
		if (JSON.stringify(v) === JSON.stringify(defaults[k])) continue;
		out[k] = isPrivate(k) ? "<set, redacted>" : summarize(v);
	}
	return out;
}

async function pluginList(): Promise<string[]> {
	const enabled = getEnabledPlugins().map((p) => p.id);
	let versions = new Map<string, string>();
	try {
		versions = new Map((await cmd.listUserPlugins()).map((m) => [m.id, m.version]));
	} catch {
		// Built-in plugins have no manifest on disk; bare ids are still useful.
	}
	return enabled.map((id) => {
		const v = versions.get(id);
		return v ? `${id}@${v}` : id;
	});
}

async function mapDiagnostics(): Promise<MapDiagnostics | null> {
	const state = getMapState();
	if (!state.map) return null;
	let dirtyCount = 0;
	try {
		dirtyCount = (await cmd.storeGetSummary()).dirtyCount;
	} catch {
		// A report about a broken map must still send.
	}
	const settings = state.map.settings ?? {};
	return {
		locationCount: state.locationCount,
		tagCount: Object.keys(state.tags).length,
		dirtyCount,
		changedSettings: Object.fromEntries(
			Object.entries(settings)
				.filter(([, v]) => v !== undefined && v !== null)
				.map(([k, v]) => [k, summarize(v)]),
		),
	};
}

export async function collectDiagnostics(): Promise<Diagnostics> {
	const [db, startupMs, plugins, map] = await Promise.all([
		cmd.storeDbStats(),
		cmd.appReady(),
		pluginList(),
		mapDiagnostics(),
	]);
	const perfMem = (
		performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
	).memory;
	return {
		appVersion: appVersion() ?? "dev",
		buildMode: import.meta.env.MODE,
		userAgent: navigator.userAgent,
		webglRenderer: webglRenderer(),
		viewport: `${window.innerWidth}x${window.innerHeight}`,
		devicePixelRatio: window.devicePixelRatio,
		opensvVersion: google?.maps?.version ?? "not loaded",
		startupMs,
		uptimeSecs: Math.floor(performance.now() / 1000),
		jsHeap: perfMem
			? { usedBytes: perfMem.usedJSHeapSize, limitBytes: perfMem.jsHeapSizeLimit }
			: null,
		panoSingleton: !!google?.maps?.StreetViewPanorama,
		db: {
			maps: db.maps,
			locations: db.locations,
			tags: db.tags,
			commits: db.commits,
			sizeBytes: db.dbSizeBytes,
			journalMode: db.journalMode,
			foreignKeys: db.foreignKeys,
		},
		plugins,
		changedSettings: changedFrom(getSettings(), DEFAULTS, (k) =>
			PRIVATE_SETTINGS.has(k as keyof AppSettings),
		),
		map,
	};
}
