import { useState, useMemo } from "react";
import { cmd } from "@/lib/commands";
import { useAsync } from "@/lib/hooks/useAsync";
import { search } from "@/lib/search";
import { log } from "@/lib/util/log";
import { mdiEarth } from "@mdi/js";
import {
	Dialog,
	DialogContent,
	DialogHint,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { HotkeyInput } from "@/components/primitives/HotkeyInput";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { Button } from "@/components/primitives/Button";
import { useMapSetting } from "@/store/useMapSetting";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import {
	GLOBAL_COPY_BINDINGS,
	getMapCopyBindingKey,
	withMapCopyBinding,
} from "@/lib/map/mapKeyBindings";
import { getMapState } from "@/store/useMapStore";
import { t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";

/** Assign hotkeys that copy the active location into other maps. Each binding is
 *  either per-map (this map's settings) or global (works in every map); the globe
 *  toggle on a row moves it between the two stores. New targets are added via
 *  autocomplete (type a map name), then keyed. */
export function CopyToMapDialog({ open, onOpenChange }: DialogProps) {
	const [bindings, setBindings] = useMapSetting("keyBindings");
	const [globalBindings, setGlobalBindings] = useLocalStorage(GLOBAL_COPY_BINDINGS);
	// Added via autocomplete but not yet keyed; persisted only once a key is recorded.
	const [pendingIds, setPendingIds] = useState<string[]>([]);
	const [pendingGlobal, setPendingGlobal] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const { data: maps } = useAsync(
		() =>
			cmd.storeListMaps().catch((e) => {
				log.error("[copyToMap] list failed:", e);
				return null;
			}),
		[],
	);

	const byId = useMemo(() => new Map((maps ?? []).map((m) => [m.id, m])), [maps]);

	const copyIds = (list: typeof globalBindings) =>
		list.flatMap((b) => (b.action.type === "copyToMap" ? [b.action.mapId] : []));

	const boundIds = useMemo(() => {
		const ids = [...new Set([...copyIds(bindings ?? []), ...copyIds(globalBindings)])];
		return ids.sort((a, b) => (byId.get(a)?.name ?? "").localeCompare(byId.get(b)?.name ?? ""));
	}, [bindings, globalBindings, byId]);

	const rowIds = [...boundIds, ...pendingIds.filter((id) => !boundIds.includes(id))];

	const isGlobal = (id: string) =>
		getMapCopyBindingKey(globalBindings, id) !== undefined || pendingGlobal.includes(id);
	const keyFor = (id: string) =>
		getMapCopyBindingKey(globalBindings, id) ?? getMapCopyBindingKey(bindings ?? [], id) ?? "";

	const q = query.trim();
	const suggestions = q
		? search(maps ?? [], q, (m) => [m.name])
				.filter((m) => m.id !== getMapState().mapId && !rowIds.includes(m.id))
				.slice(0, 8)
		: [];

	const addMap = (id: string) => {
		setPendingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
		setQuery("");
	};

	const removeRow = (id: string) => {
		setBindings(withMapCopyBinding(bindings ?? [], id, ""));
		setGlobalBindings(withMapCopyBinding(globalBindings, id, ""));
		setPendingIds((prev) => prev.filter((p) => p !== id));
		setPendingGlobal((prev) => prev.filter((p) => p !== id));
	};

	const setRowKey = (id: string, combo: string) => {
		if (isGlobal(id)) {
			setGlobalBindings(withMapCopyBinding(globalBindings, id, combo));
		} else {
			setBindings(withMapCopyBinding(bindings ?? [], id, combo));
		}
		if (combo) {
			setPendingIds((prev) => prev.filter((p) => p !== id));
		} else if (!pendingIds.includes(id)) {
			// Cleared via Backspace: keep the row visible, just unkeyed.
			setPendingIds((prev) => [...prev, id]);
		}
	};

	/** Move a row's binding between this map's settings and the global set. */
	const toggleScope = (id: string) => {
		const key = keyFor(id);
		if (isGlobal(id)) {
			setGlobalBindings(withMapCopyBinding(globalBindings, id, ""));
			if (key) setBindings(withMapCopyBinding(bindings ?? [], id, key));
			setPendingGlobal((prev) => prev.filter((p) => p !== id));
		} else {
			setBindings(withMapCopyBinding(bindings ?? [], id, ""));
			if (key) setGlobalBindings(withMapCopyBinding(globalBindings, id, key));
			else setPendingGlobal((prev) => [...prev, id]);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Copy location to map (hotkeys)")} className="copy-to-map-modal-host">
				<div className="copy-to-map-modal">
					<DialogHint>
						{t(
							"Pressing an assigned key while a location is open copies that location into the map\n\t\t\t\t\t\t(duplicates are skipped).",
						)}
					</DialogHint>
					{rowIds.length > 0 && (
						<ul className="copy-to-map-modal__list">
							{rowIds.map((id) => {
								const meta = byId.get(id);
								const global = isGlobal(id);
								return (
									<li key={id} className="copy-to-map-modal__row">
										<span className="copy-to-map-modal__name">
											{meta ? meta.name || t("(unnamed)") : t("(missing map)")}
											{meta?.folder && <small> · {meta.folder}</small>}
										</span>
										<IconButton
											className="copy-to-map-modal__scope"
											icon={mdiEarth}
											size={16}
											label={t("Global hotkey")}
											tooltip={
												global
													? t("Works in every map (click for this map only)")
													: t("Only in this map (click to make it work everywhere)")
											}
											active={global}
											onClick={() => toggleScope(id)}
										/>
										<HotkeyInput value={keyFor(id)} onChange={(combo) => setRowKey(id, combo)} />
										<Button onClick={() => removeRow(id)}>{t("Remove")}</Button>
									</li>
								);
							})}
						</ul>
					)}
					<SuggestInput
						containerClassName="copy-to-map-modal__add"
						placeholder={t("Add a map...")}
						value={query}
						onChange={setQuery}
						suggestions={suggestions}
						getKey={(m) => m.id}
						onPick={(m) => addMap(m.id)}
						listStyle={{ top: "100%", left: 0, zIndex: 10 }}
						autoFocus
						renderItem={(m) => (
							<>
								<strong>{m.name || t("(unnamed)")}</strong>
								{m.folder && <span className="search-result__context"> · {m.folder}</span>}
							</>
						)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
