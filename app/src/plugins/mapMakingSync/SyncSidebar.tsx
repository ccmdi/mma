import { useCallback, useEffect, useMemo, useState } from "react";
import { Sidebar, Section, Field, EmptyState } from "@/components/primitives/Sidebar";
import { Tooltip } from "@/components/primitives/Tooltip";
import { mdiInformationOutline } from "@mdi/js";
import type { Remote } from "./map-making-web-api";
import type { SyncOutcome, FirstSyncMode } from "./engine";
import type { SyncStatus } from "./scheduler";
import * as ctrl from "./controller";

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function SyncSidebar({ onClose }: { onClose: () => void }) {
	const [keyDraft, setKeyDraft] = useState(ctrl.getApiKey());
	const [user, setUser] = useState<Remote.User | null>(ctrl.getCachedUser());
	const [maps, setMaps] = useState<Remote.Map[] | null>(ctrl.getCachedMaps());
	const [filter, setFilter] = useState("");
	const [link, setLink] = useState(ctrl.getLink());
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<SyncStatus>(ctrl.liveStatus());
	const [live, setLive] = useState(ctrl.isLive());
	const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pendingLink, setPendingLink] = useState<Remote.Map | null>(null);

	const mapId = ctrl.currentMapId();

	useEffect(() => ctrl.onStatus(setStatus), []);

	const validate = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			ctrl.setApiKey(keyDraft);
			setUser(await ctrl.validate());
			setMaps(await ctrl.listMaps());
		} catch (e) {
			setError(errText(e));
			setUser(null);
		} finally {
			setBusy(false);
		}
	}, [keyDraft]);

	// Validate once when a key exists but nothing is cached yet; cached opens are instant.
	useEffect(() => {
		if (ctrl.getApiKey() && !ctrl.getCachedUser()) void validate();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const performLink = useCallback(
		async (m: Remote.Map, mode: FirstSyncMode) => {
			setBusy(true);
			setError(null);
			setPendingLink(null);
			try {
				ctrl.link(m.id, user?.id ?? null);
				setLink(ctrl.getLink());
				setOutcome(await ctrl.firstSync(mode));
				ctrl.startLive(); // live by default on link
				setLive(true);
			} catch (e) {
				setError(errText(e));
			} finally {
				setBusy(false);
			}
		},
		[user],
	);

	// Merge vs mirror only matters when BOTH sides already have pins; otherwise just merge.
	const doLink = useCallback(
		(m: Remote.Map) => {
			if (ctrl.localLocationCount() > 0 && m.locationCount > 0) setPendingLink(m);
			else void performLink(m, "merge");
		},
		[performLink],
	);

	const doSync = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			setOutcome(await ctrl.syncNow());
			setLink(ctrl.getLink());
		} catch (e) {
			setError(errText(e));
		} finally {
			setBusy(false);
		}
	}, []);

	const doUnlink = useCallback(async () => {
		await ctrl.unlink();
		setLink(null);
		setLive(false);
		setOutcome(null);
	}, []);

	const toggleLive = useCallback(() => {
		if (ctrl.isLive()) {
			ctrl.stopLive();
			setLive(false);
		} else {
			ctrl.startLive();
			setLive(true);
		}
	}, []);

	const shown = useMemo(() => {
		if (!maps) return [];
		const f = filter.trim().toLowerCase();
		const list = f
			? maps.filter((m) => m.name.toLowerCase().includes(f) || String(m.id) === f)
			: maps;
		return list.slice(0, 25);
	}, [maps, filter]);

	return (
		<Sidebar title="map-making.app sync" onBack={onClose}>
			<Section title="Connection" defaultOpen>
				{user ? (
					<Field label="Signed in" row>
						<span>
							{user.username}{" "}
							<button
								className="button"
								onClick={() => {
									ctrl.forgetAuth();
									setUser(null);
									setMaps(null);
								}}
							>
								Change key
							</button>
						</span>
					</Field>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void validate();
						}}
					>
						{/* Hidden username satisfies the password-form a11y heuristic. */}
						<input
							type="text"
							autoComplete="username"
							defaultValue="map-making.app"
							tabIndex={-1}
							aria-hidden
							style={{
								position: "absolute",
								width: 1,
								height: 1,
								opacity: 0,
								pointerEvents: "none",
							}}
						/>
						<Field label="API key" hint="Get one at map-making.app/keys">
							<input
								className="input"
								type="password"
								autoComplete="current-password"
								value={keyDraft}
								onChange={(e) => setKeyDraft(e.target.value)}
								placeholder="paste API key"
							/>
						</Field>
						<button className="button button--primary" type="submit" disabled={busy || !keyDraft}>
							{busy ? "Validating..." : "Validate"}
						</button>
					</form>
				)}
			</Section>

			{user && !mapId && <EmptyState>Open a map to link it.</EmptyState>}

			{user && mapId && link && (
				<Section title="Sync" defaultOpen>
					<Field label="Linked to" row>
						<span>remote map #{link.remoteMapId}</span>
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
						<button className="button button--primary" disabled={busy} onClick={doSync}>
							{busy ? "Syncing..." : "Sync now"}
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
				</Section>
			)}

			{user && mapId && !link && !pendingLink && (
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
						<button
							key={m.id}
							className="button"
							disabled={busy}
							style={{ display: "block", width: "100%", textAlign: "left" }}
							onClick={() => doLink(m)}
						>
							{m.name || "(unnamed)"} · {m.locationCount} · #{m.id}
						</button>
					))}
				</Section>
			)}

			{user && mapId && !link && pendingLink && (
				<Section title="First sync" defaultOpen>
					<p className="mma-input__help">
						Both this map ({ctrl.localLocationCount()}) and "{pendingLink.name || "(unnamed)"}" (
						{pendingLink.locationCount}) already have locations. How should the first sync go?
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
