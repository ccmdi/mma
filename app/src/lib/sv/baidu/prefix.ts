/** Baidu pano id namespace — matches altproviders.js `BAIDU:` prefix. */

export const BAIDU_PANO_PREFIX = "BAIDU:";

export function isBaiduPanoId(panoId: string | null | undefined): boolean {
	return typeof panoId === "string" && panoId.startsWith(BAIDU_PANO_PREFIX);
}

export function stripBaidu(panoId: string): string {
	return panoId.startsWith(BAIDU_PANO_PREFIX)
		? panoId.slice(BAIDU_PANO_PREFIX.length)
		: panoId;
}

export function prefixBaidu(panoId: string): string {
	const raw = stripBaidu(panoId);
	return raw ? `${BAIDU_PANO_PREFIX}${raw}` : "";
}
