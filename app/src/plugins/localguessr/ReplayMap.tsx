import { useEffect, useRef } from "react";
import { boundsOfCoords, type MapHost } from "@/lib/map/host";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { MAP_EMBED_PREFS } from "@/store/mapEmbedPrefs";
import type { RoundResult } from "./game";
import { replayLayers, useGameMap, useSettledZoom, type ReplayPin } from "./gameMap";

export function ReplayMap({
	results,
	highlighted,
	onOpenRound,
}: {
	results: RoundResult[];
	highlighted: number | null;
	onOpenRound: (round: number) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [prefs] = useLocalStorage(MAP_EMBED_PREFS);
	const onOpenRoundRef = useRef(onOpenRound);
	onOpenRoundRef.current = onOpenRound;

	const frame = (host: MapHost) => {
		host.resize();
		const bounds = boundsOfCoords(
			results.flatMap((r) => (r.guess ? [r.location, r.guess] : [r.location])),
		);
		if (!bounds) return;
		if (bounds.west === bounds.east && bounds.south === bounds.north) {
			host.moveCamera({ center: { lat: bounds.south, lng: bounds.west }, zoom: 10 });
		} else {
			host.fitBounds(bounds, 60);
		}
	};

	const { hostRef, overlayRef, ready } = useGameMap(
		containerRef,
		{ ...prefs, svPanoramas: false, svVisible: false },
		{ onReady: frame },
	);
	const settledZoom = useSettledZoom(hostRef, ready);

	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay || !ready) return;
		overlay.setProps({
			layers: replayLayers(results, highlighted, settledZoom),
			onClick: (info) => {
				const pin = info.object as ReplayPin | undefined;
				if (pin) onOpenRoundRef.current(pin.round);
			},
			onHover: (info) => hostRef.current?.setCursor(info.object ? "pointer" : null),
		});
	}, [hostRef, overlayRef, ready, results, highlighted, settledZoom]);

	return (
		<div className="lg-summary__map">
			<div ref={containerRef} className="lg-summary__map-canvas" data-qa="replay-map" />
		</div>
	);
}
