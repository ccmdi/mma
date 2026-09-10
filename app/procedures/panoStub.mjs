// Test-side `Pano` builder for the procedure suites. Nothing here touches the wire: the
// host decodes GetMetadata and SingleImageSearch, so a procedure only ever sees Panos.

/** A Pano with every field spelled out, overridden per case. */
export function pano(over = {}) {
	return {
		pano: "",
		panoFrontend: 2,
		lat: 0,
		lng: 0,
		altitude: 0,
		pov: null,
		worldSize: { width: 13312, height: 6656 },
		tileSize: { width: 512, height: 512 },
		copyright: "",
		description: "",
		shortDescription: "",
		uploaderName: null,
		countryCode: null,
		levelId: null,
		links: [],
		time: [],
		date: null,
		source: null,
		imageDate: "",
		coverageDates: [],
		centerHeading: 0,
		cameraFrame: { heading: 0, pitch: 0 },
		cameraType: "gen2",
		...over,
	};
}

/** `mma.panos` over a lookup answering each id query with a Pano, `null` for a pano that
 *  is gone, or "fail" for a request that never came back. An empty id is skipped, as the
 *  host skips it; a search query goes to `search`, which a metadata-only suite omits. */
export function panos(lookup, search) {
	return (queries) =>
		queries.map((q) => {
			if (!("panoId" in q)) {
				if (!search) throw new Error("unexpected search query");
				return search(q);
			}
			if (!q.panoId) return { state: "skipped" };
			const a = lookup(q.panoId);
			if (a === "fail") return { state: "failed" };
			return a ? { state: "found", pano: a } : { state: "notFound" };
		});
}
