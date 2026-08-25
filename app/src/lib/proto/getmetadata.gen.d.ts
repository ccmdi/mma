/* Types for the pbf-generated reader (getmetadata.gen.js). The message shapes are
 * generated from getmetadata.proto; both readers decode into the same objects.
 * Regenerate both with `npm run proto:gen`. */
import type { PbfReader, PbfWriter } from "pbf";
export type {
	GetMetadataRequest,
	ResponseStatus,
	ImageStatus,
	ImageKey,
	ImageSize,
	ImageTileSize,
	ImageTiles,
	LocalizedText,
	ImageDescription,
	ImageAttribution,
	LatLng,
	PanoLocation,
	Pano,
	PanoLink,
	PanoDate,
	PanoTime,
	ImageInformation,
	ImageDate,
	ImageMetadata,
	GetMetadataResponse,
} from "./getmetadata.array.gen";

export function readGetMetadataResponse(pbf: PbfReader, end?: number): GetMetadataResponse;
export function readImageMetadata(pbf: PbfReader, end?: number): ImageMetadata;
export function readGetMetadataRequest(pbf: PbfReader, end?: number): GetMetadataRequest;
export function writeGetMetadataRequest(obj: GetMetadataRequest, pbf: PbfWriter): void;
