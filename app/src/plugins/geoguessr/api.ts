import { schemeBase } from "@/lib/util/util";
import type { GgDraft, GgDraftWrite, GgMapSummary, GgWriteResult } from "./remote-types";

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

/** The draft moved under us: someone edited the map on geoguessr.com since we pulled. */
export const isVersionConflict = (e: unknown): boolean =>
	e instanceof GeoGuessrApiError && (e.status === 409 || e.status === 412);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
	return (await res.json()) as T;
}

export function listDrafts(signal?: AbortSignal): Promise<GgMapSummary[]> {
	return request<GgMapSummary[]>("/api/v3/profiles/maps", { signal });
}

export function getDraft(mapId: string, signal?: AbortSignal): Promise<GgDraft> {
	return request<GgDraft>(`/api/v4/user-maps/drafts/${mapId}`, { signal });
}

/**
 * Replace the draft's locations. `version` must be exactly the version we read plus one -- that
 * is the whole concurrency story, so it is deliberately NOT re-read immediately before writing.
 * A stale version means someone edited on geoguessr.com since our pull, and the write must fail
 * rather than silently clobber them.
 *
 * A partial body is accepted: name, description, avatar and tags are left untouched.
 */
export async function putDraftCoordinates(
	mapId: string,
	body: GgDraftWrite,
	signal?: AbortSignal,
): Promise<void> {
	const res = await request<GgWriteResult>(`/api/v4/user-maps/drafts/${mapId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	// A 200 whose message is not "OK" is still a failure; the endpoint reports that way.
	if (res.message !== "OK") throw new GeoGuessrApiError(res.message || "draft write rejected", 200);
}
