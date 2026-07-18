/** Shared types for Google / Baidu / Look Around panorama download. */

export type PanoRenderMode = "equirectangular" | "perspective" | "thumbnail" | "tile";

export interface PanoDownloadConfig {
	mode: PanoRenderMode;
	zoom: number;
	tileX: number;
	tileY: number;
}

export interface RenderedPanoImage {
	blob: Blob;
	fileName: string;
}
