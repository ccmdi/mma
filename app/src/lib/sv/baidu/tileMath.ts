/** Baidu coverage tile math (BD09MC meters ↔ Baidu tile XY). */

const TILE_SIZE = 256;

/** BD09MC meters → fractional Baidu tile coordinates at Baidu zoom. */
export function baiduMetersToTile(x: number, y: number, zoom: number): [number, number] {
	const dpi = 2 ** (18 - zoom);
	return [x / dpi / TILE_SIZE, y / dpi / TILE_SIZE];
}

export { TILE_SIZE as BAIDU_TILE_PX };
