import { schemeBase } from "@/lib/util/util";
import type { GgDraftSummary, GgPublishedSummary } from "./remote-types";

/**
 * GeoGuessr's API cannot be called from the webview: it has no permissive CORS and its session
 * lives in an HttpOnly `_ncfa` cookie. Every request therefore goes through the Rust `ggapi`
 * scheme proxy, which attaches the cookie and relays the response verbatim (status included).
 */
const base = (): string => schemeBase("ggapi");

export class GeoGuessrApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "GeoGuessrApiError";
		this.status = status;
	}
}

/** No session, or the session was rejected. The caller should prompt for a fresh sign-in. */
export const isUnauthorized = (e: unknown): boolean =>
	e instanceof GeoGuessrApiError && e.status === 401;

async function requestRaw(path: string, init: RequestInit = {}): Promise<Response> {
	const res = await fetch(new URL(path.replace(/^\//, ""), base()), init);
	if (!res.ok) {
		let message = `GeoGuessr request failed with HTTP ${res.status}`;
		try {
			const body: unknown = await res.json();
			if (
				body &&
				typeof body === "object" &&
				typeof (body as { message?: unknown }).message === "string"
			)
				message = (body as { message: string }).message;
		} catch {
			// Non-JSON error bodies (an HTML error page) leave the default message.
		}
		throw new GeoGuessrApiError(message, res.status);
	}
	return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	return (await (await requestRaw(path, init)).json()) as T;
}

/** Every draft the user owns, published or not. Unpaginated. */
export function listDrafts(signal?: AbortSignal): Promise<GgDraftSummary[]> {
	return request<GgDraftSummary[]>("/api/v4/user-maps/drafts", { signal });
}

/**
 * The user's maps as published entities. Only used to spot maps that have no draft yet -- older
 * maps predate the draft system, and sync has nothing to write to until one exists.
 */
export function listPublished(signal?: AbortSignal): Promise<GgPublishedSummary[]> {
	return request<GgPublishedSummary[]>("/api/v4/user-maps/maps", { signal });
}
