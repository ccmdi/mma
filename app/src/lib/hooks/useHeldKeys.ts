import { useEffect, useEffectEvent, useState } from "react";
import { parseHotkey, matchesKey, isEditableElement } from "@/lib/hooks/useHotkey";
import { getBinding, type HotkeyAction } from "@/lib/util/hotkeys";
import { FRAME_MS } from "@/lib/sv/constants";

interface HeldKeyHandlers<A extends HotkeyAction> {
	/** One animation frame while any key is held. `dt` is in frames; returning false stops the loop. */
	onTick(held: ReadonlySet<A>, dt: number, alt: boolean): boolean | void;
	/** A matched press. Returns whether the key is held; defaults to held. */
	onPress?(action: A, e: KeyboardEvent): boolean;
}

/** Run `onTick` every frame while any of `actions`' single-key bindings is held down.
 *  Bindings are resolved when enabled. Returns the live set of held actions. */
export function useHeldKeys<A extends HotkeyAction>(
	actions: readonly A[],
	enabled: boolean,
	handlers: HeldKeyHandlers<A>,
): ReadonlySet<A> {
	const [held] = useState(() => new Set<A>());
	const tick = useEffectEvent(handlers.onTick);
	const press = useEffectEvent(
		(action: A, e: KeyboardEvent) => handlers.onPress?.(action, e) ?? true,
	);

	useEffect(() => {
		if (!enabled) return;
		let rafId = 0;
		let lastTime = 0;
		let alt = false;
		const bindings = actions.map((action) => ({ action, parsed: parseHotkey(getBinding(action)) }));

		function stop() {
			rafId = 0;
			lastTime = 0;
		}

		function frame() {
			if (held.size === 0) return stop();
			const now = performance.now();
			const dt = lastTime ? (now - lastTime) / FRAME_MS : 1;
			lastTime = now;
			if (tick(held, dt, alt) === false) return stop();
			rafId = requestAnimationFrame(frame);
		}

		function onKeyDown(e: KeyboardEvent) {
			alt = e.altKey;
			if (e.key === "Alt") {
				e.preventDefault();
				return;
			}
			if (e.defaultPrevented || e.repeat || isEditableElement(e.target)) return;
			const hit = bindings.find(({ parsed }) =>
				parsed.some((keys) => keys.length === 1 && matchesKey(e, keys[0], { ignoreAlt: true })),
			);
			if (!hit || !press(hit.action, e)) return;
			held.add(hit.action);
			if (!rafId) rafId = requestAnimationFrame(frame);
		}

		function onKeyUp(e: KeyboardEvent) {
			alt = e.altKey;
			if (held.size === 0) return;
			const key = e.key.toLowerCase();
			for (const { action, parsed } of bindings) {
				if (parsed.some((keys) => keys.length === 1 && keys[0].key === key)) held.delete(action);
			}
		}

		const ac = new AbortController();
		const { signal } = ac;
		document.addEventListener("keydown", onKeyDown, { capture: true, signal });
		document.addEventListener("keyup", onKeyUp, { capture: true, signal });
		window.addEventListener("blur", () => held.clear(), { signal });
		return () => {
			ac.abort();
			if (rafId) cancelAnimationFrame(rafId);
			held.clear();
		};
	}, [enabled, actions, held]);

	return held;
}
