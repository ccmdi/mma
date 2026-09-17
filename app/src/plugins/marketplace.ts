import { cmpVersion } from "@/lib/util/util";
import { cmd } from "@/lib/commands";
import type { PluginManifest } from "@/bindings.gen";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import { t } from "@/lib/i18n";

/** True when `appVersion` meets the plugin's minimum version requirement. */
export function isPluginCompatible(
	minAppVersion: string | null | undefined,
	appVersion: string,
): boolean {
	return !minAppVersion || cmpVersion(appVersion, minAppVersion) >= 0;
}

/** True when a newer version is published and the installed version is known. */
export function isPluginUpdatable(
	installedVersion: string | undefined,
	latestVersion: string | undefined,
): boolean {
	return !!installedVersion && !!latestVersion && installedVersion !== latestVersion;
}

/** True when either the plugin or its sidecar has a newer published version. */
export function needsUpdate(
	installedVersion: string | undefined,
	latestVersion: string | undefined,
	installedSidecarVersion: string | null | undefined,
	latestSidecarVersion: string | undefined,
): boolean {
	if (isPluginUpdatable(installedVersion, latestVersion)) return true;
	return !!latestSidecarVersion && installedSidecarVersion !== latestSidecarVersion;
}

/** The build of a plugin to install. `ref` is the commit, null for the latest. */
export interface ResolvedBuild {
	version: string;
	ref: string | null;
	minAppVersion: string | null;
}

/** The newest build of a plugin this app version can run. Falls back through older
 *  pinned builds when the latest is incompatible. Null when none fit. */
export function resolveBuild(entry: PluginManifest, appVersion: string): ResolvedBuild | null {
	if (isPluginCompatible(entry.minAppVersion, appVersion)) {
		return { version: entry.version, ref: null, minAppVersion: entry.minAppVersion ?? null };
	}
	for (const b of entry.builds ?? []) {
		if (isPluginCompatible(b.minAppVersion, appVersion)) {
			return { version: b.version, ref: b.ref, minAppVersion: b.minAppVersion ?? null };
		}
	}
	return null;
}

/** True when the installed plugin should be refreshed to `target`. */
export function needsBuildUpdate(
	installedVersion: string | undefined,
	target: ResolvedBuild,
	installedSidecarVersion: string | null | undefined,
	latestSidecarVersion: string | undefined,
): boolean {
	if (target.ref) return isPluginUpdatable(installedVersion, target.version);
	return needsUpdate(
		installedVersion,
		target.version,
		installedSidecarVersion,
		latestSidecarVersion,
	);
}

const REGISTRY_URL = "https://raw.githubusercontent.com/ccmdi/mma/master/plugins/registry.json";

let registryPromise: Promise<PluginManifest[]> | null = null;

/** Fetch the marketplace plugin registry. Later calls return the first result until restart. */
export function fetchPluginRegistry(): Promise<PluginManifest[]> {
	if (!registryPromise) {
		registryPromise = fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) }).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.json();
		});
		registryPromise.catch(() => {
			registryPromise = null;
		});
	}
	return registryPromise;
}

/** Auto-update a plugin to the newest compatible build before loading it. Falls back
 *  to what is on disk on failure. */
export async function autoUpdatePlugin(
	m: PluginManifest,
	latest: PluginManifest | undefined,
	appVersion: string,
): Promise<PluginManifest> {
	if (!latest) return m;
	const target = resolveBuild(latest, appVersion);
	if (!target) return m;
	const sidecarVersion = latest.sidecar
		? await cmd.sidecarInstalledVersion(m.id).catch(() => null)
		: null;
	if (!needsBuildUpdate(m.version, target, sidecarVersion, latest.sidecar?.version)) return m;
	try {
		const fresh = await cmd.installPlugin(m.id, target.ref);
		if (fresh.sidecar) {
			await cmd.sidecarInstall(fresh.id, fresh.sidecar.name, fresh.sidecar.version);
		}
		toast(t("{name} updated to v{version}", { name: fresh.name, version: fresh.version }));
		return fresh;
	} catch (e) {
		log.warn(`[plugin] auto-update failed for "${m.id}":`, e);
		return m;
	}
}
