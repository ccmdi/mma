import type { LocationSvExtra } from "@/lib/sv/providers/types";
import type { BaiduPanoMeta } from "./api";

/** YYYYMMDD → `YYYY-MM` for Google-semantic imageDate. */
export function baiduDateToImageDate(date: string): string | undefined {
	if (!date || date.length < 6) return undefined;
	const y = date.slice(0, 4);
	const m = date.slice(4, 6);
	if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m)) return undefined;
	return `${y}-${m}`;
}

export function baiduDateToUnix(date: string): number | undefined {
	if (!date || date.length < 8) return undefined;
	const y = Number(date.slice(0, 4));
	const m = Number(date.slice(4, 6));
	const d = Number(date.slice(6, 8));
	if (!y || !m || !d) return undefined;
	return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}

export function buildBaiduExtra(meta: BaiduPanoMeta): LocationSvExtra {
	const extra: LocationSvExtra = {
		countryCode: "CN",
		cameraType: "baidu",
		panoType: 0,
	};
	const imageDate = baiduDateToImageDate(meta.date);
	if (imageDate) extra.imageDate = imageDate;
	const ts = baiduDateToUnix(meta.date);
	if (ts != null) extra.datetime = ts;
	if (meta.altitude != null && Number.isFinite(meta.altitude)) {
		extra.altitude = meta.altitude;
	}
	// Rname is the road name — belongs in panorama description, not uploaderName.
	return extra;
}
