import { useEffect, useRef } from "react";
import { MapHost } from "@/lib/map/host";
import { getBinding } from "@/lib/util/hotkeys";
import type { HotkeyAction } from "@/lib/util/hotkeys";
import { parseHotkey, matchesKey, eventKey, isEditableElement } from "@/lib/hooks/useHotkey";

/** Hold a single-key hotkey to arm a crosshair, then a map click runs `onClick`
 *  (consuming the click so it never falls through to the default map handler).
 *  `shiftKey` reflects whether Shift was held at click time, so a held key can fork
 *  behavior by modifier (e.g. country vs subdivision).
 *
 *  `ignoreShift` lets the key arm whether or not Shift is held, so a Shift+key chord
 *  arms in any press order (the handler then reads `shiftKey` to fork). Leave it off
 *  when Shift+key is a separate binding (e.g. deletePolygon "e" vs Shift+e zoom). */
export function useHeldHotkeyClick(
	action: HotkeyAction,
	onClick: (lat: number, lng: number, shiftKey: boolean) => void,
	opts: { cursor?: string; ignoreShift?: boolean } = {},
) {
	const { cursor = "crosshair", ignoreShift = false } = opts;
	const handlerRef = useRef(onClick);
	handlerRef.current = onClick;

	useEffect(() => {
		let held = false;

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.repeat || isEditableElement(e.target)) return;
			const binding = getBinding(action);
			if (!binding) return;
			for (const alt of parseHotkey(binding)) {
				if (alt.length === 1 && matchesKey(e, alt[0], { ignoreShift })) {
					held = true;
					document.body.style.cursor = cursor;
					return;
				}
			}
		};

		const onKeyUp = (e: KeyboardEvent) => {
			if (!held) return;
			const binding = getBinding(action);
			if (!binding) return;
			for (const alt of parseHotkey(binding)) {
				if (alt.length === 1 && eventKey(e).toLowerCase() === alt[0].key) {
					held = false;
					document.body.style.cursor = "";
					return;
				}
			}
		};

		const onBlur = () => {
			if (held) {
				held = false;
				document.body.style.cursor = "";
			}
		};

		const dispose = MapHost.addClickInterceptor((lat, lng, shiftKey) => {
			if (!held) return false;
			handlerRef.current(lat, lng, shiftKey);
			return true;
		});

		const ac = new AbortController();
		const { signal } = ac;
		document.addEventListener("keydown", onKeyDown, { signal });
		document.addEventListener("keyup", onKeyUp, { signal });
		window.addEventListener("blur", onBlur, { signal });

		return () => {
			ac.abort();
			dispose();
			document.body.style.cursor = "";
		};
	}, [action, cursor, ignoreShift]);
}
