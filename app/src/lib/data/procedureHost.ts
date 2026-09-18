/**
 * The surface a procedure module runs against: the global `mma` object and the values
 * that cross the boundary. Every host call is synchronous -- the guest blocks while the
 * host works, which is how `fetchMany` (never a loop over `fetch`) buys a procedure its
 * request concurrency.
 *
 * A procedure is an ES module bundled to one file. Its named exports are the entry
 * points: `request` + `map` (RequestMap), `map` (MapOnly) or `run` (Run), plus the
 * optional `query`. Every entry point receives the run's `{ fields, force, config }` as its
 * last argument. Rows arrive as `Location`s and `run`/`map` answer
 * with `Update<LocationPatch>`s under the `patch` sink, or `Update<T>` of the module's
 * own answer under `collect`.
 */

import type { PanoAnswer, PanoQuery } from "@/bindings.gen";

export interface ProcedureRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array | ArrayBuffer;
}

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

export interface ProcedureHost {
	fetch(req: ProcedureRequest): ProcedureResponse;
	fetchMany(reqs: ProcedureRequest[]): ProcedureResponse[];
	/** Every query resolved to its pano, aligned to `queries`: an id query over
	 *  GetMetadata (deduped, batched, bisection-retried), a search query over
	 *  SingleImageSearch. `skipped` is a query the host never answered: an aborted run,
	 *  or an id query whose id is empty. */
	panos(queries: PanoQuery[]): PanoAnswer[];
	classify(dataset: string, lat: number, lng: number): string | null;
	/** Locations within `radiusM` metres of a coordinate, nearest first, each carrying
	 *  whichever of `fields` it had. The host builds one index per (radius, fields) pair
	 *  and holds it for the run, so asking once per row is the intended use; varying
	 *  either argument mid-run rebuilds it. A location at the exact coordinate is
	 *  included, so a caller probing its own row drops itself by id, and a radius of 0
	 *  answers exactly that coordinate. Only a run has locations to search; a query that
	 *  asks throws. */
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
	/** Marks a row as failed rather than skipped. */
	fail(id: number): void;
	/** Delivers one partial result to the caller while the call is still running, under
	 *  an id of the procedure's choosing. Queries stream these to whoever asked; runs
	 *  discard them. */
	emit(id: number, value: unknown): void;
	aborted(): boolean;
}

declare global {
	/** Reachable inside a procedure module only. `fetch`, `fetchMany`, `panos` and
	 *  `sidecar` are detached outside `run` and `query`; calling one elsewhere throws. */
	const mma: ProcedureHost;
}
