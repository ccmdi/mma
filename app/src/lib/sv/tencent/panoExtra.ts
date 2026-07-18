import type { LocationSvExtra } from "@/lib/sv/providers/types";
import type { TencentPanoMeta } from "./api";

export function buildTencentExtra(meta: TencentPanoMeta): LocationSvExtra {
	const extra: LocationSvExtra = {
		countryCode: "CN",
		cameraType: "tencent",
		panoType: 0,
	};
	const d = meta.captureDate;
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	extra.imageDate = `${y}-${m}`;
	extra.datetime = Math.floor(d.getTime() / 1000);
	return extra;
}
