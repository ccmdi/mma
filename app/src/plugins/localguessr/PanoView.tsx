import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createLocation } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import { getPanorama, singletonDiv, applyResolved } from "@/lib/sv/panoSingleton";
import { tweenPov } from "@/lib/sv/tweenPov";
import { normalizeHeading } from "@/lib/geo/geo";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { resolvePano } from "@/lib/sv/lookup";
import type { CameraFrame, Pano, PanoView as PanoRef } from "@/types";
import { t } from "@/lib/i18n";
import type { MovementMode, RoundLocation } from "./game";

export interface PanoHandle {
	returnToSpawn: () => void;
	pointNorth: () => void;
	setCheckpoint: () => boolean;
	returnToCheckpoint: () => boolean;
	getPanorama: () => google.maps.StreetViewPanorama | null;
}

function toLocation(round: RoundLocation) {
	return createLocation({
		...round,
		flags: round.panoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
	});
}

function applyMovement(pano: google.maps.StreetViewPanorama, mode: MovementMode) {
	const moving = mode === "moving";
	pano.setOptions({
		linksControl: moving,
		clickToGo: moving,
		scrollwheel: mode !== "nmpz",
		addressControl: false,
		zoomControl: false,
		fullscreenControl: false,
		showRoadLabels: false,
		enableCloseButton: false,
	});
}

/**
 * The round's Street View. Holds the shared singleton canvas for the whole game and
 * swaps pano content per round -- reparenting it every round loses the WebGL context,
 * which white-screens the editor preview too.
 */
export function PanoView({
	round,
	movementMode,
	preload,
	onPanorama,
	ref,
}: {
	round: RoundLocation;
	movementMode: MovementMode;
	/** Next round to warm while this one is hidden. Null outside the result phase. */
	preload?: RoundLocation | null;
	onPanorama?: (pano: google.maps.StreetViewPanorama | null) => void;
	ref?: React.Ref<PanoHandle>;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	// Derived: an effect-set flag flips a frame late, showing the previous location.
	const [revealed, setRevealed] = useState<RoundLocation | null>(null);
	const loading = revealed !== round;
	const spawnRef = useRef(round);
	spawnRef.current = round;
	const stagedRef = useRef<{ round: RoundLocation; resolved: Pano | null } | null>(null);
	const cancelTweenRef = useRef<(() => void) | null>(null);
	const checkpointRef = useRef<(CameraFrame & Pick<PanoRef, "panoId">) | null>(null);

	useImperativeHandle(
		ref,
		() => ({
			returnToSpawn: () => {
				const pano = getPanorama();
				const spawn = spawnRef.current;
				if (!pano) return;
				if (spawn.panoId) pano.setPano(spawn.panoId);
				else pano.setPosition({ lat: spawn.lat, lng: spawn.lng });
				pano.setPov({ heading: spawn.heading, pitch: spawn.pitch });
			},
			pointNorth: () => {
				const pano = getPanorama();
				if (!pano) return;
				cancelTweenRef.current?.();
				const pov = pano.getPov();
				const isNorth = Math.abs(normalizeHeading(pov.heading)) < 2;
				// Second press: top-down and fully zoomed out, for lining up with the map.
				if (isNorth) pano.setZoom(0);
				const target = isNorth ? { heading: 0, pitch: -90 } : { heading: 0, pitch: pov.pitch };
				cancelTweenRef.current = tweenPov(pano, target);
			},
			setCheckpoint: () => {
				const pano = getPanorama();
				if (!pano) return false;
				const pov = pano.getPov();
				checkpointRef.current = { panoId: pano.getPano(), heading: pov.heading, pitch: pov.pitch };
				return true;
			},
			returnToCheckpoint: () => {
				const pano = getPanorama();
				const cp = checkpointRef.current;
				if (!pano || !cp) return false;
				pano.setPano(cp.panoId);
				pano.setPov({ heading: cp.heading, pitch: cp.pitch });
				checkpointRef.current = null;
				return true;
			},
			getPanorama,
		}),
		[],
	);

	// Borrow the singleton for the game, then hand it back with its WebGL context intact.
	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const previousParent = singletonDiv.parentElement;
		singletonDiv.style.width = "100%";
		singletonDiv.style.height = "100%";
		host.appendChild(singletonDiv);
		return () => {
			if (previousParent) previousParent.appendChild(singletonDiv);
			else singletonDiv.remove();
			const pano = getPanorama();
			if (pano && google?.maps) {
				pano.setVisible(true);
				google.maps.event.trigger(pano, "resize");
			}
			onPanorama?.(null);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- borrow for the whole game
	}, []);

	// Covered until this round's pano reports OK; the singleton still shows the last one.
	useEffect(() => {
		let cancelled = false;
		let listener: google.maps.MapsEventListener | null = null;
		setError(null);
		checkpointRef.current = null;

		void (async () => {
			await loadOpenSV();
			if (cancelled) return;
			const pano = getPanorama();
			if (!google?.maps || !pano) {
				setError(t("Street View unavailable"));
				return;
			}
			const loc = toLocation(round);
			// Warmed during the previous result: skip the lookup entirely.
			const staged = stagedRef.current;
			stagedRef.current = null;
			const resolved = staged?.round === round ? staged.resolved : await resolvePano(loc);
			if (cancelled) return;
			if (!resolved?.pano) {
				setError(t("No panorama found here"));
				return;
			}

			applyResolved(pano, resolved, loc);
			applyMovement(pano, movementMode);
			google.maps.event.trigger(pano, "resize");
			onPanorama?.(pano);

			const target = resolved.pano;
			const reveal = () => {
				if (cancelled || pano.getStatus() !== "OK") return;
				// status_changed also fires for the outgoing pano mid-swap.
				const live = pano.getPano();
				if (target && live && live !== target) return;
				setRevealed(round);
			};
			listener = pano.addListener("status_changed", reveal);
			reveal();
		})();

		return () => {
			cancelled = true;
			listener?.remove();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- movement is applied separately
	}, [round]);

	// Warm the next round on the hidden singleton so Next reveals rather than loads.
	// Not applyResolved: its sv.focus() would steal focus and break Space-to-continue.
	useEffect(() => {
		if (!preload) return;
		let cancelled = false;
		void (async () => {
			await loadOpenSV();
			if (cancelled || !google?.maps) return;
			const pano = getPanorama();
			if (!pano) return;
			const resolved = await resolvePano(toLocation(preload));
			if (cancelled || !resolved?.pano) return;
			stagedRef.current = { round: preload, resolved };
			pano.setPano(resolved.pano);
			pano.setPov({ heading: preload.heading, pitch: preload.pitch });
		})();
		return () => {
			cancelled = true;
		};
	}, [preload]);

	useEffect(() => {
		const pano = getPanorama();
		if (pano) applyMovement(pano, movementMode);
	}, [movementMode]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const observer = new ResizeObserver(() => {
			const pano = getPanorama();
			if (pano && google?.maps) google.maps.event.trigger(pano, "resize");
		});
		observer.observe(host);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="lg-pano">
			<div ref={hostRef} className="lg-pano__host" />
			{movementMode === "nmpz" && <div className="lg-pano__shield" aria-hidden="true" />}
			{!error && (
				<div className={`lg-pano__loading${loading ? "" : " is-revealed"}`} aria-hidden="true" />
			)}
			{error && <div className="lg-pano__error">{error}</div>}
		</div>
	);
}
