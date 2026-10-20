/**
 * The global `mma` API available inside procedure modules. Calls are synchronous;
 * pass request lists for concurrency. `map` and `run` receive locations;
 * `query` handles read-only requests. Each entry point receives `{ fields, force, config }`.
 * Results are location patches under `patch`, or module-defined answers under `collect`.
 */

import type { PanoAnswer, PanoQuery } from "@/bindings.gen";

/** @api */
export interface ProcedureRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array | ArrayBuffer;
}

/** @api */
export interface ProcedureResponse {
	/** 0 when the host could not issue the request at all. */
	status: number;
	body: Uint8Array;
}

export interface ProcedureNeighbor {
	id: number;
	lat: number;
	lng: number;
	distM: number;
	[field: string]: unknown;
}

/** @api */
export interface ProcedureHost {
	/** One request, or every request of a list at once, answered in order. A single
	 *  request that cannot be issued throws; inside a list it answers `status: 0`, so the
	 *  rest survive. */
	fetch(req: ProcedureRequest): ProcedureResponse;
	fetch(reqs: ProcedureRequest[]): ProcedureResponse[];
	/** Resolve pano ids or coordinate searches, returning answers in input order.
	 *  `skipped` means the run was aborted or the requested id was empty. */
	panos(queries: PanoQuery[]): PanoAnswer[];
	classify(dataset: string, lat: number, lng: number): string | null;
	/** Nearby run locations, nearest first, with the requested fields when present.
	 *  Includes the queried location itself; radius 0 matches exact coordinates.
	 *  Keep radius and fields constant to reuse the index. Unavailable in queries. */
	neighbors(lat: number, lng: number, radiusM: number, fields?: string[]): ProcedureNeighbor[];
	/** Run one sidecar command. `onLine` sees each output line as it arrives, so a
	 *  procedure can report progress mid-run; the lines are also returned together. */
	sidecar(
		pluginId: string,
		command: string,
		payloadJson: string,
		onLine?: (line: string) => void,
	): string[];
	/** 0 debug, 1 info, 2 warn, 3 error. `console.*` routes here. */
	log(level: number, msg: string): void;
	progress(units: number): void;
	/** IANA timezone at a coordinate, or null outside the valid range. Pure compute,
	 *  available to every procedure shape. @unstable */
	tz(lat: number, lng: number): string | null;
	/** Marks a location as failed rather than skipped. */
	fail(id: number): void;
	/** Delivers one partial result to the caller while the call is still running, under
	 *  an id of the procedure's choosing. Queries stream these to whoever asked; runs
	 *  discard them. */
	emit(id: number, value: unknown): void;
	aborted(): boolean;
}

declare global {
	/** Reachable inside a procedure module only. `fetch`, `panos` and `sidecar` are
	 *  detached outside `run` and `query`; calling one elsewhere throws. */
	const mma: ProcedureHost;
}
