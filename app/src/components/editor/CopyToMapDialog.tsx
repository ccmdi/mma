import { useState, useEffect, useMemo } from "react";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import type { MapMeta } from "@/bindings.gen";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { HotkeyInput } from "@/components/primitives/HotkeyInput";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { useMapSetting } from "@/store/useMapSetting";
import { getMapCopyBindingKey, withMapCopyBinding } from "@/lib/map/mapKeyBindings";
import { getCurrentMapId } from "@/store/useMapStore";

/** Assign per-map hotkeys that copy the active location into other maps.
 *  Shows only configured maps; new targets are added via autocomplete (type a
 *  map name), then keyed. Bindings persist to this map's settings as changed. */
export function CopyToMapDialog({ onClose }: { onClose: () => void }) {
	const [maps, setMaps] = useState<MapMeta[] | null>(null);
	const [bindings, setBindings] = useMapSetting("keyBindings");
	// Added via autocomplete but not yet keyed; persisted only once a key is recorded.
	const [pendingIds, setPendingIds] = useState<string[]>([]);
	const [query, setQuery] = useState("");

	useEffect(() => {
		cmd
			.storeListMaps()
			.then(setMaps)
			.catch((e) => log.error("[copyToMap] list failed:", e));
	}, []);

	const byId = useMemo(() => new Map((maps ?? []).map((m) => [m.id, m])), [maps]);

	const boundIds = useMemo(() => {
		const ids = (bindings ?? []).flatMap((b) =>
			b.action.type === "copyToMap" ? [b.action.mapId] : [],
		);
		return ids.sort((a, b) => (byId.get(a)?.name ?? "").localeCompare(byId.get(b)?.name ?? ""));
	}, [bindings, byId]);

	const rowIds = [...boundIds, ...pendingIds.filter((id) => !boundIds.includes(id))];

	const lower = query.trim().toLowerCase();
	const suggestions = lower
		? (maps ?? [])
				.filter(
					(m) =>
						m.id !== getCurrentMapId() &&
						!rowIds.includes(m.id) &&
						m.name.toLowerCase().includes(lower),
				)
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 8)
		: [];

	const addMap = (id: string) => {
		setPendingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
		setQuery("");
	};

	const removeRow = (id: string) => {
		setBindings(withMapCopyBinding(bindings ?? [], id, ""));
		setPendingIds((prev) => prev.filter((p) => p !== id));
	};

	const setRowKey = (id: string, combo: string) => {
		setBindings(withMapCopyBinding(bindings ?? [], id, combo));
		if (combo) {
			setPendingIds((prev) => prev.filter((p) => p !== id));
		} else if (!pendingIds.includes(id)) {
			// Cleared via Backspace: keep the row visible, just unkeyed.
			setPendingIds((prev) => [...prev, id]);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title="Copy location to map (hotkeys)" className="copy-to-map-modal-host">
				<div className="copy-to-map-modal">
					<p className="copy-to-map-modal__hint">
						Pressing an assigned key while a location is open copies that location into the map
						(duplicates are skipped).
					</p>
					{rowIds.length > 0 && (
						<ul className="copy-to-map-modal__list">
							{rowIds.map((id) => {
								const meta = byId.get(id);
								const key = getMapCopyBindingKey(bindings ?? [], id) ?? "";
								return (
									<li key={id} className="copy-to-map-modal__row">
										<span className="copy-to-map-modal__name">
											{meta ? meta.name || "(unnamed)" : "(missing map)"}
											{meta?.folder && <small> · {meta.folder}</small>}
										</span>
										<HotkeyInput value={key} onChange={(combo) => setRowKey(id, combo)} />
										<button type="button" className="button" onClick={() => removeRow(id)}>
											Remove
										</button>
									</li>
								);
							})}
						</ul>
					)}
					<SuggestInput
						containerClassName="copy-to-map-modal__add"
						placeholder="Add a map..."
						value={query}
						onChange={setQuery}
						suggestions={suggestions}
						getKey={(m) => m.id}
						onPick={(m) => addMap(m.id)}
						listStyle={{ top: "100%", left: 0, zIndex: 10 }}
						autoFocus
						renderItem={(m) => (
							<>
								<strong>{m.name || "(unnamed)"}</strong>
								{m.folder && <span className="search-result__context"> · {m.folder}</span>}
							</>
						)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
