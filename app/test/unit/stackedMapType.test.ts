// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/sv/opensv", async () => (await import("./fixtures/mocks")).googleMapsMock());

import { createCompositeMapType, type TileLayer } from "@/lib/geo/stackedMapType";
import { google } from "@/lib/sv/opensv";

/** jsdom never loads images, so stand in for them and settle each one by hand. */
class FakeImage {
	static made: FakeImage[] = [];
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	naturalWidth = 256;
	private _src = "";
	constructor() {
		FakeImage.made.push(this);
	}
	get src() {
		return this._src;
	}
	set src(v: string) {
		this._src = v;
	}
	load() {
		this.onload?.();
	}
	fail() {
		this.onerror?.();
	}
}

const layer = (name: string, extra: Partial<TileLayer> = {}): TileLayer => ({
	url: (x, y, z) => `${name}/${z}/${x}/${y}`,
	...extra,
});

const triggers = () => vi.mocked(google.maps.event.trigger).mock.calls;
const loadCount = (el: unknown) => triggers().filter((c) => c[0] === el && c[1] === "load").length;

const getTile = (mt: google.maps.ImageMapType) =>
	mt.getTile({ x: 1, y: 2 } as never, 7, document) as HTMLCanvasElement;

beforeEach(() => {
	FakeImage.made = [];
	vi.mocked(google.maps.event.trigger).mockClear();
	vi.stubGlobal("Image", FakeImage);
});

describe("composite map type", () => {
	it("returns one element per tile position regardless of stack depth", () => {
		const one = getTile(createCompositeMapType([layer("a")]));
		const three = getTile(createCompositeMapType([layer("a"), layer("b"), layer("c")]));
		expect(one.tagName).toBe("CANVAS");
		expect(three.tagName).toBe("CANVAS");
		expect(three.children).toHaveLength(0);
		expect(three.style.width).toBe("256px");
	});

	it("requests one image per layer, at the tile's own coordinate", () => {
		getTile(createCompositeMapType([layer("a"), layer("b")]));
		expect(FakeImage.made.map((i) => i.src)).toEqual(["a/7/1/2", "b/7/1/2"]);
	});

	it("skips layers that do not cover the zoom", () => {
		getTile(createCompositeMapType([layer("a"), layer("b", { maxZoom: 5 })]));
		expect(FakeImage.made.map((i) => i.src)).toEqual(["a/7/1/2"]);
	});

	it("signals load once, after every layer settles", () => {
		const tile = getTile(createCompositeMapType([layer("a"), layer("b")]));
		expect(loadCount(tile)).toBe(0);
		FakeImage.made[0].load();
		expect(loadCount(tile)).toBe(0);
		FakeImage.made[1].load();
		expect(loadCount(tile)).toBe(1);
	});

	// One failing layer used to leave the tile permanently unloaded, which pinned the
	// previous zoom level's tiles on screen.
	it("counts a failed layer as settled", () => {
		const tile = getTile(createCompositeMapType([layer("a"), layer("b")]));
		FakeImage.made[0].load();
		FakeImage.made[1].fail();
		expect(loadCount(tile)).toBe(1);
	});

	it("cancels in-flight loads on release and never signals afterwards", () => {
		const mt = createCompositeMapType([layer("a"), layer("b")]);
		const tile = getTile(mt);
		mt.releaseTile(tile);
		expect(FakeImage.made.map((i) => i.src)).toEqual(["", ""]);
		expect(FakeImage.made.every((i) => i.onload === null && i.onerror === null)).toBe(true);
		FakeImage.made[0].load();
		FakeImage.made[1].load();
		expect(loadCount(tile)).toBe(0);
	});

	it("releasing a tile it never handed out is a no-op", () => {
		const mt = createCompositeMapType([layer("a")]);
		expect(() => mt.releaseTile(document.createElement("canvas"))).not.toThrow();
	});

	// A settled tile is just its canvas: holding the sources would keep N decoded bitmaps
	// per tile position alive for as long as the tile is on screen.
	it("lets go of the source images once every layer has settled", () => {
		const mt = createCompositeMapType([layer("a"), layer("b")]);
		const tile = getTile(mt);
		const held = () =>
			(mt as unknown as { tiles: WeakMap<HTMLCanvasElement, { images: unknown[] }> }).tiles.get(
				tile,
			)!.images.length;
		FakeImage.made[0].load();
		expect(held()).toBe(2);
		FakeImage.made[1].load();
		expect(held()).toBe(0);
	});
});
