import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Sidebar, Section, Field, EmptyState } from "@/components/primitives/Sidebar";
import { Tooltip } from "@/components/primitives/Tooltip";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { Icon } from "@/components/primitives/Icon";
import { mdiInformationOutline } from "@mdi/js";
import type { Conflict, FirstSyncMode, NormalizedSyncLocation } from "@/bindings.gen";
import type { SyncController } from "../controller";
import type { SyncOutcome } from "../engine";
import type { RemoteMapSummary } from "../provider";
import type { SyncStatus } from "../scheduler";

type Side = "local" | "remote";

export interface SyncSidebarProps {
	onClose: () => void;
	controller: SyncController;
	/** Rendered in the Connection section: the provider's own auth affordance. */
	auth: ReactNode;
	/**
	 * `undefined` while the provider is still working out whether it has a session, `null` once
	 * it knows there is none. The distinction matters: treating "not yet known" as "signed out"
	 * flashes the whole sign-in UI for a moment on every open.
	 */
	identity: { id: string | null } | null | undefined;
	/** Fetch linkable remote maps. Called when authenticated and unlinked. */
	listMaps: () => Promise<RemoteMapSummary[]>;
	/** Provider mark for the header's open-in-browser button (shown when linked). */
	brand?: { path: string; color: string };
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
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
				<span
					aria-hidden
					style={{
						width: 24,
						height: 24,
						borderRadius: "50%",
						background: "var(--surface-3, rgba(128,128,128,0.25))",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: 12,
						flexShrink: 0,
					}}
				>
					{name.slice(0, 1).toUpperCase()}
				</span>
			)}
			<span
				style={{
					flex: 1,
					minWidth: 0,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				}}
			>
				{name}
			</span>
			{action}
		</div>
	);
}

const CONFLICT_LABEL: Record<Conflict["kind"], string> = {
	"update-update": "Both sides edited",
	"delete-update": "Deleted on one side, edited on the other",
	"add-add": "Both sides added",
};

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
			<span className="mma-input__help">
				{CONFLICT_LABEL[conflict.kind]}
				{known ? ` · ${coord(known)}` : ""}
			</span>
			{!local && <span className="mma-input__help">Deleted here</span>}
			{!remote && <span className="mma-input__help">Deleted on the remote</span>}
			{diffs.map((d) => (
				<span className="mma-input__help" key={d.field}>
					{d.field}: local {d.local} · remote {d.remote}
				</span>
			))}
			<div style={{ display: "flex", gap: 8 }}>
				<button className="button" disabled={busy} onClick={() => onResolve("local")}>
					Keep local
				</button>
				<button className="button" disabled={busy} onClick={() => onResolve("remote")}>
					Keep remote
				</button>
			</div>
		</div>
	);
}

export function SyncSidebar({
	onClose,
	controller,
	auth,
	identity,
	listMaps,
	brand,
}: SyncSidebarProps) {
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
	const fetchMaps = useRef(listMaps);
	fetchMaps.current = listMaps;
	const [mapsAttempt, setMapsAttempt] = useState(0);

	useEffect(() => {
		if (!authed || !mapId || link) return;
		let cancelled = false;
		setMaps(null);
		setError(null);
		fetchMaps
			.current()
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
		const f = filter.trim().toLowerCase();
		const list = f ? maps.filter((m) => m.name.toLowerCase().includes(f) || m.id === f) : maps;
		return list.slice(0, 25);
	}, [maps, filter]);

	const remoteUrl = link ? controller.remoteMapUrl() : null;

	return (
		<Sidebar
			title={controller.provider.label}
			onBack={onClose}
			actions={
				brand && remoteUrl ? (
					<Tooltip content={`Open in ${controller.provider.label}`}>
						<button
							className="icon-button"
							type="button"
							aria-label={`Open in ${controller.provider.label}`}
							onClick={() => void openExternal(remoteUrl)}
						>
							<Icon path={brand.path} size={18} style={{ fill: brand.color }} />
						</button>
					</Tooltip>
				) : undefined
			}
		>
			<Section title="Connection" defaultOpen>
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
						<span className="spinner" aria-label="Checking connection" />
					</div>
				) : (
					auth
				)}
			</Section>

			{authed && !mapId && <EmptyState>Open a map to link it.</EmptyState>}

			{/* mapId and link are synchronous; never gate this on the async identity check. */}
			{mapId && link && (
				<Section title="Sync" defaultOpen>
					<Field label="Linked to" row>
						<span>
							{link.remoteMapName || "(unnamed)"}{" "}
							<span style={{ opacity: 0.6 }}>#{link.remoteMapId}</span>
						</span>
					</Field>
					<Field label="Last synced" row>
						<span>
							{link.lastSyncedAt ? new Date(link.lastSyncedAt).toLocaleString() : "never"}
						</span>
					</Field>
					<Field
						label={
							<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
								Live
								<Tooltip content="Sync continuously while this map is open">
									<span
										style={{ display: "inline-flex", cursor: "help", opacity: 0.6 }}
										aria-label="info"
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
											? "var(--red-9, #e5484d)"
											: status === "syncing"
												? "currentColor"
												: "transparent",
									opacity: status === "syncing" ? 0.5 : 1,
								}}
							/>
							<button className={live ? "button button--primary" : "button"} onClick={toggleLive}>
								{live ? "On" : "Off"}
							</button>
						</span>
					</Field>
					<div style={{ display: "flex", gap: 8 }}>
						{/* Driven by `busy` alone; the background poll must not drive this label. */}
						<button className="button button--primary" disabled={busy} onClick={doSync}>
							{busy ? "Syncing..." : "Sync now"}
						</button>
						<button className="button" disabled={busy} onClick={doUnlink}>
							Unlink
						</button>
					</div>
					{status === "error" && controller.liveError() && (
						<p className="mma-input__help" style={{ color: "var(--red-9, #e5484d)" }}>
							{controller.liveError()}
						</p>
					)}
					{outcome && (
						<p className="mma-input__help">
							Pushed +{outcome.pushed.create} ~{outcome.pushed.update} -{outcome.pushed.delete} ·
							Pulled +{outcome.pulled.create} ~{outcome.pulled.update} -{outcome.pulled.delete}
							{outcome.adopted ? ` · Adopted ${outcome.adopted}` : ""}
							{outcome.conflicts.length
								? ` · ${outcome.conflicts.length} conflict(s) held for review`
								: ""}
						</p>
					)}
					{outcome && outcome.conflicts.length > 0 && (
						<>
							<div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
								<button className="button" disabled={busy} onClick={() => resolveAll("local")}>
									Keep local for all
								</button>
								<button className="button" disabled={busy} onClick={() => resolveAll("remote")}>
									Keep remote for all
								</button>
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
				<Section title="Link this map" defaultOpen>
					{!maps && error ? (
						<button className="button" onClick={() => setMapsAttempt((n) => n + 1)}>
							Retry loading maps
						</button>
					) : !maps ? (
						<div style={{ display: "flex", justifyContent: "center", padding: "0.5rem 0" }}>
							<span className="spinner" aria-label="Loading maps" />
						</div>
					) : (
						<Field label="Find a remote map">
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
								placeholder={`Search ${maps.length} map${maps.length === 1 ? "" : "s"}`}
								renderItem={(m) => (
									<span
										style={{
											display: "flex",
											justifyContent: "space-between",
											gap: 8,
											opacity: m.unsupported ? 0.5 : 1,
										}}
									>
										<span>{m.name || "(unnamed)"}</span>
										<span style={{ opacity: 0.6, whiteSpace: "nowrap" }}>
											{m.unsupported ?? (m.locationCount !== null ? m.locationCount : "")}
										</span>
									</span>
								)}
							/>
						</Field>
					)}
				</Section>
			)}

			{authed && mapId && !link && pendingLink && (
				<Section title="First sync" defaultOpen>
					<p className="mma-input__help">
						This map ({controller.localLocationCount()}) and "{pendingLink.name || "(unnamed)"}" (
						{pendingLink.locationCount ?? "count unknown"}) may both already have locations. How
						should the first sync go?
					</p>
					<button
						className="button button--primary"
						disabled={busy}
						style={{ display: "block", width: "100%", textAlign: "left" }}
						onClick={() => performLink(pendingLink, "merge")}
					>
						Merge · keep everything on both sides
					</button>
					<button
						className="button"
						disabled={busy}
						style={{ display: "block", width: "100%", textAlign: "left" }}
						onClick={() => performLink(pendingLink, "mirrorFromRemote")}
					>
						Use remote · delete local-only pins
					</button>
					<button
						className="button"
						disabled={busy}
						style={{ display: "block", width: "100%", textAlign: "left" }}
						onClick={() => performLink(pendingLink, "mirrorFromLocal")}
					>
						Use local · delete remote-only pins
					</button>
					<button className="button" disabled={busy} onClick={() => setPendingLink(null)}>
						Cancel
					</button>
				</Section>
			)}

			{error && (
				<p className="mma-input__help" style={{ color: "var(--red-9, #e5484d)" }}>
					{error}
				</p>
			)}
		</Sidebar>
	);
}
