/** deck.gl binary data for a packed `[lng, lat, ...]` buffer: one point per pair. */
export function packedPositions(positions: Float32Array) {
	return {
		length: positions.length / 2,
		attributes: { getPosition: { value: positions, size: 2 } },
	};
}
