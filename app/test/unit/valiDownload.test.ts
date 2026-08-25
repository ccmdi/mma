import { describe, it, expect } from "vitest";
import {
	downloadProgress,
	staleSummary,
	type DownloadProgress,
} from "@/plugins/vali/ui/ValiDownloadDialog";
import { valiMessageAction } from "@/plugins/vali/ui/ValiSidebar";
import type { ValiCountryStatus, ValiProgress } from "@/bindings.gen";

const started = (
	countryCode: string,
	files: number,
	bytes = 100,
	updates = false,
): ValiProgress => ({
	kind: "countryDownloadStarted",
	countryCode,
	files,
	bytes,
	updates,
});

const file = (countryCode: string, bytes = 10): ValiProgress => ({
	kind: "fileDownloaded",
	countryCode,
	name: "x",
	bytes,
});

const fold = (events: ValiProgress[]): DownloadProgress | null =>
	events.reduce<DownloadProgress | null>(downloadProgress, null);

describe("downloadProgress", () => {
	it("accumulates files and bytes within a country batch", () => {
		const p = fold([started("FR", 3, 300), file("FR", 100), file("FR", 50)]);
		expect(p).toMatchObject({ country: "FR", files: 3, done: 2, bytes: 300, bytesDone: 150 });
	});

	it("resets per-batch counters on the next country but keeps the run total", () => {
		const p = fold([started("FR", 2), file("FR"), file("FR"), started("DE", 5), file("DE")]);
		expect(p).toMatchObject({ country: "DE", files: 5, done: 1, bytesDone: 10, filesTotal: 3 });
	});

	it("carries the updates flag of the batch in flight", () => {
		expect(fold([started("FR", 1), started("FR", 1, 100, true)])?.updates).toBe(true);
		expect(fold([started("FR", 1, 100, true), started("DE", 1)])?.updates).toBe(false);
	});

	it("ignores generate-only events", () => {
		const base = fold([started("FR", 2), file("FR")]);
		const after = [
			{ kind: "workItems", total: 9 } as ValiProgress,
			{
				kind: "workItemDone",
				countryCode: "FR",
				subdivisionCode: null,
				done: 1,
				total: 9,
			} as ValiProgress,
		].reduce<DownloadProgress | null>(downloadProgress, base);
		expect(after).toEqual(base);
	});

	it("ignores a file event arriving before any batch started", () => {
		expect(fold([file("FR")])).toBeNull();
	});
});

describe("staleSummary", () => {
	const status = (...codes: string[]): ValiCountryStatus[] =>
		codes.map((countryCode) => ({ countryCode, files: 1, bytes: 10 }));

	it("is empty when nothing is stale, so the banner can render unconditionally", () => {
		expect(staleSummary([])).toBe("");
	});

	it("names a single country", () => {
		expect(staleSummary(status("FR"))).toBe("Data for France is out of date.");
	});

	it("names every country, however many there are", () => {
		expect(staleSummary(status("FR", "DE", "JP"))).toBe(
			"Data for France, Germany, Japan is out of date.",
		);
		expect(staleSummary(status("FR", "DE", "JP", "IT", "ES"))).toBe(
			"Data for France, Germany, Japan, Italy, Spain is out of date.",
		);
	});

	it("falls back to the code for a country Intl doesn't know", () => {
		expect(staleSummary(status("XZ"))).toBe("Data for XZ is out of date.");
	});
});

describe("valiMessageAction", () => {
	it("always forwards cancel", () => {
		for (const busy of [null, "generate", "download"] as const) {
			expect(valiMessageAction("vali:cancel", busy)).toBe("cancel");
		}
	});

	it("runs generate only when nothing else holds the cancel token", () => {
		expect(valiMessageAction("vali:generate", null)).toBe("generate");
	});

	it("rejects generate while a download owns the cancel token", () => {
		expect(valiMessageAction("vali:generate", "download")).toBe("reject");
	});

	it("drops a generate that arrives during another generate", () => {
		expect(valiMessageAction("vali:generate", "generate")).toBe("ignore");
	});

	it("ignores unrelated messages", () => {
		expect(valiMessageAction("resize", null)).toBe("ignore");
		expect(valiMessageAction(undefined, null)).toBe("ignore");
	});
});
