// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Location } from "@/bindings.gen";
import { StreetView, type PanoDownloadConfig } from "@/lib/sv/streetView";

const h = vi.hoisted(() => ({
	cancelled: [] as number[],
	requested: [] as string[],
	nextRun: 40,
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		runReserve: async () => ++h.nextRun,
		runCancel: async (runId: number) => {
			h.cancelled.push(runId);
			return null;
		},
		storeUploadBegin: async () => "session-1",
		storeUploadFinish: async () => "C:/out/panoramas.zip",
		storeUploadAbort: async () => {},
	},
}));

vi.mock("@/lib/util/toast", () => ({ toast: () => {} }));
vi.mock("@/lib/i18n", () => ({ t: (s: string) => s, msg: (s: string) => s }));

function loc(id: number, panoId: string): Location {
	return {
		id,
		lat: 1,
		lng: 2,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId,
		flags: 0,
		tags: [],
	} as unknown as Location;
}

const equirect: PanoDownloadConfig = {
	mode: "equirectangular",
	zoom: 3,
	tileX: 0,
	tileY: 0,
};

beforeEach(() => {
	h.cancelled = [];
	h.requested = [];
	vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
		h.requested.push(String(url));
		return new Promise((_, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
		});
	});
});

describe("a panorama download", () => {
	it("runs each pano request under a run that aborting the download cancels", async () => {
		const controller = new AbortController();
		const download = StreetView.downloadAll([loc(1, "PANO_A")], equirect, {
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(h.requested).toHaveLength(1));

		const runId = Number(new URL(h.requested[0]).searchParams.get("run"));
		expect(runId).toBeGreaterThan(0);
		expect(h.cancelled).toEqual([]);

		controller.abort();
		await download.catch(() => undefined);
		expect(h.cancelled).toEqual([runId]);
	});
});
