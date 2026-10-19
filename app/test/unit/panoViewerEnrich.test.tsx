// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, useEffect } from "react";
import { mount } from "./fixtures/harness";
import { createLocation } from "@/types";
import type { Location, Pano } from "@/bindings.gen";

const h = vi.hoisted(() => ({
	location: null as Location | null,
	layer: {},
	listeners: new Set<() => void>(),
	metadata: vi.fn<(ids: string[]) => Promise<Partial<Pano>[]>>(),
}));
vi.mock("@/store/editor", async () => {
	const { useEffect, useState } = await import("react");
	return {
		Editor: {
			use: (select: (s: { open: { location: Location | null; layer: object } }) => unknown) => {
				const [, tick] = useState(0);
				useEffect(() => {
					const changed = () => tick((n) => n + 1);
					h.listeners.add(changed);
					return () => {
						h.listeners.delete(changed);
					};
				}, []);
				return select({ open: { location: h.location, layer: h.layer } });
			},
		},
	};
});
vi.mock("@/store/settings", () => ({ useSetting: () => false }));
vi.mock("@/lib/sv/query", () => ({
	svMetadata: (ids: string[]) => h.metadata(ids),
	panosAt: async () => [{ id: "default", lat: 1, lng: 2, time: [] }],
}));
vi.mock("@/lib/hooks/usePano", () => ({ usePano: () => ({ hide: () => {} }) }));
vi.mock("@/lib/geo/reverseGeocode", () => ({
	reverseGeocode: async () => null,
	geocodeGoogle: () => null,
}));

const { PanoViewerProvider, usePanoViewer } =
	await import("@/components/editor/location/PanoViewerContext");
let viewer: ReturnType<typeof usePanoViewer>;
function Probe() {
	const current = usePanoViewer();
	useEffect(() => {
		viewer = current;
	}, [current]);
	return null;
}
function Host() {
	return (
		<PanoViewerProvider>
			<Probe />
		</PanoViewerProvider>
	);
}
function shownId() {
	return viewer.onScreen.status === "ok" ? viewer.onScreen.value.currentPano?.id : undefined;
}
function change(location: Location, layer = h.layer) {
	h.location = location;
	h.layer = layer;
	for (const notify of h.listeners) notify();
}
beforeEach(() => {
	h.location = { ...createLocation({ lat: 1, lng: 2 }), id: 7, panoId: "A" };
	h.layer = {};
	h.listeners.clear();
	h.metadata.mockReset();
	h.metadata.mockImplementation(async (ids) => ids.map((id) => ({ id, lat: 1, lng: 2, time: [] })));
});
describe("pano viewer metadata", () => {
	it("keeps the previous imagery while walking and replaces it when the new answer arrives", async () => {
		const mounted = mount(<Host />);
		await act(async () => {});
		expect(shownId()).toBe("A");
		let resolve!: (panos: Partial<Pano>[]) => void;
		h.metadata.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await act(async () => change({ ...h.location!, panoId: "B" }));
		expect(shownId()).toBe("A");
		await act(async () => resolve([{ id: "B", lat: 3, lng: 4, time: [] }]));
		expect(shownId()).toBe("B");
		mounted.unmount();
	});
	it("reads a lookup still in flight as loading, not as no dates", async () => {
		h.metadata.mockImplementationOnce(() => new Promise(() => {}));
		const mounted = mount(<Host />);
		await act(async () => {});
		expect(viewer.onScreen.status).toBe("loading");
		mounted.unmount();
	});
	it("reports a failed lookup as failed, and retrying asks again", async () => {
		h.metadata.mockRejectedValueOnce(new Error("timed out"));
		const mounted = mount(<Host />);
		await act(async () => {});
		const failed = viewer.onScreen;
		if (failed.status !== "error") throw new Error(`expected error, got ${failed.status}`);
		await act(async () => failed.rerun());
		expect(viewer.onScreen.status === "ok" && viewer.onScreen.value.timeline).toEqual([]);
		expect(h.metadata).toHaveBeenCalledTimes(2);
		mounted.unmount();
	});
	it("drops sticky imagery when reopening the same location in another layer", async () => {
		const mounted = mount(<Host />);
		await act(async () => {});
		expect(shownId()).toBe("A");
		h.metadata.mockImplementationOnce(() => new Promise(() => {}));
		await act(async () => change(h.location!, {}));
		expect(viewer.onScreen.status).toBe("loading");
		mounted.unmount();
	});
});
