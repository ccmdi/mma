// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanoViewer } from "@/lib/sv/pano";

const storeSeenWrite = vi.fn(async () => null);
const settings = { enableSeen: true, enableSeenThumbnails: true, seenResolution: "low" };

vi.mock("@/lib/commands", () => ({
	cmd: { storeSeenWrite: (...a: unknown[]) => storeSeenWrite(...(a as [])) },
}));
vi.mock("@/store/settings", () => ({ getSettings: () => settings }));
vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({ mapId: "map-1" }),
	addLocations: vi.fn(),
	fetchLocations: vi.fn(),
	setActiveLocation: vi.fn(),
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { seenRecord } from "@/lib/seen/seen";

const START = {
	locationId: 7,
	panoId: "PANO",
	lat: 1,
	lng: 2,
	heading: 90,
	pitch: 5,
	zoom: 1,
};
const IMAGE = "A".repeat(200);

function viewer(scene: { panoId: string; heading: number; pitch: number; imagery: boolean }) {
	return {
		panoId: () => scene.panoId,
		captureView: () => ({ heading: scene.heading, pitch: scene.pitch, zoom: 1 }),
		captureImage: () =>
			scene.imagery ? { toDataURL: () => `data:image/jpeg;base64,${IMAGE}` } : null,
	} as unknown as PanoViewer;
}

beforeEach(() => {
	vi.useFakeTimers();
	storeSeenWrite.mockClear();
	Object.assign(settings, { enableSeen: true, enableSeenThumbnails: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("seenRecord", () => {
	it("writes the starting view with a thumbnail once imagery arrives", async () => {
		const scene = { panoId: "PANO", heading: 450, pitch: 5, imagery: false };
		const recording = seenRecord(START, viewer(scene));
		await vi.advanceTimersByTimeAsync(300);
		expect(storeSeenWrite).not.toHaveBeenCalled();
		scene.imagery = true;
		await vi.advanceTimersByTimeAsync(100);
		await recording;
		expect(storeSeenWrite).toHaveBeenCalledWith(
			expect.objectContaining({
				panoId: "PANO",
				locationId: 7,
				mapId: "map-1",
				heading: 90,
				pitch: 5,
				zoom: 1,
				thumbnail: IMAGE,
			}),
		);
	});

	it("keeps the entry but drops the thumbnail once the camera leaves the starting view", async () => {
		const scene = { panoId: "PANO", heading: 90, pitch: 5, imagery: false };
		const recording = seenRecord(START, viewer(scene));
		scene.heading = 140;
		scene.imagery = true;
		await vi.advanceTimersByTimeAsync(100);
		await recording;
		expect(storeSeenWrite).toHaveBeenCalledWith(
			expect.objectContaining({ heading: 90, thumbnail: null }),
		);
	});

	it("drops the thumbnail once the viewer moves to another pano", async () => {
		const scene = { panoId: "PANO", heading: 90, pitch: 5, imagery: false };
		const recording = seenRecord(START, viewer(scene));
		scene.panoId = "OTHER";
		scene.imagery = true;
		await vi.advanceTimersByTimeAsync(100);
		await recording;
		expect(storeSeenWrite).toHaveBeenCalledWith(expect.objectContaining({ thumbnail: null }));
	});

	it("gives up on the thumbnail when imagery never arrives", async () => {
		const recording = seenRecord(
			START,
			viewer({ panoId: "PANO", heading: 90, pitch: 5, imagery: false }),
		);
		await vi.advanceTimersByTimeAsync(3_100);
		await recording;
		expect(storeSeenWrite).toHaveBeenCalledWith(expect.objectContaining({ thumbnail: null }));
	});

	it("skips the thumbnail when thumbnails are off", async () => {
		settings.enableSeenThumbnails = false;
		await seenRecord(START, viewer({ panoId: "PANO", heading: 90, pitch: 5, imagery: true }));
		expect(storeSeenWrite).toHaveBeenCalledWith(expect.objectContaining({ thumbnail: null }));
	});

	it("records nothing when seen history is off", async () => {
		settings.enableSeen = false;
		await seenRecord(START, viewer({ panoId: "PANO", heading: 90, pitch: 5, imagery: true }));
		expect(storeSeenWrite).not.toHaveBeenCalled();
	});
});
