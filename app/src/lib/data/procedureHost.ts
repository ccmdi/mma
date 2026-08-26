/**
 * The surface a procedure module runs against: the global `mma` object and the values
 * that cross the boundary. Every host call is synchronous -- the guest blocks while the
 * host works, which is how `fetchMany` (never a loop over `fetch`) buys a procedure its
 * request concurrency.
 *
 * A procedure is an ES module bundled to one file. Its named exports are the entry
 * points: `request` + `map` (RequestMap), `map` (MapOnly) or `run` (Run), plus the
 * optional `query` and `configure`. Rows arrive as `Location`s and `run`/`map` answer
 * with `Update<LocationPatch>`s under the `patch` sink, or `Update<T>` of the module's
 * own answer under `collect`.
 */

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

export interface ProcedureHost {
	fetch(req: ProcedureRequest): ProcedureResponse;
	fetchMany(reqs: ProcedureRequest[]): ProcedureResponse[];
	classify(dataset: string, lat: number, lng: number): string | null;
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
	/** Marks a row as failed rather than skipped. */
	fail(id: number): void;
	aborted(): boolean;
}

declare global {
	/** Reachable inside a procedure module only. `fetch`, `fetchMany` and `sidecar` are
	 *  detached outside `run` and `query`; calling one elsewhere throws. */
	const mma: ProcedureHost;
}
