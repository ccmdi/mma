import { useEffect } from "react";
import type { MapKeyAction, MapKeyBinding } from "@/bindings.gen";
import { parseHotkey, matchesKey, isEditableElement } from "@/lib/hooks/useHotkey";

/**
 * Per-map key binding layer. Bindings live on `MapSettings.keyBindings`; each maps
 * a combo string (same format as global hotkeys) to a MapKeyAction. Action handlers
 * are registered by the component that owns the relevant state (e.g. the location
 * editor registers applyTag while a location is open), so an action only consumes
 * the key when it is currently applicable — otherwise the event falls through to
 * the global hotkey layer.
 */

type ActionType = MapKeyAction["type"];
type ActionOf<T extends ActionType> = Extract<MapKeyAction, { type: T }>;

/** A handler may return false to decline (e.g. action target no longer applies);
 *  the key then falls through to the global hotkey layer. */
type MapKeyActionHandler<T extends ActionType> = (action: ActionOf<T>) => boolean | void;

const handlers = new Map<ActionType, (action: MapKeyAction) => boolean | void>();

export function registerMapKeyActionHandler<T extends ActionType>(
	type: T,
	fn: MapKeyActionHandler<T>,
): () => void {
	const wrapped = fn as (action: MapKeyAction) => boolean | void;
	handlers.set(type, wrapped);
	return () => {
		if (handlers.get(type) === wrapped) handlers.delete(type);
	};
}

/**
 * New bindings list with `key` assigned to `action`. Enforces uniqueness both
 * ways: the key is taken from any binding that held it, and the action target's
 * previous key is dropped. An empty `key` just clears the target's binding.
 */
function withKeyBinding(
	bindings: MapKeyBinding[],
	key: string,
	action: MapKeyAction,
	sameTarget: (a: MapKeyAction) => boolean,
): MapKeyBinding[] {
	const rest = bindings.filter((b) => !sameTarget(b.action) && (!key || b.key !== key));
	if (!key) return rest;
	return [...rest, { key, action }];
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
	return withKeyBinding(
		bindings,
		key,
		{ type: "applyTag", tagId },
		(a) => a.type === "applyTag" && a.tagId === tagId,
	);
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
	return withKeyBinding(
		bindings,
		key,
		{ type: "copyToMap", mapId },
		(a) => a.type === "copyToMap" && a.mapId === mapId,
	);
}

export function matchMapKeyBinding(
	e: KeyboardEvent,
	bindings: MapKeyBinding[],
): MapKeyBinding | undefined {
	for (const b of bindings) {
		if (!b.key) continue;
		for (const alt of parseHotkey(b.key)) {
			if (alt.length === 1 && matchesKey(e, alt[0])) return b;
		}
	}
	return undefined;
}

/** Returns true if a registered handler consumed the action. */
export function executeMapKeyAction(action: MapKeyAction): boolean {
	const fn = handlers.get(action.type);
	if (!fn) return false;
	return fn(action) !== false;
}

/** Resolve a keydown against the current bindings; consume it if handled. */
export function handleMapKeyEvent(e: KeyboardEvent, bindings: MapKeyBinding[]): boolean {
	if (e.defaultPrevented || e.repeat) return false;
	if (isEditableElement(e.target)) return false;
	if (bindings.length === 0) return false;
	const binding = matchMapKeyBinding(e, bindings);
	if (!binding) return false;
	if (!executeMapKeyAction(binding.action)) return false;
	e.preventDefault();
	return true;
}

/**
 * Mounted once by the map editor. Listens on window in the capture phase so
 * per-map bindings win over the document-capture global hotkey handlers
 * regardless of mount order (capture propagates window -> document).
 */
export function useMapKeyBindings(getBindings: () => MapKeyBinding[]) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			handleMapKeyEvent(e, getBindings());
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}
