import { schemeBase } from "@/lib/util/util";
import { isOfficialPano } from "@/lib/sv/panoId";
import { hasLoadAsPanoId, type PanoView } from "@/types";
import type { Location, Tag } from "@/bindings.gen";

/** View the link should open at. */
export type MapsPanoView = PanoView & Pick<Location, "lat" | "lng">;

function fovForZoom(zoom: number): number {
	return (360 / Math.PI) * Math.atan(0.75 * Math.pow(2, 1 - zoom));
}

/** A google.com/maps Street View link aimed at `view`. Official panos embed a thumbnail
 *  (`!6s`) so the link unfurls with a preview; unofficial ones have none to point at. */
export function mapsPanoUrl(view: MapsPanoView): URL {
	const { lat, lng, heading, pitch, panoId } = view;
	const fov = fovForZoom(view.zoom);

	let data: string;
	if (isOfficialPano(panoId)) {
		const thumb = new URL("https://streetviewpixels-pa.googleapis.com/v1/thumbnail");
		thumb.searchParams.set("panoid", panoId);
		thumb.searchParams.set("cb_client", "maps_sv.share");
		thumb.searchParams.set("w", "900");
		thumb.searchParams.set("h", "600");
		thumb.searchParams.set("yaw", String(heading));
		thumb.searchParams.set("pitch", String(-pitch));
		thumb.searchParams.set("thumbfov", fov.toFixed(0));
		data = `!3m5!1e1!3m3!1s${panoId}!2e0!6s${encodeURIComponent(thumb.toString())}`;
	} else {
		data = `!3m4!1e1!3m2!1s${panoId}!2e0`;
	}

	const url = new URL(
		`https://www.google.com/maps/@${lat},${lng},3a,${fov.toFixed(1)}y,${heading.toFixed(2)}h,${(pitch + 90).toFixed(2)}t/data=${data}`,
	);
	url.searchParams.set("coh", "235716");
	url.searchParams.set("entry", "tts");
	return url;
}

/** Carry a location's tags (and its lat/lng load mode) on the link, so importing it back
 *  reconstructs them. */
export function appendLinkTags(url: URL, loc: Location, tagsById: Record<number, Tag>): void {
	for (const id of loc.tags) {
		const name = tagsById[id]?.name;
		if (name) url.searchParams.append("extra[tags]", name);
	}
	if (!hasLoadAsPanoId(loc)) url.searchParams.set("extra[loadMode]", "latLng");
}

// Routed through the Tauri `gmaps` URI-scheme handler (server-side proxy to
// www.google.com), so it works in dev and release.
const BATCH_URL = `${schemeBase("gmaps")}maps/_/MapsWizUi/data/batchexecute`;

export async function copyMapsLink(
	url: URL,
	{ long = false }: { long?: boolean } = {},
): Promise<void> {
	const longStr = url.toString();
	if (long) {
		await navigator.clipboard.writeText(longStr).catch(() => {});
		return;
	}
	try {
		await navigator.clipboard.writeText(await shortenMapsUrl(longStr));
	} catch {
		await navigator.clipboard.writeText(longStr).catch(() => {});
	}
}

export async function shortenMapsUrl(longUrl: string): Promise<string> {
	const innerPayload = JSON.stringify([
		longUrl,
		[null, null, null, null, null, null, 81],
		null,
		null,
		null,
		1,
	]);
	const outerPayload = JSON.stringify([
		[["/MapsUrlService.CreateShortUrl", innerPayload, null, "generic"]],
	]);

	const params = new URLSearchParams({
		rpcids: "ExM4R",
		"source-path": new URL(longUrl).pathname + new URL(longUrl).search,
		hl: "en",
	});
	const body = new URLSearchParams({ "f.req": outerPayload });
	const res = await fetch(`${BATCH_URL}?${params}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
		body,
		mode: "cors",
		credentials: "omit",
	});

	if (!res.ok) return longUrl;

	const text = await res.text();
	const lines = text.split("\n").filter((l) => l.startsWith("["));
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			const inner = parsed?.[0]?.[2];
			if (typeof inner === "string") {
				const result = JSON.parse(inner);
				if (typeof result?.[0] === "string" && result[0].startsWith("http")) {
					return result[0];
				}
			}
		} catch {
			// ignored
		}
	}

	return longUrl;
}
