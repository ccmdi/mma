import { isOfficialPano } from "@/lib/sv/panoId";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { findPanoProvider, type PanoCameraBadge } from "@/lib/sv/panoProvider";
import { getLocationProvider } from "@/lib/sv/providers/types";
import { BAIDU_CAMERA_BADGE, baiduSpawnPanoId } from "@/lib/sv/baidu/session";
import { isBaiduPanoId } from "@/lib/sv/baidu/prefix";
import { TENCENT_CAMERA_BADGE, tencentSpawnPanoId } from "@/lib/sv/tencent/session";
import { isTencentPanoId } from "@/lib/sv/tencent/prefix";
import { PanoType } from "@/types";
import { useAsync } from "@/lib/hooks/useAsync";
import { useActiveLocation } from "@/store/useMapStore";
import { usePanoViewer } from "./PanoViewerContext";

/** Google SV camera generations (+ unofficial). Provider badges are separate. */
export type BuiltinCameraType =
	| "unofficial"
	| "gen1"
	| "gen2"
	| "gen4"
	| "badcam"
	| "tripod"
	| "trekker";

export type DisplayCameraBadge =
	| { source: "builtin"; type: BuiltinCameraType }
	| { source: "provider"; badge: PanoCameraBadge };

const BUILTIN_TYPES = new Set<string>([
	"gen1",
	"gen2",
	"gen4",
	"badcam",
	"tripod",
	"trekker",
]);

function asBuiltinCameraType(raw: unknown): BuiltinCameraType | null {
	if (typeof raw !== "string") return null;
	return BUILTIN_TYPES.has(raw) ? (raw as BuiltinCameraType) : null;
}

export function useCameraType(panoId: string | null): DisplayCameraBadge | null {
	const active = useActiveLocation();
	const { panoDates, dateState } = usePanoViewer();
	const provider = active ? findPanoProvider(active) : null;
	const isBaidu =
		(active != null && getLocationProvider(active) === "baidu") || isBaiduPanoId(panoId);
	const isTencent =
		(active != null && getLocationProvider(active) === "tencent") || isTencentPanoId(panoId);
	const providerId = isBaidu ? "baidu" : isTencent ? "tencent" : (provider?.id ?? "");
	const spawnId = active
		? isBaidu
			? baiduSpawnPanoId(active)
			: isTencent
				? tencentSpawnPanoId(active)
				: provider?.getSpawnPanoId
					? provider.getSpawnPanoId(active)
					: null
		: null;

	const fromDates =
		panoId != null
			? panoDates.find((d) => d.pano === panoId)?.cameraType ??
				(dateState.defaultEntry?.pano === panoId
					? dateState.defaultEntry.cameraType
					: undefined)
			: undefined;

	return useAsync<DisplayCameraBadge | null>(async () => {
		if (!panoId || !active) return null;

		if (isBaidu) return { source: "provider", badge: BAIDU_CAMERA_BADGE };
		if (isTencent) return { source: "provider", badge: TENCENT_CAMERA_BADGE };

		if (provider?.resolveCameraBadge) {
			const badge = provider.resolveCameraBadge(panoId, active, fromDates);
			if (badge) return { source: "provider", badge };
			// Provider owns the location but has no badge for this pano — don't fetch Google.
			if (provider.canHandle(active)) return null;
		}

		if (!isOfficialPano(panoId)) return { source: "builtin", type: "unofficial" };
		const [data] = await fetchSvMetadata([panoId]);
		if (!data?.extra) return null;
		if (data.extra.panoType !== PanoType.Official) {
			return { source: "builtin", type: "unofficial" };
		}
		const t = asBuiltinCameraType(data.extra.cameraType);
		return t ? { source: "builtin", type: t } : null;
	}, [panoId, providerId, spawnId, fromDates, active?.id, isBaidu, isTencent]).data;
}
