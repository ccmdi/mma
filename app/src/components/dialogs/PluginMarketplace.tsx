import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import {
	getPlugin,
	getPlugins,
	getPluginSetting,
	setPluginSetting,
	isPluginEnabled,
	setPluginEnabled,
	activatePlugin,
	deactivatePlugin,
	unregisterPlugin,
	needsUpdate,
} from "@/plugins/registry";
import type { Plugin, PluginManifest, PluginSidecarRef } from "@/plugins/registry";
import { loadAndActivatePlugin, loadUserPlugin } from "@/plugins/index";
import { cmd } from "@/lib/commands";
import { listen } from "@tauri-apps/api/event";
import { log } from "@/lib/util/log";

const REGISTRY_URL = "https://raw.githubusercontent.com/ccmdi/mma/master/plugins/registry.json";

interface RegistryEntry {
	id: string;
	name: string;
	description: string;
	icon: string;
	version: string;
	main: string;
	comingSoon?: boolean;
	sidecar?: PluginSidecarRef | null;
}

// Download a plugin's sidecar (if declared), reporting progress via onProgress. Shared by
// install + update so both paths fetch the binary the same way.
async function installSidecar(
	manifest: PluginManifest,
	onProgress: (pct: number) => void,
): Promise<void> {
	if (!manifest.sidecar) return;
	const unlisten = await listen<{ pluginId: string; downloaded: number; total: number }>(
		"sidecar-install-progress",
		(ev) => {
			if (ev.payload.pluginId === manifest.id && ev.payload.total > 0) {
				onProgress(Math.round((ev.payload.downloaded / ev.payload.total) * 100));
			}
		},
	);
	try {
		await cmd.sidecarInstall(manifest.id, manifest.sidecar.name, manifest.sidecar.version);
	} finally {
		unlisten();
	}
}

type Tab = "core" | "additional";

let registryCache: RegistryEntry[] | null = null;

function PluginSettings({ pluginId }: { pluginId: string }) {
	const plugin = getPlugin(pluginId);
	const [, rerender] = useState(0);
	if (!plugin?.settings?.length) return null;
	return (
		<div className="plugin-card__settings">
			{plugin.settings.map((def) => {
				const value = getPluginSetting(plugin, def.key);
				const update = (v: unknown) => {
					setPluginSetting(plugin.id, def.key, v);
					rerender((n) => n + 1);
				};
				if (def.type === "boolean") {
					return (
						<label key={def.key} className="plugin-card__setting">
							<input
								type="checkbox"
								checked={Boolean(value)}
								onChange={(e) => update(e.target.checked)}
							/>
							<span>{def.label}</span>
						</label>
					);
				}
				return (
					<label key={def.key} className="plugin-card__setting">
						<span>{def.label}</span>
						<input
							type={def.type === "number" ? "number" : "text"}
							className="input"
							value={def.type === "number" ? Number(value ?? 0) : String(value ?? "")}
							onChange={(e) =>
								update(def.type === "number" ? Number(e.target.value) : e.target.value)
							}
						/>
					</label>
				);
			})}
		</div>
	);
}

import { mdiDownload, mdiRefresh, mdiTrashCanOutline } from "@mdi/js";
import { Switch } from "@/components/primitives/Switch";

function CoreCard({ plugin }: { plugin: Plugin }) {
	const [enabled, setEnabled] = useState(() => isPluginEnabled(plugin.id));

	const toggle = () => {
		if (plugin.comingSoon) return;
		const next = !enabled;
		setPluginEnabled(plugin.id, next);
		if (next) activatePlugin(plugin.id);
		else deactivatePlugin(plugin.id);
		setEnabled(next);
	};

	return (
		<div
			className={`plugin-card ${enabled ? "plugin-card--enabled" : ""} ${plugin.comingSoon ? "plugin-card--coming-soon" : ""}`}
		>
			<div className="plugin-card__icon">
				<Icon path={plugin.icon} size={32} />
			</div>
			<div className="plugin-card__info">
				<div className="plugin-card__name">{plugin.name}</div>
				{plugin.description && <div className="plugin-card__desc">{plugin.description}</div>}
			</div>
			{!plugin.comingSoon && (
				<div className="plugin-card__actions">
					<Switch checked={enabled} onChange={toggle} label={enabled ? "Disable" : "Enable"} />
				</div>
			)}
			{enabled && <PluginSettings pluginId={plugin.id} />}
		</div>
	);
}

function AdditionalCard({
	id,
	name,
	description,
	icon,
	installed,
	enabled,
	updatable,
	latestVersion,
	comingSoon,
	installProgress,
	onInstall,
	onEnable,
	onDisable,
	onUninstall,
	onUpdate,
}: {
	id: string;
	name: string;
	description: string;
	icon: string;
	installed: boolean;
	enabled: boolean;
	updatable: boolean;
	latestVersion?: string;
	comingSoon?: boolean;
	installProgress?: number;
	onInstall: (id: string) => void;
	onEnable: (id: string) => void;
	onDisable: (id: string) => void;
	onUninstall: (id: string) => void;
	onUpdate: (id: string) => void;
}) {
	const [busy, setBusy] = useState(false);

	const handleInstall = async () => {
		setBusy(true);
		try {
			await onInstall(id);
		} finally {
			setBusy(false);
		}
	};

	const handleUpdate = async () => {
		setBusy(true);
		try {
			await onUpdate(id);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className={`plugin-card ${enabled ? "plugin-card--enabled" : ""} ${comingSoon ? "plugin-card--coming-soon" : ""}`}
		>
			<div className="plugin-card__icon">{icon ? <Icon path={icon} size={32} /> : null}</div>
			<div className="plugin-card__info">
				<div className="plugin-card__name">{name}</div>
				{description && <div className="plugin-card__desc">{description}</div>}
			</div>
			{!comingSoon && (
				<div className="plugin-card__actions">
					{busy && installProgress !== undefined && (
						<span className="plugin-card__progress">{installProgress}%</span>
					)}
					{!installed ? (
						<button
							className="plugin-card__action-btn plugin-card__action-btn--install"
							onClick={handleInstall}
							disabled={busy}
							title="Install"
							aria-label="Install"
						>
							<Icon path={mdiDownload} size={16} />
						</button>
					) : (
						<Switch
							checked={enabled}
							onChange={(next) => (next ? onEnable(id) : onDisable(id))}
							disabled={busy}
							label={enabled ? "Disable" : "Enable"}
						/>
					)}
					{installed && updatable && (
						<button
							className="plugin-card__action-btn plugin-card__action-btn--update"
							onClick={handleUpdate}
							disabled={busy}
							title={latestVersion ? `Update to v${latestVersion}` : "Update"}
							aria-label="Update"
						>
							<Icon path={mdiRefresh} size={16} />
						</button>
					)}
					{installed && (
						<button
							className="plugin-card__action-btn plugin-card__action-btn--uninstall"
							onClick={() => onUninstall(id)}
							disabled={busy}
							title="Uninstall"
							aria-label="Uninstall"
						>
							<Icon path={mdiTrashCanOutline} size={16} />
						</button>
					)}
				</div>
			)}
			{installed && enabled && <PluginSettings pluginId={id} />}
		</div>
	);
}

interface AdditionalEntry {
	id: string;
	name: string;
	description: string;
	icon: string;
	installed: boolean;
	enabled: boolean;
	updatable: boolean;
	latestVersion?: string;
	comingSoon?: boolean;
}

export function PluginMarketplace({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [tab, setTab] = useState<Tab>("core");
	const [registry, setRegistry] = useState<RegistryEntry[] | null>(registryCache);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [installedManifests, setInstalledManifests] = useState<PluginManifest[]>([]);
	const [sidecarVersions, setSidecarVersions] = useState<Record<string, string | null>>({});
	const [sidecarProgress, setSidecarProgress] = useState<Record<string, number>>({});
	const [, rerender] = useState(0);

	const corePlugins = getPlugins().filter((p) => p.core);

	const refreshInstalled = useCallback(async () => {
		const manifests = await cmd.listUserPlugins();
		setInstalledManifests(manifests);
		const versions: Record<string, string | null> = {};
		await Promise.all(
			manifests
				.filter((m) => m.sidecar)
				.map(async (m) => {
					versions[m.id] = await cmd.sidecarInstalledVersion(m.id);
				}),
		);
		setSidecarVersions(versions);
	}, []);

	useEffect(() => {
		if (open) refreshInstalled();
	}, [open, refreshInstalled]);

	const fetchRegistry = useCallback(() => {
		setFetchError(null);
		fetch(REGISTRY_URL)
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((data: RegistryEntry[]) => {
				registryCache = data;
				setRegistry(data);
			})
			.catch((e) => setFetchError(e.message));
	}, []);

	useEffect(() => {
		if (open && !registry) fetchRegistry();
	}, [open, registry, fetchRegistry]);

	const { installedEntries, registryEntries } = (() => {
		const installedById = new Map(installedManifests.map((m) => [m.id, m]));
		const installed: AdditionalEntry[] = [];
		const fromRegistry: AdditionalEntry[] = [];

		if (registry) {
			for (const r of registry) {
				const manifest = installedById.get(r.id);
				const isInstalled = !!manifest;
				const updatable =
					isInstalled &&
					needsUpdate(manifest.version, r.version, sidecarVersions[r.id], r.sidecar?.version);
				const entry: AdditionalEntry = {
					id: r.id,
					name: r.name,
					description: r.description,
					icon: r.icon,
					installed: isInstalled,
					enabled: isPluginEnabled(r.id),
					updatable,
					latestVersion: r.version,
					comingSoon: r.comingSoon,
				};
				if (isInstalled) installed.push(entry);
				else fromRegistry.push(entry);
			}
		}

		for (const m of installedManifests) {
			if (registry && installed.some((e) => e.id === m.id)) continue;
			installed.push({
				id: m.id,
				name: m.name,
				description: m.description || "",
				icon: m.icon,
				installed: true,
				enabled: isPluginEnabled(m.id),
				updatable: false,
			});
		}

		return { installedEntries: installed, registryEntries: fromRegistry };
	})();

	const setProgress = useCallback((id: string, pct: number | null) => {
		setSidecarProgress((p) => {
			if (pct === null) {
				const next = { ...p };
				delete next[id];
				return next;
			}
			return { ...p, [id]: pct };
		});
	}, []);

	const handleInstall = useCallback(
		async (id: string) => {
			try {
				const manifest = await cmd.installPlugin(id);
				try {
					await installSidecar(manifest, (pct) => setProgress(id, pct));
				} finally {
					setProgress(id, null);
				}
				await loadAndActivatePlugin(manifest);
				setPluginEnabled(id, true);
				await refreshInstalled();
				rerender((n) => n + 1);
			} catch (e) {
				log.error(`[marketplace] install failed for "${id}":`, e);
			}
		},
		[refreshInstalled, setProgress],
	);

	const handleEnable = useCallback((id: string) => {
		setPluginEnabled(id, true);
		activatePlugin(id);
		rerender((n) => n + 1);
	}, []);

	const handleDisable = useCallback((id: string) => {
		deactivatePlugin(id);
		setPluginEnabled(id, false);
		rerender((n) => n + 1);
	}, []);

	const handleUninstall = useCallback(
		async (id: string) => {
			deactivatePlugin(id);
			setPluginEnabled(id, false);
			unregisterPlugin(id);
			try {
				await cmd.uninstallPlugin(id);
			} catch (e) {
				log.error(`[marketplace] uninstall failed for "${id}":`, e);
			}
			refreshInstalled();
			rerender((n) => n + 1);
		},
		[refreshInstalled],
	);

	const handleUpdate = useCallback(
		async (id: string) => {
			const wasEnabled = isPluginEnabled(id);
			try {
				// Tear down the running plugin, re-download (install overwrites the files),
				// then re-register the fresh code — preserving enabled/disabled state.
				if (wasEnabled) deactivatePlugin(id);
				unregisterPlugin(id);
				const manifest = await cmd.installPlugin(id);
				try {
					await installSidecar(manifest, (pct) => setProgress(id, pct));
				} finally {
					setProgress(id, null);
				}
				await loadUserPlugin(manifest);
				if (wasEnabled) activatePlugin(id);
				await refreshInstalled();
				rerender((n) => n + 1);
			} catch (e) {
				log.error(`[marketplace] update failed for "${id}":`, e);
			}
		},
		[refreshInstalled, setProgress],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="Plugins" className="plugin-marketplace">
				<div className="plugin-marketplace__tabs">
					<button
						className={`plugin-marketplace__tab ${tab === "core" ? "plugin-marketplace__tab--active" : ""}`}
						onClick={() => setTab("core")}
					>
						Core
					</button>
					<button
						className={`plugin-marketplace__tab ${tab === "additional" ? "plugin-marketplace__tab--active" : ""}`}
						onClick={() => setTab("additional")}
					>
						Additional
					</button>
				</div>

				{tab === "core" && (
					<div className="plugin-marketplace__grid">
						{corePlugins.map((p) => (
							<CoreCard key={p.id} plugin={p} />
						))}
					</div>
				)}

				{tab === "additional" && (
					<div className="plugin-marketplace__grid">
						{installedEntries.map((e) => (
							<AdditionalCard
								key={e.id}
								{...e}
								installProgress={sidecarProgress[e.id]}
								onInstall={handleInstall}
								onEnable={handleEnable}
								onDisable={handleDisable}
								onUninstall={handleUninstall}
								onUpdate={handleUpdate}
							/>
						))}
						{!registry &&
							!fetchError &&
							Array.from({ length: 4 }, (_, i) => (
								<div key={i} className="plugin-card plugin-card--skeleton" aria-hidden="true">
									<div className="plugin-card__icon" />
									<div className="plugin-card__info">
										<div className="plugin-skeleton__line plugin-skeleton__line--title" />
										<div className="plugin-skeleton__line" />
									</div>
									<div className="plugin-skeleton__btn" />
								</div>
							))}
						{fetchError && (
							<div className="plugin-marketplace__empty">
								Failed to load registry: {fetchError}
								<br />
								<button className="button" onClick={fetchRegistry} style={{ marginTop: 8 }}>
									Retry
								</button>
							</div>
						)}
						{registryEntries.map((e) => (
							<AdditionalCard
								key={e.id}
								{...e}
								installProgress={sidecarProgress[e.id]}
								onInstall={handleInstall}
								onEnable={handleEnable}
								onDisable={handleDisable}
								onUninstall={handleUninstall}
								onUpdate={handleUpdate}
							/>
						))}
						{registry && installedEntries.length === 0 && registryEntries.length === 0 && (
							<div className="plugin-marketplace__empty">No additional plugins available.</div>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
