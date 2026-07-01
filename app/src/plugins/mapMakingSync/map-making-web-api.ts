import { PbfReader } from "pbf";
import {
	readRemoteLocationsResponse,
	type RemoteLocation as ProtoLocation,
} from "./proto/remote-locations.gen";
import * as Remote from "./remote-types";

export * as Remote from "./remote-types";

export const MAP_MAKING_WEB_API_BASE_URL = "https://map-making.app";

export interface MapMakingWebApiOptions {
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}

export class MapMakingWebApiError extends Error {
	readonly status: number;
	readonly response: Response;
	readonly body: unknown;

	constructor(message: string, response: Response, body: unknown) {
		super(message);
		this.name = "MapMakingWebApiError";
		this.status = response.status;
		this.response = response;
		this.body = body;
	}
}

export class MapMakingWebApi {
	private readonly apiKey: string;
	private readonly baseUrl: URL;
	private readonly fetchImpl: typeof fetch;

	constructor(options: MapMakingWebApiOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = new URL(options.baseUrl ?? MAP_MAKING_WEB_API_BASE_URL);
		// Native fetch throws "Illegal invocation" if called as a method (this !== window),
		// so bind the default to the global. A supplied fetchImpl is used as-is.
		this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
	}

	async getUser(signal?: AbortSignal): Promise<Remote.User> {
		return await this.getJson<Remote.User>("/api/user", { signal });
	}

	async getMaps(signal?: AbortSignal): Promise<Remote.Map[]> {
		return await this.getJson<Remote.Map[]>("/api/maps", { signal });
	}

	async getMap(mapId: number, signal?: AbortSignal): Promise<Remote.Map> {
		return await this.getJson<Remote.Map>(`/api/maps/${mapId}`, { signal });
	}

	async createMap(body: Remote.CreateMapRequest, signal?: AbortSignal): Promise<Remote.Map> {
		return await this.requestJson<Remote.Map>("/api/maps", {
			method: "POST",
			body,
			signal,
		});
	}

	async updateMap(
		mapId: number,
		body: Remote.UpdateMapRequest,
		signal?: AbortSignal,
	): Promise<Remote.Map> {
		return await this.requestJson<Remote.Map>(`/api/maps/${mapId}`, {
			method: "PUT",
			body,
			signal,
		});
	}

	async getLocationsJson(mapId: number, signal?: AbortSignal): Promise<Remote.Location[]> {
		return await this.getJson<Remote.Location[]>(`/api/maps/${mapId}/locations`, { signal });
	}

	async getLocationsProtobuf(mapId: number, signal?: AbortSignal): Promise<Remote.Location[]> {
		const response = await this.request(`/api/maps/${mapId}/locations`, {
			headers: { accept: "application/protobuf" },
			signal,
		});
		return parseRemoteLocationsProtobuf(await response.arrayBuffer());
	}

	/**
	 * Apply a batch of edits. Returns a map of each submitted id (often a negative
	 * placeholder) to the id MMA assigned. This is the only tag-write channel for
	 * API-key clients: tag membership rides on each location's `tags` names.
	 */
	async editLocations(
		mapId: number,
		body: Remote.LocationEditRequest,
		signal?: AbortSignal,
	): Promise<Remote.LocationEditResult> {
		return await this.requestJson<Remote.LocationEditResult>(`/api/maps/${mapId}/locations`, {
			method: "POST",
			body,
			signal,
		});
	}

	private async getJson<T>(
		path: string,
		init: Omit<ApiRequestInit, "method" | "body"> = {},
	): Promise<T> {
		return await this.requestJson<T>(path, { ...init, method: "GET" });
	}

	private async requestJson<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
		const response = await this.request(path, init);
		return (await response.json()) as T;
	}

	private async request(path: string, init: ApiRequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("authorization", `API ${this.apiKey}`);
		if (!headers.has("accept")) headers.set("accept", "application/json");

		let body: BodyInit | undefined;
		if (init.body !== undefined) {
			headers.set("content-type", "application/json");
			body = JSON.stringify(init.body);
		}

		const response = await this.fetchImpl(new URL(path, this.baseUrl), {
			method: init.method ?? "GET",
			headers,
			body,
			signal: init.signal,
		});

		if (!response.ok) throw await makeApiError(response);
		return response;
	}
}

interface ApiRequestInit {
	method?: string;
	headers?: HeadersInit;
	body?: unknown;
	signal?: AbortSignal;
}

async function makeApiError(response: Response): Promise<MapMakingWebApiError> {
	let body: unknown;
	let message = `map-making.app API request failed with HTTP ${response.status}`;
	try {
		body = await response.clone().json();
		if (isObject(body) && typeof body.message === "string") message = body.message;
	} catch {
		try {
			const text = await response.text();
			body = text;
			if (text) message = text;
		} catch {
			body = undefined;
		}
	}
	return new MapMakingWebApiError(message, response, body);
}

function parseRemoteLocationsProtobuf(buf: ArrayBuffer): Remote.Location[] {
	const response = readRemoteLocationsResponse(new PbfReader(buf));
	return response.location.map((location) => protoLocationToRemote(location, response.tag));
}

function protoLocationToRemote(location: ProtoLocation, tags: string[]): Remote.Location {
	return {
		id: location.id,
		author: location.author,
		location: location.location ?? { lat: 0, lng: 0 },
		panoId: location.panoId || null,
		heading: location.heading,
		pitch: location.pitch,
		zoom: location.zoom,
		createdAt: new Date(location.createdAt * 1000).toISOString(),
		panoDate: location.panoDate ? new Date(location.panoDate * 1000).toISOString() : null,
		flags: location.flags,
		tags: location.tagIndex.flatMap((index) => tags[index] ?? []),
	};
}

function isObject(value: unknown): value is { message?: unknown } {
	return typeof value === "object" && value !== null;
}
