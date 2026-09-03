// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, useState } from "react";
import { mount } from "./fixtures/harness";
import { createLocation } from "@/types";
import type { Location } from "@/bindings.gen";
import type { Pano } from "@/types";

const h = vi.hoisted(() => ({
	activeLocation: null as unknown,
	enrich: vi.fn(async () => true),
}));

vi.mock("@/store/useMapStore", () => ({
	useMapState: (sel: (s: { activeLocation: unknown; map: unknown }) => unknown) =>
		sel({ activeLocation: h.activeLocation, map: { settings: {} } }),
	getMapState: () => ({ activeLocation: h.activeLocation }),
}));
vi.mock("@/lib/sv/enrich", () => ({ enrich: h.enrich }));
vi.mock("@/lib/sv/query", () => ({
	viewedPano: async (pano: string) => ({ ...meta(pano), nearby: [] }),
}));
vi.mock("@/lib/sv/panoSingleton", () => ({ singletonPano: null }));
vi.mock("@/lib/util/timezone", () => ({ useTimezone: () => null }));
vi.mock("@/lib/data/procedures", () => ({
	procedureEntry: (name: string) => name,
	queryProcedure: async () => null,
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { PanoViewerProvider, usePanoViewer } =
	await import("@/components/editor/location/PanoViewerContext");

function meta(pano: string): Pano {
	return {
		pano,
		panoFrontend: 2,
		lat: 1,
		lng: 2,
		altitude: 10,
		pov: null,
		worldSize: { width: 16384, height: 8192 },
		date: "2023-03",
		time: [],
		links: [],
	} as unknown as Pano;
}

type Viewer = ReturnType<typeof usePanoViewer>;
let viewer: Viewer;
let refresh: () => void;

function Probe({ report }: { report: (v: Viewer) => void }) {
	report(usePanoViewer());
	return null;
}

function Host({ report }: { report: (v: Viewer, refresh: () => void) => void }) {
	const [, tick] = useState(0);
	return (
		<PanoViewerProvider>
			<Probe report={(v) => report(v, () => tick((n) => n + 1))} />
		</PanoViewerProvider>
	);
}

const mountHost = () =>
	mount(
		<Host
			report={(v, r) => {
				viewer = v;
				refresh = r;
			}}
		/>,
	);

const view = (pano: string) =>
	act(async () => {
		viewer.view(pano);
	});
const open = (locationId: number, pano: string) =>
	act(async () => {
		viewer.open(locationId, pano);
	});

beforeEach(() => {
	h.enrich.mockClear();
	h.activeLocation = { ...createLocation({ lat: 1, lng: 2 }), id: 7 } satisfies Location;
});

describe("the viewer enriches a location from its own pano only", () => {
	it("writes on open, stays silent while walking, and writes again after a save", async () => {
		const m = mountHost();
		await open(7, "pA");
		expect(h.enrich).toHaveBeenCalledTimes(1);
		expect((h.enrich.mock.calls[0] as unknown[])[1]).toMatchObject({ pano: "pA" });

		await view("pB");
		await view("pC");
		expect(h.enrich).toHaveBeenCalledTimes(1);

		h.activeLocation = { ...(h.activeLocation as Location), panoId: "pC" };
		await act(async () => refresh());
		expect(h.enrich).toHaveBeenCalledTimes(2);
		expect((h.enrich.mock.calls[1] as unknown[])[1]).toMatchObject({ pano: "pC" });
		m.unmount();
	});

	it("a new location starts with nothing viewed, so the old pano cannot reach it", async () => {
		const m = mountHost();
		await open(7, "pA");
		expect(h.enrich).toHaveBeenCalledTimes(1);

		h.activeLocation = { ...createLocation({ lat: 3, lng: 4 }), id: 8 } satisfies Location;
		await act(async () => refresh());
		expect(viewer.viewer).toBeNull();
		expect(viewer.pano).toBeNull();
		expect(h.enrich).toHaveBeenCalledTimes(1);
		m.unmount();
	});
});
