import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sidebar, Section, Field, EmptyState } from "@/components/primitives/Sidebar";
import { Tooltip } from "@/components/primitives/Tooltip";
import { mdiInformationOutline } from "@mdi/js";
import type { SyncController } from "../controller";
import type { Conflict } from "../diff";
import type { SyncOutcome, FirstSyncMode } from "../engine";
import type { NormalizedSyncLocation } from "../normalized";
import type { RemoteMapSummary } from "../provider";
import type { SyncStatus } from "../scheduler";

type Side = "local" | "remote";

export interface SyncSidebarProps {
	onClose: () => void;
	controller: SyncController;
	/** Rendered in the Connection section: the provider's own auth affordance. */
	auth: ReactNode;
	/** Null until authenticated; drives whether the link/sync sections render. */
	identity: { id: string | null } | null;
	/** Fetch linkable remote maps. Called when authenticated and unlinked. */
	listMaps: () => Promise<RemoteMapSummary[]>;
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
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

export function SyncSidebar({ onClose, controller, auth, identity, listMaps }: SyncSidebarProps) {
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
	const authed = identity !== null;

	useEffect(() => controller.onStatus(setStatus), []); // eslint-disable-line react-hooks/exhaustive-deps

	// The prop is typically an inline arrow, so it can't be an effect dep.
	const fetchMaps = useRef(listMaps);
	fetchMaps.current = listMaps;

	useEffect(() => {
		if (!authed || !mapId || link) return;
		let cancelled = false;
		setMaps(null);
		fetchMaps
			.current()
			.then((m) => !cancelled && setMaps(m))
			.catch((e: unknown) => !cancelled && setError(errText(e)));
		return () => {
			cancelled = true;
		};
	}, [authed, mapId, link]);

	const performLink = useCallback(
		async (m: RemoteMapSummary, mode: FirstSyncMode) => {
			setBusy(true);
			setError(null);
			setPendingLink(null);
			try {
				controller.link(m, identity?.id ?? null);
				setLink(controller.getLink());
				setOutcome(await controller.firstSync(mode));
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
			// An unknown remote count has to prompt: silently merging would be a guess, and merge
			// is still one click away in the prompt.
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

	return (
		<Sidebar title={controller.provider.label} onBack={onClose}>
			<Section title="Connection" defaultOpen>
				{auth}
			</Section>

			{authed && !mapId && <EmptyState>Open a map to link it.</EmptyState>}

			{authed && mapId && link && (
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
						<button className={live ? "button button--primary" : "button"} onClick={toggleLive}>
							{live ? `On (${status})` : "Off"}
						</button>
					</Field>
					<div style={{ display: "flex", gap: 8 }}>
						<button
							className="button button--primary"
							disabled={busy || status === "syncing"}
							onClick={doSync}
						>
							{busy || status === "syncing" ? "Syncing..." : "Sync now"}
						</button>
						<button className="button" disabled={busy} onClick={doUnlink}>
							Unlink
						</button>
					</div>
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
					<Field label="Find a remote map">
						<input
							className="input"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="filter by name or id"
						/>
					</Field>
					{!maps && <EmptyState>Loading maps...</EmptyState>}
					{shown.map((m) => (
						<div key={m.id}>
							<button
								className="button"
								disabled={busy || m.unsupported !== undefined}
								style={{ display: "block", width: "100%", textAlign: "left" }}
								onClick={() => doLink(m)}
							>
								{m.name || "(unnamed)"}
								{m.locationCount !== null ? ` · ${m.locationCount}` : ""} · #{m.id}
							</button>
							{m.unsupported && <span className="mma-input__help">{m.unsupported}</span>}
						</div>
					))}
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
