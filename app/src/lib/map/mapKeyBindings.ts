import { useEffect } from "react";
import type { MapKeyAction, MapKeyBinding } from "@/bindings.gen";
import {
	parseHotkey,
	matchesKey,
	isEditableElement,
	pluginOverlayOwnsInput,
} from "@/lib/hooks/useHotkey";
import { persisted } from "@/lib/hooks/useLocalStorage";

/** Copy-to-map hotkeys that work in every map, assigned in the copy-to-map dialog;
 *  a map's own binding on the same key shadows them. */
export const GLOBAL_COPY_BINDINGS = persisted<MapKeyBinding[]>("globalCopyBindings", []);

type ActionType = MapKeyAction["type"];
type ActionOf<T extends ActionType> = Extract<MapKeyAction, { type: T }>;

/** A handler may return false to decline (e.g. action target no longer applies);
 *  the key then falls through to the global hotkey layer. */
type MapKeyActionHandler<T extends ActionType> = (actions: ActionOf<T>[]) => boolean | void;

const handlers = new Map<ActionType, (actions: MapKeyAction[]) => boolean | void>();

export function registerMapKeyActionHandler<T extends ActionType>(
	type: T,
	fn: MapKeyActionHandler<T>,
): () => void {
	const wrapped = fn as (actions: MapKeyAction[]) => boolean | void;
	handlers.set(type, wrapped);
	return () => {
		if (handlers.get(type) === wrapped) handlers.delete(type);
	};
}

/** Combo currently assigned to a tag, if any. */
export function getTagBindingKey(bindings: MapKeyBinding[], tagId: number): string | undefined {
	return bindings.find((b) => b.action.type === "applyTag" && b.action.tagId === tagId)?.key;
}

export function withTagKeyBinding(
	bindings: MapKeyBinding[],
	tagId: number,
	key: string,
): MapKeyBinding[] {
	const rest = bindings.filter((b) =>
		b.action.type === "applyTag" ? b.action.tagId !== tagId : !key || b.key !== key,
	);
	return key ? [...rest, { key, action: { type: "applyTag", tagId } }] : rest;
}

/** Combo currently assigned to copy-to-`mapId`, if any. */
export function getMapCopyBindingKey(bindings: MapKeyBinding[], mapId: string): string | undefined {
	return bindings.find((b) => b.action.type === "copyToMap" && b.action.mapId === mapId)?.key;
}

export function withMapCopyBinding(
	bindings: MapKeyBinding[],
	mapId: string,
	key: string,
): MapKeyBinding[] {
	const rest = bindings.filter(
		(b) => !(b.action.type === "copyToMap" && b.action.mapId === mapId) && (!key || b.key !== key),
	);
	return key ? [...rest, { key, action: { type: "copyToMap", mapId } }] : rest;
}

/** Per-map bindings plus the global copy bindings. Map bindings come first (the matcher
 *  takes the first hit, so a map's own binding on the same key shadows a global one), and
 *  a global copy targeting the open map itself is dropped. */
export function mergedKeyBindings(
	mapBindings: MapKeyBinding[],
	globalBindings: MapKeyBinding[],
	currentMapId: string | null,
): MapKeyBinding[] {
	const applicable = globalBindings.filter(
		(b) => !(b.action.type === "copyToMap" && b.action.mapId === currentMapId),
	);
	return applicable.length === 0 ? mapBindings : [...mapBindings, ...applicable];
}

/**
 * Mounted once by the map editor. Listens on window in the capture phase so
 * per-map bindings win over the document-capture global hotkey handlers
 * regardless of mount order (capture propagates window -> document).
 */
export function useMapKeyBindings(getBindings: () => MapKeyBinding[]) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.repeat) return;
			if (pluginOverlayOwnsInput() || isEditableElement(e.target)) return;
			const bindings = getBindings();
			const binding = bindings.find(
				(b) => b.key && parseHotkey(b.key).some((alt) => alt.length === 1 && matchesKey(e, alt[0])),
			);
			const run = binding && handlers.get(binding.action.type);
			if (!binding || !run) return;
			const actions = bindings
				.filter((b) => b.key === binding.key && b.action.type === binding.action.type)
				.map((b) => b.action);
			if (run(actions) !== false) e.preventDefault();
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}
