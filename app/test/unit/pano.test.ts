// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pano } from "@/bindings.gen";
import { LocationFlag } from "@/bindings.consts";
import { createLocation } from "@/types";

const sv = vi.hoisted(() => {
	class FakePano {
		pano = "";
		status = "OK";
		povState = { heading: 0, pitch: 0 };
		zoomValue = 0;
		listeners = new Map<string, Set<() => void>>();
		setPano = vi.fn((id: string) => {
			this.pano = id;
		});
		setPosition = vi.fn();
		setPov = vi.fn((pov: { heading: number; pitch: number }) => {
			this.povState = pov;
		});
		setZoom = vi.fn((zoom: number) => {
			this.zoomValue = zoom;
		});
		setVisible = vi.fn();
		setOptions = vi.fn();
		focus = vi.fn();
		getPano() {
			return this.pano;
		}
		getStatus() {
			return this.status;
		}
		getPosition() {
			return null;
		}
		getPov() {
			return this.povState;
		}
		getZoom() {
			return this.zoomValue;
		}
		getLinks() {
			return [];
		}
		addListener(event: string, fn: () => void) {
			const set = this.listeners.get(event) ?? new Set();
			set.add(fn);
			this.listeners.set(event, set);
			return { remove: () => set.delete(fn) };
		}
		emit(event: string) {
			for (const fn of [...(this.listeners.get(event) ?? [])]) fn();
		}
	}
	return { FakePano, instances: [] as InstanceType<typeof FakePano>[] };
});
const lookup = vi.hoisted(() => ({
	resolvePano: vi.fn(),
	lookupStreetView: vi.fn(),
	nearestLinkHeading: vi.fn(),
}));

vi.mock("@/lib/sv/opensv", () => ({
	google: {
		maps: {
			StreetViewPanorama: function () {
				const viewer = new sv.FakePano();
				sv.instances.push(viewer);
				return viewer;
			},
			event: { trigger: () => {} },
		},
	},
}));
vi.mock("@/lib/sv/opensvPatch", () => ({ patchOpenSV: () => {}, setPanoHovered: () => {} }));
vi.mock("@/lib/sv/lookup", () => lookup);

function loc(panoId: string) {
	return createLocation({ lat: 1, lng: 2, panoId, flags: LocationFlag.LoadAsPanoId });
}

function resolved(id: string) {
	return { id, lat: 1, lng: 2 } as unknown as Pano;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function freshPano() {
	vi.resetModules();
	const { pano } = await import("@/lib/sv/pano");
	const host = document.createElement("div");
	pano.mount(host);
	return { pano, surface: host.firstElementChild as HTMLElement };
}

function addSceneCanvas(surface: HTMLElement): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.className = "mapsImagerySceneScene__canvas widget-scene-canvas";
	canvas.width = 640;
	canvas.height = 360;
	surface.appendChild(canvas);
	return canvas;
}

/** jsdom has no rasterizer: hand drawScaled a context whose readback we choose. */
function stubCanvas2d(fill: number | null): () => void {
	const original = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type: string) {
		if (type !== "2d") return null;
		return {
			drawImage: () => {},
			getImageData: (_x: number, _y: number, w: number, h: number) => {
				const data = new Uint8ClampedArray(w * h * 4);
				if (fill !== null) for (let i = 0; i < data.length; i++) data[i] = (i * 7 + fill) % 256;
				return { data };
			},
		} as unknown as CanvasRenderingContext2D;
	} as typeof HTMLCanvasElement.prototype.getContext;
	return () => {
		HTMLCanvasElement.prototype.getContext = original;
	};
}

const live = () => sv.instances[sv.instances.length - 1];

beforeEach(() => {
	sv.instances.length = 0;
	lookup.resolvePano.mockReset();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});

describe("showing a pano", () => {
	it("never moves the pano for a show that a newer show overtook", async () => {
		const { pano } = await freshPano();
		const slow = deferred<Pano | null>();
		lookup.resolvePano.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(resolved("B"));
		const first = pano.show(loc("A"));
		const second = pano.show(loc("B"));
		await expect(second).resolves.toEqual({ status: "shown", pano: resolved("B") });
		slow.resolve(resolved("A"));
		await expect(first).resolves.toEqual({ status: "superseded" });
		expect(live().setPano.mock.calls).toEqual([["B"]]);
	});

	it("keeps the pano hidden until the requested pano is ready", async () => {
		const { pano, surface } = await freshPano();
		lookup.resolvePano.mockResolvedValueOnce(resolved("A"));
		await pano.show(loc("A"));
		expect(surface.style.opacity).toBe("0");
		live().emit("status_changed");
		expect(surface.style.opacity).toBe("1");
	});

	it("reveals at once, from the cache, when the pano is already on screen", async () => {
		const { pano, surface } = await freshPano();
		lookup.resolvePano.mockResolvedValueOnce(resolved("A"));
		await pano.show(loc("A"));
		live().emit("status_changed");
		await pano.show(loc("A"));
		expect(surface.style.opacity).toBe("1");
		expect(lookup.resolvePano).toHaveBeenCalledTimes(1);
	});

	it("resolves again after a lookup that found nothing", async () => {
		const { pano } = await freshPano();
		lookup.resolvePano.mockResolvedValueOnce(null).mockResolvedValueOnce(resolved("A"));
		await pano.show(loc("A"));
		await expect(pano.show(loc("A"))).resolves.toEqual({ status: "shown", pano: resolved("A") });
		expect(lookup.resolvePano).toHaveBeenCalledTimes(2);
	});
});

describe("jumping", () => {
	it("overtakes a show that is still resolving", async () => {
		const { pano } = await freshPano();
		const pending = deferred<Pano | null>();
		lookup.resolvePano.mockReturnValueOnce(pending.promise);
		const shown = pano.show(loc("A"));
		pano.jump("JUMP");
		pending.resolve(resolved("A"));
		await expect(shown).resolves.toEqual({ status: "superseded" });
		expect(live().setPano.mock.calls).toEqual([["JUMP"]]);
	});

	it("sets the camera it was given along with the pano", async () => {
		const { pano } = await freshPano();
		pano.jump("A", { heading: 90, pitch: -10, zoom: 2 });
		expect(pano.pov()).toEqual({ heading: 90, pitch: -10 });
		expect(pano.zoom()).toBe(2);
	});
});

describe("preloading", () => {
	it("never lands over a show that started after it", async () => {
		const { pano } = await freshPano();
		const warm = deferred<Pano | null>();
		lookup.resolvePano.mockReturnValueOnce(warm.promise).mockResolvedValueOnce(resolved("CURRENT"));
		const warming = pano.preload(loc("NEXT"));
		await pano.show(loc("CURRENT"));
		warm.resolve(resolved("NEXT"));
		await warming;
		expect(live().setPano.mock.calls).toEqual([["CURRENT"]]);
	});

	it("waits out a show whose pano is not ready yet", async () => {
		const { pano } = await freshPano();
		lookup.resolvePano
			.mockResolvedValueOnce(resolved("CURRENT"))
			.mockResolvedValueOnce(resolved("NEXT"));
		await pano.show(loc("CURRENT"));
		await pano.preload(loc("NEXT"));
		expect(live().setPano.mock.calls).toEqual([["CURRENT"]]);
	});
});

describe("the camera", () => {
	it("drops a reserved camera move once the pano has moved since", async () => {
		const { pano } = await freshPano();
		pano.jump("A");
		const look = pano.reserveLook();
		pano.jump("B");
		expect(look({ heading: 45, pitch: 0 })).toBe(false);
		expect(pano.pov()).toEqual({ heading: 0, pitch: 0 });
	});

	it("copies the camera instead of handing out the live POV object", async () => {
		const { pano } = await freshPano();
		pano.jump("pano-id", { heading: 123.5, pitch: -7.25, zoom: 2.5 });
		const snapshot = pano.snapshot();
		live().povState.heading = 250;
		expect(snapshot).toEqual({ panoId: "pano-id", heading: 123.5, pitch: -7.25, zoom: 2.5 });
	});

	it("refuses a snapshot before a pano is ready", async () => {
		const { pano } = await freshPano();
		expect(() => pano.snapshot()).toThrow("Street View is not ready");
	});
});

describe("listening", () => {
	it("keeps its listeners across a viewer rebuild", async () => {
		const { pano } = await freshPano();
		const heard = vi.fn();
		pano.on("pov_changed", heard);
		pano.jump("A");
		live().emit("pov_changed");
		pano.reload({ lat: 1, lng: 2 });
		live().emit("pov_changed");
		expect(sv.instances).toHaveLength(2);
		expect(heard).toHaveBeenCalledTimes(2);
	});
});

describe("capturing the live frame", () => {
	it("reads the scene canvas, not whatever canvas happens to come first", async () => {
		const { pano, surface } = await freshPano();
		const foreign = document.createElement("canvas");
		foreign.width = 32;
		foreign.height = 32;
		surface.appendChild(foreign);
		const scene = addSceneCanvas(surface);
		expect(pano.canvas()).toBe(scene);
	});

	it("leaves no dead viewer behind on reload, so the next capture cannot read its canvas", async () => {
		const { pano, surface } = await freshPano();
		pano.jump("A");
		addSceneCanvas(surface);
		pano.reload({ lat: 1, lng: 2 });
		expect(surface.childElementCount).toBe(0);
		expect(pano.canvas()).toBeNull();
	});

	it("refuses a blank readback rather than handing back a black frame", async () => {
		const { pano, surface } = await freshPano();
		addSceneCanvas(surface);
		const restore = stubCanvas2d(null);
		try {
			expect(pano.captureImage(320, 180)).toBeNull();
		} finally {
			restore();
		}
	});

	it("returns the frame once the viewer holds imagery", async () => {
		const { pano, surface } = await freshPano();
		addSceneCanvas(surface);
		const restore = stubCanvas2d(3);
		try {
			const out = pano.captureImage(320, 180);
			expect(out?.width).toBe(320);
			expect(out?.height).toBe(180);
		} finally {
			restore();
		}
	});
});

describe("mounting", () => {
	it("lives in the newest container and returns to the previous one on release", async () => {
		vi.resetModules();
		const { pano } = await import("@/lib/sv/pano");
		const editor = document.createElement("div");
		const game = document.createElement("div");
		const releaseEditor = pano.mount(editor);
		const releaseGame = pano.mount(game);
		expect(game.childElementCount).toBe(1);
		expect(editor.childElementCount).toBe(0);
		releaseGame();
		expect(editor.childElementCount).toBe(1);
		releaseEditor();
		expect(editor.childElementCount).toBe(0);
	});

	it("stays put when an older container releases first", async () => {
		vi.resetModules();
		const { pano } = await import("@/lib/sv/pano");
		const editor = document.createElement("div");
		const game = document.createElement("div");
		const releaseEditor = pano.mount(editor);
		pano.mount(game);
		releaseEditor();
		expect(game.childElementCount).toBe(1);
	});
});
