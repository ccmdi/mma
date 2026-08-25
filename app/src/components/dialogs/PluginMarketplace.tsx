import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
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
	isPluginCompatible,
	isBackgroundPlugin,
	fetchPluginRegistry,
} from "@/plugins/registry";
import { events, type PluginManifest } from "@/bindings.gen";
import { loadAndActivatePlugin, loadUserPlugin } from "@/plugins/index";
import { cmd } from "@/lib/commands";
import { appVersion } from "@/lib/version";
import { log } from "@/lib/util/log";

// Download a plugin's sidecar (if declared), reporting progress via onProgress. Shared by
// install + update so both paths fetch the binary the same way.
async function installSidecar(
	manifest: PluginManifest,
	onProgress: (pct: number) => void,
): Promise<void> {
	if (!manifest.sidecar) return;
	const unlisten = await events.sidecarInstallProgress.listen((ev) => {
		if (ev.payload.pluginId === manifest.id && ev.payload.total > 0) {
			onProgress(Math.round((ev.payload.downloaded / ev.payload.total) * 100));
		}
	});
	try {
		await cmd.sidecarInstall(manifest.id, manifest.sidecar.name, manifest.sidecar.version);
	} finally {
		unlisten();
	}
}

type Tab = "core" | "additional";

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
						<SwitchRow
							key={def.key}
							className="plugin-card__setting"
							checked={Boolean(value)}
							onChange={(v) => update(v)}
							label={t(def.label)}
						>
							<span>{t(def.label)}</span>
						</SwitchRow>
					);
				}
				return (
					<label key={def.key} className="plugin-card__setting">
						<span>{t(def.label)}</span>
						<TextInput
							type={def.type === "number" ? "number" : "text"}
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

import { mdiAutoFix, mdiDownload, mdiFlaskOutline, mdiRefresh, mdiTrashCanOutline } from "@mdi/js";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Switch } from "@/components/primitives/Switch";
import { SwitchRow } from "@/components/primitives/SwitchRow";
import { t, msg } from "@/lib/i18n";

/** One card's worth of state. Core plugins are just entries that ship installed and
 *  can't be uninstalled or updated independently of the app. */
interface PluginEntry {
	id: string;
	name: string;
	description: string;
	icon: string;
	/** Built in — no install/uninstall/update affordances. */
	core?: boolean;
	installed: boolean;
	enabled: boolean;
	updatable?: boolean;
	latestVersion?: string;
	comingSoon?: boolean;
	experimental?: boolean;
	requiresApp?: string | null;
}

/** Small hover-explained markers on a card. Each either derives from the loaded
 *  plugin's shape or from what the plugin declares about itself. */
const CARD_LABELS: {
	key: string;
	icon: string;
	tooltip: string;
	applies: (entry: PluginEntry) => boolean;
}[] = [
	{
		key: "experimental",
		icon: mdiFlaskOutline,
		tooltip: msg("Experimental"),
		applies: (e) => !!e.experimental,
	},
	{
		key: "enrichment",
		icon: mdiAutoFix,
		tooltip: msg("Enrichment only: adds data fields, no panel of its own"),
		applies: (e) => e.installed && isBackgroundPlugin(e.id),
	},
];

interface PluginCardProps {
	entry: PluginEntry;
	installProgress?: number;
	onInstall: (id: string) => void;
	onEnable: (id: string) => void;
	onDisable: (id: string) => void;
	onUninstall: (id: string) => void;
	onUpdate: (id: string) => void;
}

function PluginCard({
	entry,
	installProgress,
	onInstall,
	onEnable,
	onDisable,
	onUninstall,
	onUpdate,
}: PluginCardProps) {
	const { id, name, description, icon, core, installed, enabled, comingSoon, requiresApp } = entry;
	const [busy, setBusy] = useState(false);

	const run = (fn: (id: string) => void | Promise<void>) => () => {
		void (async () => {
			setBusy(true);
			try {
				await fn(id);
			} finally {
				setBusy(false);
			}
		})();
	};

	return (
		<div
			className={`plugin-card ${enabled ? "plugin-card--enabled" : ""} ${comingSoon ? "plugin-card--coming-soon" : ""}`}
		>
			<div className="plugin-card__icon">{icon ? <Icon path={icon} size={32} /> : null}</div>
			<div className="plugin-card__info">
				<div className="plugin-card__name">
					{t(name)}
					{CARD_LABELS.filter((l) => l.applies(entry)).map((l) => (
						<Tooltip key={l.key} content={t(l.tooltip)}>
							<span className="plugin-card__label" aria-label={t(l.tooltip)}>
								<Icon path={l.icon} size={14} />
							</span>
						</Tooltip>
					))}
				</div>
				{description && <div className="plugin-card__desc">{t(description)}</div>}
			</div>
			{!comingSoon && (
				<div className="plugin-card__actions">
					{busy && installProgress !== undefined && (
						<span className="plugin-card__progress">{installProgress}%</span>
					)}
					{!installed ? (
						<button
							className="plugin-card__action-btn plugin-card__action-btn--install"
							onClick={run(onInstall)}
							disabled={busy || !!requiresApp}
							title={
								requiresApp
									? t("Requires app v{version} or newer", { version: requiresApp })
									: t("Install")
							}
							aria-label={t("Install")}
						>
							<Icon path={mdiDownload} size={16} />
						</button>
					) : (
						<Switch
							checked={enabled}
							onChange={(next) => (next ? onEnable(id) : onDisable(id))}
							disabled={busy}
							label={enabled ? t("Disable") : t("Enable")}
						/>
					)}
					{installed && !core && entry.updatable && (
						<button
							className="plugin-card__action-btn plugin-card__action-btn--update"
							onClick={run(onUpdate)}
							disabled={busy || !!requiresApp}
							title={
								requiresApp
									? t("Update requires app v{version} or newer", { version: requiresApp })
									: entry.latestVersion
										? t("Update to v{version}", { version: entry.latestVersion })
										: t("Update")
							}
							aria-label={t("Update")}
						>
							<Icon path={mdiRefresh} size={16} />
						</button>
					)}
					{installed && !core && (
						<button
							className="plugin-card__action-btn plugin-card__action-btn--uninstall"
							onClick={() => onUninstall(id)}
							disabled={busy}
							title={t("Uninstall")}
							aria-label={t("Uninstall")}
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

export function PluginMarketplace({ open, onOpenChange }: DialogProps) {
	const [tab, setTab] = useState<Tab>("core");
	const [registry, setRegistry] = useState<PluginManifest[] | null>(null);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [installedManifests, setInstalledManifests] = useState<PluginManifest[]>([]);
	const [sidecarVersions, setSidecarVersions] = useState<Record<string, string | null>>({});
	const [sidecarProgress, setSidecarProgress] = useState<Record<string, number>>({});
	const [, rerender] = useState(0);

	const coreEntries: PluginEntry[] = getPlugins()
		.filter((p) => p.core)
		.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description || "",
			icon: p.icon,
			core: true,
			installed: true,
			enabled: isPluginEnabled(p.id),
			comingSoon: p.comingSoon,
			experimental: p.experimental,
		}));

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
		if (open) void refreshInstalled();
	}, [open, refreshInstalled]);

	const fetchRegistry = useCallback(() => {
		setFetchError(null);
		fetchPluginRegistry()
			.then(setRegistry)
			.catch((e) => setFetchError(e.message));
	}, []);

	useEffect(() => {
		if (open && !registry) fetchRegistry();
	}, [open, registry, fetchRegistry]);

	const { installedEntries, registryEntries } = (() => {
		const installedById = new Map(installedManifests.map((m) => [m.id, m]));
		const installed: PluginEntry[] = [];
		const fromRegistry: PluginEntry[] = [];

		if (registry) {
			for (const r of registry) {
				const manifest = installedById.get(r.id);
				const isInstalled = !!manifest;
				const updatable =
					isInstalled &&
					needsUpdate(manifest.version, r.version, sidecarVersions[r.id], r.sidecar?.version);
				const entry: PluginEntry = {
					id: r.id,
					name: r.name,
					description: r.description,
					icon: r.icon,
					installed: isInstalled,
					enabled: isPluginEnabled(r.id),
					updatable,
					latestVersion: r.version,
					comingSoon: r.comingSoon,
					experimental: r.experimental ?? manifest?.experimental,
					requiresApp: isPluginCompatible(r.minAppVersion, appVersion() ?? "0")
						? undefined
						: r.minAppVersion,
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
				experimental: m.experimental,
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
			void refreshInstalled();
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

	const cardHandlers = {
		onInstall: handleInstall,
		onEnable: handleEnable,
		onDisable: handleDisable,
		onUninstall: handleUninstall,
		onUpdate: handleUpdate,
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Plugins")} className="plugin-marketplace">
				<div className="plugin-marketplace__tabs">
					<button
						className={`plugin-marketplace__tab ${tab === "core" ? "plugin-marketplace__tab--active" : ""}`}
						onClick={() => setTab("core")}
					>
						{t("Core")}
					</button>
					<button
						className={`plugin-marketplace__tab ${tab === "additional" ? "plugin-marketplace__tab--active" : ""}`}
						onClick={() => setTab("additional")}
					>
						{t("Additional")}
					</button>
				</div>

				{tab === "core" && (
					<div className="plugin-marketplace__grid">
						{coreEntries.map((e) => (
							<PluginCard key={e.id} entry={e} {...cardHandlers} />
						))}
					</div>
				)}

				{tab === "additional" && (
					<div className="plugin-marketplace__grid">
						{installedEntries.map((e) => (
							<PluginCard
								key={e.id}
								entry={e}
								installProgress={sidecarProgress[e.id]}
								{...cardHandlers}
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
								{t("Failed to load registry:")} {fetchError}
								<br />
								<Button onClick={fetchRegistry} style={{ marginTop: 8 }}>
									{t("Retry")}
								</Button>
							</div>
						)}
						{registryEntries.map((e) => (
							<PluginCard
								key={e.id}
								entry={e}
								installProgress={sidecarProgress[e.id]}
								{...cardHandlers}
							/>
						))}
						{registry && installedEntries.length === 0 && registryEntries.length === 0 && (
							<div className="plugin-marketplace__empty">
								{t("No additional plugins available.")}
							</div>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
