// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Location, Selector } from "@/bindings.gen";
import type { ProcedureSpec } from "@/lib/data/fieldDefs";
import type { PanoDownloadConfig } from "@/lib/sv/panoDownload";

// A download resolves missing pano ids through the engine and keeps the answers to
// itself: the user's locations are never moved onto the panorama it happened to find.
const h = vi.hoisted(() => ({
	runs: [] as { spec: ProcedureSpec; selector: Selector; opts: Record<string, unknown> }[],
	answers: [] as { id: number; value: unknown }[],
	uploaded: [] as string[],
	finished: false,
}));

vi.mock("@/lib/data/procedures", () => ({
	procedureEntry: (name: string) => `res://procedures/${name}.js`,
	runProcedure: (spec: ProcedureSpec, selector: Selector, opts: Record<string, unknown>) => {
		h.runs.push({ spec, selector, opts });
		return Promise.resolve({ success: h.answers.length, failed: [], collected: h.answers });
	},
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeUploadBegin: async () => "session-1",
		storeUploadFinish: async () => {
			h.finished = true;
			return "C:/out/panoramas.zip";
		},
		storeUploadAbort: async () => {},
	},
}));

vi.mock("@/lib/util/toast", () => ({ toast: () => {} }));
vi.mock("@/lib/i18n", () => ({ t: (s: string) => s, msg: (s: string) => s }));
vi.mock("@/lib/sv/query", () => ({
	svMetadata: async (ids: string[]) => ids.map(() => null),
	cameraTypeFromHeight: () => null,
}));

import { bulkDownloadPanoramas } from "@/lib/sv/panoDownload";
import { panoResolveSpec } from "@/lib/sv/enrich";

function loc(id: number, panoId: string | null = null): Location {
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
		extra: null,
		createdAt: 0,
		modifiedAt: null,
	} as unknown as Location;
}

beforeEach(() => {
	h.runs = [];
	h.answers = [];
	h.uploaded = [];
	h.finished = false;
	// Thumbnails come back as bytes; the upload POST records the name it was given.
	vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		if (init?.method === "POST") {
			h.uploaded.push(href.slice(href.lastIndexOf("/") + 1));
			return { ok: true } as Response;
		}
		return { ok: true, blob: async () => new Blob(["img"]) } as unknown as Response;
	});
});

const thumbnail: PanoDownloadConfig = { mode: "thumbnail", zoom: 0, tileX: 0, tileY: 0 };

describe("bulk pano download resolves through the engine", () => {
	it("asks panoResolve for the rows with no pano, collecting the answers", async () => {
		h.answers = [{ id: 2, value: { panoId: "RESOLVED_PANO" } }];
		await bulkDownloadPanoramas([loc(1, "HAS_PANO"), loc(2)], thumbnail);

		expect(h.runs).toHaveLength(1);
		const [{ spec, selector, opts }] = h.runs;
		expect(spec).toBe(panoResolveSpec);
		// Collected, not written: a download must not move the user's panorama.
		expect(opts.sink).toBe("collect");
		expect(selector).toEqual({ type: "Locations", locations: [2], name: null });
	});

	it("downloads the pano the engine answered with", async () => {
		h.answers = [{ id: 2, value: { panoId: "RESOLVED_PANO" } }];
		const result = await bulkDownloadPanoramas([loc(2)], thumbnail);

		expect(h.uploaded).toEqual(["RESOLVED_PANO.png"]);
		expect(result.succeeded).toEqual([2]);
		expect(h.finished).toBe(true);
	});

	it("fails the rows the engine had no answer for", async () => {
		h.answers = [{ id: 2, value: { panoId: "RESOLVED_PANO" } }];
		const result = await bulkDownloadPanoramas([loc(2), loc(3)], thumbnail);

		expect(result.failed).toEqual([3]);
		expect(result.succeeded).toEqual([2]);
	});

	it("runs nothing when every row already has a pano", async () => {
		const result = await bulkDownloadPanoramas([loc(1, "HAS_PANO")], thumbnail);

		expect(h.runs).toEqual([]);
		expect(h.uploaded).toEqual(["HAS_PANO.png"]);
		expect(result.succeeded).toEqual([1]);
	});

	it("ignores an answer that names no pano", async () => {
		h.answers = [{ id: 2, value: { panoId: "" } }];
		const result = await bulkDownloadPanoramas([loc(2)], thumbnail);

		expect(h.uploaded).toEqual([]);
		expect(result.failed).toEqual([2]);
	});
});
