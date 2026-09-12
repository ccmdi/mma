import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createLocation } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import { pano } from "@/lib/sv/pano";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import type { PanoView as PanoRef } from "@/types";
import type { CameraFrame } from "@/bindings.gen";
import { t } from "@/lib/i18n";
import type { MovementMode, RoundLocation } from "./game";

export interface PanoHandle {
	returnToSpawn: () => void;
	pointNorth: () => void;
	setCheckpoint: () => boolean;
	returnToCheckpoint: () => boolean;
}

function toLocation(round: RoundLocation) {
	return createLocation({
		...round,
		flags: round.panoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
	});
}

function movementOptions(mode: MovementMode): google.maps.StreetViewPanoramaOptions {
	const moving = mode === "moving";
	return {
		linksControl: moving,
		clickToGo: moving,
		scrollwheel: mode !== "nmpz",
		addressControl: false,
		zoomControl: false,
		fullscreenControl: false,
		showRoadLabels: false,
		enableCloseButton: false,
	};
}

/**
 * The round's Street View. Holds the shared pano for the whole game and
 * swaps pano content per round -- reparenting it every round loses the WebGL context,
 * which white-screens the editor preview too.
 */
export function PanoView({
	round,
	movementMode,
	preload,
	onShown,
	ref,
}: {
	round: RoundLocation;
	movementMode: MovementMode;
	/** Next round to warm while this one is hidden. Null outside the result phase. */
	preload?: RoundLocation | null;
	onShown?: (shown: boolean) => void;
	ref?: React.Ref<PanoHandle>;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const spawnRef = useRef(round);
	spawnRef.current = round;
	const checkpointRef = useRef<(CameraFrame & Pick<PanoRef, "panoId">) | null>(null);

	useImperativeHandle(
		ref,
		() => ({
			returnToSpawn: () => {
				const spawn = spawnRef.current;
				pano.jump(spawn.panoId || { lat: spawn.lat, lng: spawn.lng }, {
					heading: spawn.heading,
					pitch: spawn.pitch,
				});
			},
			pointNorth: pano.pointNorth,
			setCheckpoint: () => {
				const panoId = pano.panoId();
				if (!panoId) return false;
				checkpointRef.current = { panoId, ...pano.pov() };
				return true;
			},
			returnToCheckpoint: () => {
				const cp = checkpointRef.current;
				if (!cp) return false;
				pano.jump(cp.panoId, { heading: cp.heading, pitch: cp.pitch });
				checkpointRef.current = null;
				return true;
			},
		}),
		[],
	);

	// Borrow the pano for the game, then hand it back with its WebGL context intact.
	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const release = pano.mount(host);
		return () => {
			release();
			onShown?.(false);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- borrow for the whole game
	}, []);

	useEffect(() => {
		let cancelled = false;
		setError(null);
		checkpointRef.current = null;

		void (async () => {
			await loadOpenSV();
			if (cancelled) return;
			if (!google?.maps) {
				setError(t("Street View unavailable"));
				return;
			}
			const shown = await pano.show(toLocation(round));
			if (cancelled || shown.status === "superseded") return;
			if (!shown.pano?.id) {
				setError(t("No panorama found here"));
				return;
			}
			pano.configure(movementOptions(movementMode));
			onShown?.(true);
		})();

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- movement is applied separately
	}, [round]);

	// Warm the next round on the hidden pano so Next reveals rather than loads.
	useEffect(() => {
		if (!preload) return;
		let cancelled = false;
		void loadOpenSV().then(() => {
			if (!cancelled) void pano.preload(toLocation(preload));
		});
		return () => {
			cancelled = true;
		};
	}, [preload]);

	useEffect(() => {
		pano.configure(movementOptions(movementMode));
	}, [movementMode]);

	return (
		<div className="lg-pano">
			<div ref={hostRef} className="lg-pano__host" />
			{movementMode === "nmpz" && <div className="lg-pano__shield" aria-hidden="true" />}
			{error && <div className="lg-pano__error">{error}</div>}
		</div>
	);
}
