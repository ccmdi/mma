import { describe, it, expect } from "vitest";
import type { Location, Tag } from "@/bindings.gen";
import { LocationFlag } from "@/bindings.consts";
import { mapsPanoUrl, appendLinkTags } from "@/lib/sv/mapsLink";

function loc(over: Partial<Location> = {}): Location {
	return {
		id: 1,
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: 0,
		tags: [],
		extra: null,
		createdAt: 0,
		modifiedAt: null,
		...over,
	} as unknown as Location;
}

const TAGS: Record<number, Tag> = {
	7: { id: 7, name: "Mountains", color: "#fff", visible: true } as unknown as Tag,
	8: { id: 8, name: "Coastal", color: "#000", visible: true } as unknown as Tag,
};

// These literals are the writer's output, parsed back by the Rust reader in
// `app/src-tauri/src/io/maps_url.test.rs`, which pins the same strings.
// If either side drifts, one of the two suites goes red.
const OFFICIAL_PINNED =
	"https://www.google.com/maps/@58.6190505,49.7204709,3a,66.3y,265.69h,98.54t/data=!3m5!1e1!3m3!1sbUp3OlCW2UH3MA4lYMRirQ!2e0!6shttps%3A%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fpanoid%3DbUp3OlCW2UH3MA4lYMRirQ%26cb_client%3Dmaps_sv.share%26w%3D900%26h%3D600%26yaw%3D265.69%26pitch%3D-8.54%26thumbfov%3D66?coh=235716&entry=tts";

const UNOFFICIAL_NO_TAGS =
	"https://www.google.com/maps/@1,2,3a,73.7y,0.00h,90.00t/data=!3m4!1e1!3m2!1sCIHM0ogKEICAgICEm_ixqwE!2e0?coh=235716&entry=tts";

const TAGGED_LAT_LNG =
	"https://www.google.com/maps/@35.6762,139.6503,3a,89.4y,180.00h,85.00t/data=!3m5!1e1!3m3!1sQmgLCWv3QpNiK-1F3ZK_1Q!2e0!6shttps%3A%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fpanoid%3DQmgLCWv3QpNiK-1F3ZK_1Q%26cb_client%3Dmaps_sv.share%26w%3D900%26h%3D600%26yaw%3D180%26pitch%3D5%26thumbfov%3D89?coh=235716&entry=tts&extra%5Btags%5D=Mountains&extra%5Btags%5D=Coastal&extra%5BloadMode%5D=latLng";

describe("mapsPanoUrl", () => {
	it("writes the official-pano share link the Rust reader parses", () => {
		const url = mapsPanoUrl({
			lat: 58.6190505,
			lng: 49.7204709,
			heading: 265.69,
			pitch: 8.54,
			zoom: 1.2,
			panoId: "bUp3OlCW2UH3MA4lYMRirQ",
		});
		expect(url.toString()).toBe(OFFICIAL_PINNED);
	});

	it("writes an unofficial pano without a thumbnail", () => {
		const url = mapsPanoUrl({
			lat: 1,
			lng: 2,
			heading: 0,
			pitch: 0,
			zoom: 1,
			panoId: "CIHM0ogKEICAgICEm_ixqwE",
		});
		expect(url.toString()).toBe(UNOFFICIAL_NO_TAGS);
	});

	it("carries tags and the latLng load mode", () => {
		const url = mapsPanoUrl({
			lat: 35.6762,
			lng: 139.6503,
			heading: 180,
			pitch: -5,
			zoom: 0.6,
			panoId: "QmgLCWv3QpNiK-1F3ZK_1Q",
		});
		appendLinkTags(
			url,
			loc({ lat: 35.6762, lng: 139.6503, panoId: "QmgLCWv3QpNiK-1F3ZK_1Q", tags: [7, 8] }),
			TAGS,
		);
		expect(url.toString()).toBe(TAGGED_LAT_LNG);
	});

	it("omits the load mode for a pinned location", () => {
		const url = mapsPanoUrl({ lat: 1, lng: 2, heading: 0, pitch: 0, zoom: 1, panoId: "abc" });
		appendLinkTags(url, loc({ panoId: "abc", flags: LocationFlag.LoadAsPanoId }), TAGS);
		expect(url.searchParams.get("extra[loadMode]")).toBe(null);
	});
});
