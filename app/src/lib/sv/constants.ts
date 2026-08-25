import { range } from "@/types/util";

export const SV_SEARCH_RADIUS = 50;
/** GetMetadata requests a procedure may keep in flight, at up to 200 panos each. */
export const GET_METADATA_INFLIGHT = 48;
/** SingleImageSearch location lookups a procedure may keep in flight, one pano each. */
export const LOCATION_SEARCH_INFLIGHT = 128;
export const SV_JUMP_RADIUS = 100;

export const PANO_ZOOM = range([-3, 4]);
export const PANO_PITCH = range([-90, 90]);

/** Stored -> live pano zoom: 0 (unset) renders fully zoomed out for the current viewport. */
export const displayZoom = (stored: number) => (stored === 0 ? PANO_ZOOM.min : stored);
/** Live -> stored pano zoom: the fully-out floor collapses to 0 (unset); partial zooms persist. */
export const storedZoom = (display: number) => (display <= PANO_ZOOM.min ? 0 : display);
/** One zoom step in: fully-out returns to 0, then the 0..4 grid. */
export const zoomInStep = (z: number) => (z < 0 ? 0 : Math.min(PANO_ZOOM.max, z + 1));
/** One zoom step out: down the grid to 0, then fully out. */
export const zoomOutStep = (z: number) => (z <= 0 ? PANO_ZOOM.min : z - 1);

export const BLOBBY_ZOOM_THRESHOLD = 13;

export const FRAME_MS = 16.667;
