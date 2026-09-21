import { useHeldKeys } from "@/lib/hooks/useHeldKeys";
import { usePano } from "@/lib/hooks/usePano";
import type { AppSettings } from "@/store/settings";

const ACTIONS = [
	"panoLookLeft",
	"panoLookRight",
	"panoLookUp",
	"panoLookDown",
	"panoMoveForward",
	"panoMoveBackward",
] as const;

export function usePanoNavigation(appSettings: AppSettings) {
	const pano = usePano();

	useHeldKeys(ACTIONS, true, {
		onPress(action, e) {
			const mode = appSettings.defaultMovementMode;
			if (action === "panoMoveForward" || action === "panoMoveBackward") {
				if (mode === "moving" && pano.step(action === "panoMoveForward" ? "forward" : "backward")) {
					e.preventDefault();
					e.stopImmediatePropagation();
				}
				return false;
			}
			if (mode === "nmpz") return false;
			e.preventDefault();
			e.stopImmediatePropagation();
			return true;
		},
		onTick(held, dt, alt) {
			if (!pano.exists()) return false;
			const slow = alt ? appSettings.slowModifier : 1;
			const speed = (appSettings.panoLookSpeed * 0.4 * dt) / slow;
			let dh = 0,
				dp = 0;
			if (held.has("panoLookLeft")) dh -= speed;
			if (held.has("panoLookRight")) dh += speed;
			if (held.has("panoLookUp")) dp += speed;
			if (held.has("panoLookDown")) dp -= speed;
			if (dh || dp) pano.nudge(dh, dp);
		},
	});
}
