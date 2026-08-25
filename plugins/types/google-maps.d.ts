// Augment @types/google.maps with undocumented fields that opensv (patched Google Maps v3.63) exposes.

/** Shorthand for the full `typeof google` namespace provided by opensv. */
type Google = typeof google;

interface TileCoord {
	x: number;
	y: number;
}
