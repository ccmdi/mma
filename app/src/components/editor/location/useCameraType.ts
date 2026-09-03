import { isOfficialPano } from "@/lib/sv/panoId";
import { detectCameraType } from "@/lib/sv/getMetadata";
import { svMetadata } from "@/lib/sv/query";
import { PanoType } from "@/bindings.consts";
import { useAsyncSticky } from "@/lib/hooks/useAsync";
import type { CameraType } from "@/bindings.gen";
import type { Pano } from "@/types";

/** Camera type plus "unofficial", a display-only state that is never stored. */
export type FullCameraType = CameraType | "unofficial";

function cameraTypeOf(data: Pano): FullCameraType | null {
	return data.panoFrontend !== PanoType.Official ? "unofficial" : detectCameraType(data);
}

/** `known` is a pano already fetched; when it is the one asked about, the answer is
 *  synchronous. Otherwise the last answer holds while the request is in flight, so the
 *  badge never blanks between panos. */
export function useCameraType(panoId: string | null, known?: Pano | null): FullCameraType | null {
	const answer = known && known.pano === panoId ? known : null;
	return useAsyncSticky<FullCameraType | null>(() => {
		if (!panoId) return null;
		// Immediate check: a non-official pano ID is unofficial regardless of metadata.
		if (!isOfficialPano(panoId)) return "unofficial";
		if (answer) return cameraTypeOf(answer);
		return svMetadata([panoId]).then(([data]) => data && cameraTypeOf(data));
	}, [panoId, answer]);
}
