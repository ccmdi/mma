import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Sidebar, Section, Field } from "@/components/primitives/Sidebar";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Notice } from "@/components/primitives/Hint";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Spinner } from "@/components/primitives/Spinner";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { TextInput } from "@/components/primitives/TextInput";
import { Icon } from "@/components/primitives/Icon";
import { mdiInformationOutline } from "@mdi/js";
import type { Conflict, NormalizedSyncLocation, SideCounts, SyncLogEntry } from "@/bindings.gen";
import { SyncDirection, type FirstSyncMode, type SyncTrigger } from "@/bindings.consts";
import type { SyncController } from "../controller";
import type { SyncOutcome } from "../engine";
import type { RemoteMapSummary } from "../provider";
import type { SyncStatus } from "../scheduler";
import { errText } from "@/lib/util/format";
import { t, msg } from "@/lib/i18n";
import { matches } from "@/lib/search";
import { dateTimeFmt } from "@/lib/util/format";
import { Button } from "@/components/primitives/Button";
import { IconButton } from "@/components/primitives/IconButton";

type Side = "local" | "remote";

export interface SyncSidebarProps {
	onClose: () => void;
	controller: SyncController;
	/** Rendered in the Connection section: the provider's own auth affordance. A provider
	 *  with no account to connect omits it, and the section with it. */
	auth?: ReactNode;
	/**
	 * `undefined` while the provider is still working out whether it has a session, `null` once
	 * it knows there is none. The distinction matters: treating "not yet known" as "signed out"
	 * flashes the whole sign-in UI for a moment on every open.
	 */
	identity: { id: string | null } | null | undefined;
	source: LinkSource;
}

/** How the user picks what to link: a map from the provider's list, or an address they give. */
export type LinkSource =
	| {
			kind: "list";
			/** Fetch linkable remote maps. Called when authenticated and unlinked. */
			listMaps: () => Promise<RemoteMapSummary[]>;
			/** Create an empty remote map named `name`, to link to. */
			createMap?: (name: string) => Promise<RemoteMapSummary>;
	  }
	| {
			kind: "address";
			placeholder: string;
			/** Pick an address with a native dialog; null when cancelled. */
			browse: () => Promise<string | null>;
			/** Read what is at an address, to link to it. */
			resolve: (address: string) => Promise<RemoteMapSummary>;
	  };

function AddressPicker({
	source,
	busy,
	onPick,
}: {
	source: Extract<LinkSource, { kind: "address" }>;
	busy: boolean;
	onPick: (m: RemoteMapSummary) => void;
}) {
	const [address, setAddress] = useState("");
	const [reading, setReading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const read = async (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		setReading(true);
		setError(null);
		try {
			onPick(await source.resolve(trimmed));
		} catch (e) {
			setError(errText(e));
		} finally {
			setReading(false);
		}
	};

	const browse = async () => {
		const picked = await source.browse();
		if (picked) {
			setAddress(picked);
			await read(picked);
		}
	};

	return (
		<Field label={t("Map file")}>
			<div style={{ display: "flex", gap: 8 }}>
				<TextInput
					style={{ flex: 1 }}
					value={address}
					placeholder={source.placeholder}
					disabled={busy || reading}
					onChange={(e) => setAddress(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && void read(address)}
				/>
				<Button disabled={busy || reading} onClick={() => void browse()}>
					{t("Browse")}
				</Button>
			</div>
			<Button
				variant="primary"
				disabled={busy || reading || !address.trim()}
				onClick={() => void read(address)}
			>
				{reading ? t("Reading...") : t("Link")}
			</Button>
			{error && <Notice tone="error">{error}</Notice>}
		</Field>
	);
}

/** Compact signed-in row for the Connection section: avatar (or initial), name, action. */
export function ConnectionUser({
	name,
	avatarUrl,
	action,
}: {
	name: string;
	avatarUrl?: string | null;
	action: ReactNode;
}) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: "2rem" }}>
			{avatarUrl ? (
				<img
					src={avatarUrl}
					alt=""
					width={24}
					height={24}
					style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
					onError={(e) => (e.currentTarget.style.display = "none")}
				/>
			) : (
				<span aria-hidden className="sync-user__initial">
					{name.slice(0, 1).toUpperCase()}
				</span>
			)}
			<span className="sync-user__name truncate">{name}</span>
			{action}
		</div>
	);
}

const CONFLICT_LABEL: Record<Conflict["kind"], string> = {
	"update-update": msg("Both sides edited"),
	"delete-update": msg("Deleted on one side, edited on the other"),
	"add-add": msg("Both sides added"),
};

/** One line for what a pass changed on each side. */
function passSummary(
	r: { pushed: SideCounts; pulled: SideCounts; adopted: number; conflicts: number },
	pullOnly: boolean,
): string {
	const counts = pullOnly
		? t("Pulled +{lc} ~{lu} -{ld}", {
				lc: r.pulled.create,
				lu: r.pulled.update,
				ld: r.pulled.delete,
			})
		: t("Pushed +{pc} ~{pu} -{pd} · Pulled +{lc} ~{lu} -{ld}", {
				pc: r.pushed.create,
				pu: r.pushed.update,
				pd: r.pushed.delete,
				lc: r.pulled.create,
				lu: r.pulled.update,
				ld: r.pulled.delete,
			});
	const adopted = r.adopted ? " · " + t("Adopted {n}", { n: r.adopted }) : "";
	const conflicts = r.conflicts
		? " · " +
			t(
				{ one: "{n} conflict held for review", other: "{n} conflicts held for review" },
				{ n: r.conflicts },
			)
		: "";
	return counts + adopted + conflicts;
}

const TRIGGER_LABEL: Record<SyncTrigger, string> = {
	manual: msg("Sync now"),
	live: msg("Live"),
	link: msg("Linked"),
	resolve: msg("Conflicts resolved"),
};

/** The map's recorded sync passes with this provider, newest first. */
function SyncHistory({
	controller,
	mapId,
	pullOnly,
}: {
	controller: SyncController;
	mapId: string;
	pullOnly: boolean;
}) {
	const [entries, setEntries] = useState<SyncLogEntry[]>([]);
	useEffect(() => {
		let live = true;
		const load = () =>
			void controller
				.history()
				.then((e) => live && setEntries(e))
				.catch(() => live && setEntries([]));
		load();
		const off = controller.onHistory(load);
		return () => {
			live = false;
			off();
		};
	}, [controller, mapId]);

	if (entries.length === 0) return null;
	return (
		<Section title={t("History")} defaultOpen={false}>
			<ul className="sync-history">
				{entries.map((e) => (
					<li key={`${e.startedAt}:${e.trigger}`}>
						<span className="text-muted">
							{dateTimeFmt.format(new Date(e.startedAt))} · {t(TRIGGER_LABEL[e.trigger])}
						</span>
						<div className={e.result.kind === "error" ? "sync-history__error" : undefined}>
							{e.result.kind === "ok" ? passSummary(e.result, pullOnly) : errText(e.result.message)}
						</div>
					</li>
				))}
			</ul>
		</Section>
	);
}

const coord = (n: NormalizedSyncLocation): string => `${n.lat.toFixed(5)}, ${n.lng.toFixed(5)}`;

const FIELD_TEXT: {
	[K in keyof NormalizedSyncLocation]: (v: NormalizedSyncLocation[K]) => string;
} = {
	lat: (v) => v.toFixed(5),
	lng: (v) => v.toFixed(5),
	heading: (v) => String(v),
	pitch: (v) => String(v),
	zoom: (v) => String(v),
	panoId: (v) => v ?? "none",
	flags: (v) => String(v),
	tags: (v) => (v.length ? v.join(", ") : "none"),
	extra: (v) => (v ? JSON.stringify(v) : "none"),
};

const FIELDS = Object.keys(FIELD_TEXT) as (keyof NormalizedSyncLocation)[];

/** Only the fields that actually differ, rendered side by side. */
function differences(
	local: NormalizedSyncLocation,
	remote: NormalizedSyncLocation,
): { field: string; local: string; remote: string }[] {
	const out: { field: string; local: string; remote: string }[] = [];
	for (const f of FIELDS) {
		const show = FIELD_TEXT[f] as (v: NormalizedSyncLocation[typeof f]) => string;
		const l = show(local[f]);
		const r = show(remote[f]);
		if (l !== r) out.push({ field: f, local: l, remote: r });
	}
	return out;
}

function ConflictItem({
	conflict,
	busy,
	onResolve,
}: {
	conflict: Conflict;
	busy: boolean;
	onResolve: (side: Side) => void;
}) {
	const { local, remote } = conflict;
	const known = local ?? remote;
	const diffs = local && remote ? differences(local, remote) : [];

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
			<span>
				{t(CONFLICT_LABEL[conflict.kind])}
				{known ? ` · ${coord(known)}` : ""}
			</span>
			{!local && <span>{t("Deleted here")}</span>}
			{!remote && <span>{t("Deleted on the remote")}</span>}
			{diffs.map((d) => (
				<span key={d.field}>
					{t("{field}: local {local} · remote {remote}", {
						field: d.field,
						local: String(d.local),
						remote: String(d.remote),
					})}
				</span>
			))}
			<div style={{ display: "flex", gap: 8 }}>
				<Button disabled={busy} onClick={() => onResolve("local")}>
					{t("Keep local")}
				</Button>
				<Button disabled={busy} onClick={() => onResolve("remote")}>
					{t("Keep remote")}
				</Button>
			</div>
		</div>
	);
}

export function SyncSidebar({ onClose, controller, auth, identity, source }: SyncSidebarProps) {
	const icon = controller.provider.icon;
	const [maps, setMaps] = useState<RemoteMapSummary[] | null>(null);
	const [filter, setFilter] = useState("");
	const [link, setLink] = useState(controller.getLink());
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<SyncStatus>(controller.liveStatus());
	const [live, setLive] = useState(controller.isLive());
	const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pendingLink, setPendingLink] = useState<RemoteMapSummary | null>(null);

	const mapId = controller.currentMapId();
	const pullOnly = controller.direction === SyncDirection.PullOnly;
	const checking = identity === undefined;
	const authed = !checking && identity !== null;

	useEffect(
		() =>
			controller.onStatus((s) => {
				setStatus(s);
				// Poll ticks advance "last synced" and can stop the loop; keep both current.
				if (s !== "syncing") {
					setLink(controller.getLink());
					setLive(controller.isLive());
				}
			}),
		[], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// The prop is typically an inline arrow, so it can't be an effect dep.
	const listMaps = source.kind === "list" ? source.listMaps : null;
	const fetchMaps = useRef(listMaps);
	fetchMaps.current = listMaps;
	const [mapsAttempt, setMapsAttempt] = useState(0);

	useEffect(() => {
		const list = fetchMaps.current;
		if (!list || !authed || !mapId || link) return;
		let cancelled = false;
		setMaps(null);
		setError(null);
		list()
			.then((m) => !cancelled && setMaps(m))
			.catch((e: unknown) => !cancelled && setError(errText(e)));
		return () => {
			cancelled = true;
		};
	}, [authed, mapId, link, mapsAttempt]);

	const performLink = useCallback(
		async (m: RemoteMapSummary, mode: FirstSyncMode) => {
			setBusy(true);
			setError(null);
			try {
				await controller.link(m, identity?.id ?? null);
				try {
					setOutcome(await controller.firstSync(mode));
				} catch (e) {
					// Keeping the link would forget the chosen mode; retry must re-run THIS choice.
					await controller.unlink();
					setError(errText(e));
					setPendingLink(m);
					return;
				}
				setLink(controller.getLink());
				setPendingLink(null);
				controller.startLive(); // live by default on link
				setLive(true);
			} catch (e) {
				setError(errText(e));
			} finally {
				setBusy(false);
			}
		},
		[controller, identity],
	);

	// Merge vs mirror only matters when BOTH sides already have pins; otherwise just merge.
	const doLink = useCallback(
		(m: RemoteMapSummary) => {
			// An unknown remote count (null) must prompt, not assume empty.
			if (controller.localLocationCount() > 0 && m.locationCount !== 0) setPendingLink(m);
			else void performLink(m, "merge");
		},
		[controller, performLink],
	);

	const createMap = source.kind === "list" ? source.createMap : undefined;
	const doCreate = useCallback(async () => {
		if (!createMap) return;
		setBusy(true);
		setError(null);
		const created = await createMap(window.MMA.Store.get().map?.name ?? "").catch((e: unknown) => {
			setError(errText(e));
			return null;
		});
		setBusy(false);
		if (created) doLink(created);
	}, [createMap, doLink]);

	const doSync = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			setOutcome(await controller.syncNow());
			setLink(controller.getLink());
		} catch (e) {
			setError(errText(e));
		} finally {
			setBusy(false);
		}
	}, [controller]);

	const doUnlink = useCallback(async () => {
		await controller.unlink();
		setLink(null);
		setLive(false);
		setOutcome(null);
	}, [controller]);

	const toggleLive = useCallback(() => {
		if (controller.isLive()) {
			controller.stopLive();
			setLive(false);
		} else {
			controller.startLive();
			setLive(true);
		}
	}, [controller]);

	const resolve = useCallback(
		async (resolutions: { key: string; side: Side }[]) => {
			setBusy(true);
			setError(null);
			try {
				setOutcome(await controller.resolveConflicts(resolutions));
				setLink(controller.getLink());
			} catch (e) {
				setError(errText(e));
			} finally {
				setBusy(false);
			}
		},
		[controller],
	);

	const resolveAll = useCallback(
		(side: Side) => {
			if (!outcome) return;
			void resolve(outcome.conflicts.map((c) => ({ key: c.key, side })));
		},
		[outcome, resolve],
	);

	const shown = useMemo(() => {
		if (!maps) return [];
		const f = filter.trim();
		const list = f ? maps.filter((m) => matches(f, m.name) || m.id === f) : maps;
		return list.slice(0, 25);
	}, [maps, filter]);

	const remoteUrl = link ? controller.remoteMapUrl() : null;

	return (
		<Sidebar
			title={controller.provider.label}
			onBack={onClose}
			actions={
				icon && remoteUrl ? (
					<IconButton
						icon={<Icon path={icon} size={18} style={{ fill: "var(--accent)" }} />}
						label={t("Open in {provider}", { provider: controller.provider.label })}
						onClick={() => void openExternal(remoteUrl)}
					/>
				) : undefined
			}
		>
			{(checking || auth != null) && (
				<Section title={t("Connection")} defaultOpen>
					{/* 2rem is the button height both auth states resolve to, so the swap does not shift. */}
					{checking ? (
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								minHeight: "2rem",
							}}
						>
							<Spinner label={t("Checking connection")} />
						</div>
					) : (
						auth
					)}
				</Section>
			)}

			{authed && !mapId && <EmptyState>{t("Open a map to link it.")}</EmptyState>}

			{/* mapId and link are synchronous; never gate this on the async identity check. */}
			{mapId && link && (
				<Section title={t("Sync")} defaultOpen>
					<Field label={t("Linked to")} row>
						<span>
							{link.remoteMapName || t("(unnamed)")}{" "}
							<span className="text-muted">#{link.remoteMapId}</span>
						</span>
					</Field>
					<Field label={t("Last synced")} row>
						<span>
							{link.lastSyncedAt ? dateTimeFmt.format(new Date(link.lastSyncedAt)) : t("never")}
						</span>
					</Field>
					<Field
						label={
							<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
								{t("Live")}
								<Tooltip content={t("Sync continuously while this map is open")}>
									<span
										style={{ display: "inline-flex", cursor: "help", opacity: 0.6 }}
										aria-label={t("info")}
									>
										<svg viewBox="0 0 24 24" width={14} height={14}>
											<path d={mdiInformationOutline} fill="currentColor" />
										</svg>
									</span>
								</Tooltip>
							</span>
						}
						row
					>
						<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
							{/* Outside the button, so the label stays centred, and always present, so a
							    poll tick changes only its colour and can never reflow the row. */}
							<span
								aria-hidden
								style={{
									width: 6,
									height: 6,
									borderRadius: "50%",
									background:
										status === "error"
											? "var(--destructive-text)"
											: status === "syncing"
												? "currentColor"
												: "transparent",
									opacity: status === "syncing" ? 0.5 : 1,
								}}
							/>
							<button className={live ? "button button--primary" : "button"} onClick={toggleLive}>
								{live ? t("On") : t("Off")}
							</button>
						</span>
					</Field>
					<div style={{ display: "flex", gap: 8 }}>
						{/* Driven by `busy` alone; the background poll must not drive this label. */}
						<Button variant="primary" disabled={busy} onClick={() => void doSync()}>
							{busy ? t("Syncing...") : t("Sync now")}
						</Button>
						<Button disabled={busy} onClick={() => void doUnlink()}>
							{t("Unlink")}
						</Button>
					</div>
					{status === "error" && controller.liveError() && (
						<Notice tone="error">{controller.liveError()}</Notice>
					)}
					{outcome && (
						<p>{passSummary({ ...outcome, conflicts: outcome.conflicts.length }, pullOnly)}</p>
					)}
					{outcome && outcome.conflicts.length > 0 && (
						<>
							<div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
								<Button disabled={busy} onClick={() => resolveAll("local")}>
									{t("Keep local for all")}
								</Button>
								<Button disabled={busy} onClick={() => resolveAll("remote")}>
									{t("Keep remote for all")}
								</Button>
							</div>
							{outcome.conflicts.map((c) => (
								<ConflictItem
									key={c.key}
									conflict={c}
									busy={busy}
									onResolve={(side) => void resolve([{ key: c.key, side }])}
								/>
							))}
						</>
					)}
				</Section>
			)}

			{authed && mapId && !link && !pendingLink && (
				<Section title={t("Link this map")} defaultOpen>
					{source.kind === "address" ? (
						<AddressPicker source={source} busy={busy} onPick={doLink} />
					) : !maps && error ? (
						<Button onClick={() => setMapsAttempt((n) => n + 1)}>{t("Retry loading maps")}</Button>
					) : !maps ? (
						<div style={{ display: "flex", justifyContent: "center", padding: "0.5rem 0" }}>
							<Spinner label={t("Loading maps")} />
						</div>
					) : (
						<>
							<Field label={t("Find a remote map")}>
								<SuggestInput
									// Portalled: the sidebar clips overflow, so an inline dropdown is both cut
									// off and forced to grow the section instead of floating over it.
									portal
									listStyle={{ maxHeight: "40vh", overflowY: "auto" }}
									value={filter}
									onChange={setFilter}
									suggestions={shown}
									getKey={(m) => m.id}
									onPick={(m) => !m.unsupported && doLink(m)}
									disabled={busy}
									placeholder={t(
										{ one: "Search {n} map", other: "Search {n} maps" },
										{ n: maps.length },
									)}
									renderItem={(m) => (
										<span
											style={{
												display: "flex",
												justifyContent: "space-between",
												gap: 8,
												opacity: m.unsupported ? 0.5 : 1,
											}}
										>
											<span>{m.name || t("(unnamed)")}</span>
											<span className="text-muted" style={{ whiteSpace: "nowrap" }}>
												{m.unsupported ?? (m.locationCount !== null ? m.locationCount : "")}
											</span>
										</span>
									)}
								/>
							</Field>
							{createMap && (
								<Button onClick={() => void doCreate()} disabled={busy}>
									{t("Create a new remote map from this one")}
								</Button>
							)}
						</>
					)}
				</Section>
			)}

			{authed && mapId && !link && pendingLink && (
				<Section title={t("First sync")} defaultOpen>
					<p>
						{t(
							'This map ({local}) and "{name}" ({remote}) may both already have locations. How should the first sync go?',
							{
								local: controller.localLocationCount(),
								name: pendingLink.name || t("(unnamed)"),
								remote: pendingLink.locationCount ?? t("count unknown"),
							},
						)}
					</p>
					<Button
						variant="primary"
						disabled={busy}
						style={{ display: "block", width: "100%", textAlign: "left" }}
						onClick={() => void performLink(pendingLink, "merge")}
					>
						{t("Merge · keep everything on both sides")}
					</Button>
					<Button
						disabled={busy}
						style={{ display: "block", width: "100%", textAlign: "left" }}
						onClick={() => void performLink(pendingLink, "mirrorFromRemote")}
					>
						{t("Use remote · delete local-only pins")}
					</Button>
					{!pullOnly && (
						<Button
							disabled={busy}
							style={{ display: "block", width: "100%", textAlign: "left" }}
							onClick={() => void performLink(pendingLink, "mirrorFromLocal")}
						>
							{t("Use local · delete remote-only pins")}
						</Button>
					)}
					<Button disabled={busy} onClick={() => setPendingLink(null)}>
						{t("Cancel")}
					</Button>
				</Section>
			)}

			{mapId && <SyncHistory controller={controller} mapId={mapId} pullOnly={pullOnly} />}

			{error && <Notice tone="error">{error}</Notice>}
		</Sidebar>
	);
}
