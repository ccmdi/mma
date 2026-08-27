import { isOfficialPano } from "@/lib/sv/panoId";
import { detectCameraType } from "@/lib/sv/getMetadata";
import { svMetadata } from "@/lib/sv/query";
import { PanoType } from "@/bindings.consts";
import { useAsync } from "@/lib/hooks/useAsync";
import type { CameraType } from "@/bindings.gen";

/** Camera type plus "unofficial", a display-only state that is never stored. */
export type FullCameraType = CameraType | "unofficial";

export function useCameraType(panoId: string | null): FullCameraType | null {
	return useAsync<FullCameraType | null>(() => {
		if (!panoId) return null;
		// Immediate check: a non-official pano ID is unofficial regardless of metadata.
		if (!isOfficialPano(panoId)) return "unofficial";
		return svMetadata([panoId]).then(([data]) => {
			if (!data) return null;
			if (data.panoFrontend !== PanoType.Official) return "unofficial";
			return detectCameraType(data);
		});
	}, [panoId]).data;
}
