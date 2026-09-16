import { describe, expect, it } from "vitest";
import { liveRows, type LiveStats } from "@/components/dialogs/StatsForNerds";

const live: LiveStats = {
	frame: {
		frames: 60,
		fps: 60,
		p50: 16,
		p95: 17,
		worst: 20,
		longTasks: 0,
		longTaskMs: 0,
		elapsedMs: 1000,
	},
	deck: {
		fps: 60,
		layersCount: 7,
		drawLayersCount: 14,
		framesRedrawn: 1,
		gpuTime: 0,
		gpuTimePerFrame: 0,
		cpuTime: 1,
		cpuTimePerFrame: 1,
		bufferMemory: 0,
		textureMemory: 0,
		renderbufferMemory: 0,
		gpuMemory: 0,
	},
	scene: {
		totalMarkers: 100,
		onScreenMarkers: 50,
		selOverlay: 0,
		layers: 7,
		markerStyle: "circle",
		markerSize: 1,
		quadSidePx: 13,
		estFragments: 8450,
		viewportPx: 1_000_000,
		overdraw: 0.00845,
		dpr: 1,
	},
};

describe("Stats for Nerds rendering rows", () => {
	it("reports logical layers separately from layer draw work", () => {
		expect(liveRows(live)).toEqual(
			expect.arrayContaining([
				["Layers", "7"],
				["Deck layer draws", "14"],
			]),
		);
	});
});
