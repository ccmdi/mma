import { useEffect, useEffectEvent, useRef } from "react";
import { PANO_PITCH, FRAME_MS } from "@/lib/sv/constants";
import { clamp } from "@/types/util";
import { parseHotkey, matchesKey, isEditableElement } from "@/lib/hooks/useHotkey";
import { getBinding } from "@/lib/util/hotkeys";

import { singletonPano } from "@/lib/sv/panoSingleton";
import type { AppSettings } from "@/store/settings";

export function usePanoNavigation(
	appSettings: AppSettings,
	panorama?: google.maps.StreetViewPanorama | null,
) {
	const navRef = useRef({ held: new Set<string>(), rafId: 0, alt: false, lastTime: 0 });
	const getAppSettings = useEffectEvent(() => appSettings);
	const getPanorama = useEffectEvent(() => panorama ?? singletonPano);

	useEffect(() => {
		const nav = navRef.current;
		const lookActions = ["panoLookLeft", "panoLookRight", "panoLookUp", "panoLookDown"] as const;
		const moveActions = ["panoMoveForward", "panoMoveBackward"] as const;
		const allActions = [...lookActions, ...moveActions] as const;

		function tick() {
			const active = getPanorama();
			if (!active || nav.held.size === 0) {
				nav.rafId = 0;
				nav.lastTime = 0;
				return;
			}

			const now = performance.now();
			const dt = nav.lastTime ? (now - nav.lastTime) / FRAME_MS : 1;
			nav.lastTime = now;

			const s = getAppSettings();
			const slow = nav.alt ? s.slowModifier : 1;
			const speed = (s.panoLookSpeed * 0.4 * dt) / slow;
			const pov = active.getPov();
			let dh = 0,
				dp = 0;
			if (nav.held.has("panoLookLeft")) dh -= speed;
			if (nav.held.has("panoLookRight")) dh += speed;
			if (nav.held.has("panoLookUp")) dp += speed;
			if (nav.held.has("panoLookDown")) dp -= speed;

			if (dh || dp) {
				active.setOptions({
					pov: {
						heading: (pov.heading + dh + 360) % 360,
						pitch: clamp(pov.pitch + dp, PANO_PITCH),
					},
				});
				// Alt providers may ignore setOptions — also apply via setPov.
				active.setPov({
					heading: (pov.heading + dh + 360) % 360,
					pitch: clamp(pov.pitch + dp, PANO_PITCH),
				});
			}

			nav.rafId = requestAnimationFrame(tick);
		}

		function getParsed() {
			return allActions.map((a) => ({ action: a, parsed: parseHotkey(getBinding(a)) }));
		}
		const bindings = getParsed();

		function onKeyDown(e: KeyboardEvent) {
			nav.alt = e.altKey;
			if (e.key === "Alt") {
				e.preventDefault();
				return;
			}
			if (e.defaultPrevented || e.repeat) return;
			if (isEditableElement(e.target)) return;
			for (const { action, parsed } of bindings) {
				for (const alt of parsed) {
					if (alt.length === 1 && matchesKey(e, alt[0], { ignoreAlt: true })) {
						if (action === "panoMoveForward" || action === "panoMoveBackward") {
							const active = getPanorama();
							if (!active) return;
							const links = active
								.getLinks()
								?.filter((l): l is google.maps.StreetViewLink => l != null);
							if (!links?.length) return;
							const heading = active.getPov().heading;
							const target = action === "panoMoveForward" ? heading : (heading + 180) % 360;
							let best = links[0];
							let bestDiff = 360;
							for (const link of links) {
								const diff = Math.abs(((link.heading! - target + 540) % 360) - 180);
								if (diff < bestDiff) {
									bestDiff = diff;
									best = link;
								}
							}
							if (best.pano) active.setPano(best.pano);
							e.preventDefault();
							e.stopImmediatePropagation();
							return;
						}
						nav.held.add(action);
						if (!nav.rafId) nav.rafId = requestAnimationFrame(tick);
						e.preventDefault();
						e.stopImmediatePropagation();
						return;
					}
				}
			}
		}

		function onKeyUp(e: KeyboardEvent) {
			nav.alt = e.altKey;
			if (nav.held.size === 0) return;
			const key = e.key.toLowerCase();
			for (const { action, parsed } of bindings) {
				for (const alt of parsed) {
					if (alt.length === 1 && alt[0].key === key) {
						nav.held.delete(action);
					}
				}
			}
		}

		function onBlur() {
			nav.held.clear();
		}

		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", onBlur);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
			if (nav.rafId) cancelAnimationFrame(nav.rafId);
			nav.held.clear();
		};
	}, []);
}
