/** Tencent pano id namespace — matches altproviders.js `TENCENT:` prefix. */

export const TENCENT_PANO_PREFIX = "TENCENT:";

export function isTencentPanoId(panoId: string | null | undefined): boolean {
	return typeof panoId === "string" && panoId.startsWith(TENCENT_PANO_PREFIX);
}

export function stripTencent(panoId: string): string {
	return panoId.startsWith(TENCENT_PANO_PREFIX)
		? panoId.slice(TENCENT_PANO_PREFIX.length)
		: panoId;
}

export function prefixTencent(panoId: string): string {
	const raw = stripTencent(panoId);
	return raw ? `${TENCENT_PANO_PREFIX}${raw}` : "";
}
