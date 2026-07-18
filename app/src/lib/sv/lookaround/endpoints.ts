/**
 * Look Around network endpoints.
 *
 * Metadata, coverage tiles, and pano faces are fetched from lookmap.skzk.dev
 * (CORS-enabled). The Photo Sphere Viewer + Look Around adapter are bundled
 * locally — they no longer load from the public lookmap CDN.
 */

/** Public lookmap origin (tiles + `/closest` + `/pano/...`). */
export const LOOKMAP_ORIGIN = "https://lookmap.skzk.dev";
