/* Types for the pbf-generated reader (remote-locations.gen.js).
 * Regenerate the .js with `npm run proto:gen`, then keep these declarations in sync.
 */
import type { PbfReader, PbfWriter } from "pbf";

export interface RemoteLocationsResponse {
	tag: string[];
	location: RemoteLocation[];
}

export interface RemoteLocation {
	id: number;
	author: number;
	location?: RemoteLatLng;
	panoId: string;
	heading: number;
	pitch: number;
	zoom: number;
	tagIndex: number[];
	flags: number;
	createdAt: number;
	panoDate: number;
}

export interface RemoteLatLng {
	lat: number;
	lng: number;
}

export function readRemoteLocationsResponse(pbf: PbfReader, end?: number): RemoteLocationsResponse;
export function writeRemoteLocationsResponse(obj: RemoteLocationsResponse, pbf: PbfWriter): void;
export function readRemoteLocation(pbf: PbfReader, end?: number): RemoteLocation;
export function writeRemoteLocation(obj: RemoteLocation, pbf: PbfWriter): void;
export function readRemoteLatLng(pbf: PbfReader, end?: number): RemoteLatLng;
export function writeRemoteLatLng(obj: RemoteLatLng, pbf: PbfWriter): void;
