// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Tag } from "@/types";
import { compareNatural, each, mmaBufUrl, phaseRate, type PhaseRate } from "@/lib/util/util";
import { downloadBlob } from "@/lib/util/download";
import { getToasts } from "@/lib/util/toast";
import { sortTagsByMode, tagColorFor } from "@/lib/data/tags";
import { ERROR_CODES } from "@/bindings.consts";
import { initLocale } from "@/lib/i18n";
import { colorForName } from "@/lib/util/color";
import { relativeTime, errText } from "@/lib/util/format";
import { cycle, Err, Loading, Ok, type AsyncState } from "@/types/util";
import { MOVEMENT_CYCLE } from "@/store/settings";
describe("sortTagsByMode", () => {
	const tag = (id: number, name: string, order?: number): Tag => ({
		id,
		name,
		color: "#000",
		visible: true,
		order: order ?? null,
		doclinks: [],
	});
	const tags = [tag(1, "bravo", 2), tag(2, "alpha", 1), tag(3, "charlie")];
	const counts = { 1: 5, 2: 1, 3: 9 };

	it("default sorts by order, name-tiebreak, without mutating input", () => {
		const input = [...tags];
		expect(sortTagsByMode(input, "default", counts).map((t) => t.id)).toEqual([2, 1, 3]);
		expect(input).toEqual(tags);
	});

	it("default sorts unordered tags last, alphabetically among themselves", () => {
		const mixed = [tag(1, "zeta"), tag(2, "beta", 5), tag(3, "alpha")];
		expect(sortTagsByMode(mixed, "default", {}).map((t) => t.id)).toEqual([2, 3, 1]);
	});

	it("name sorts alphabetically", () => {
		expect(sortTagsByMode(tags, "name", counts).map((t) => t.id)).toEqual([2, 1, 3]);
	});

	it("amount sorts by count descending, missing counts last", () => {
		expect(sortTagsByMode(tags, "amount", {})).toEqual(tags);
		expect(sortTagsByMode(tags, "amount", counts).map((t) => t.id)).toEqual([3, 1, 2]);
	});
});

describe("tagColorFor", () => {
	const tags: Tag[] = [
		{ id: 1, name: "Red", color: "#ff0000", visible: true, order: null, doclinks: [] },
	];

	it("uses an existing tag's stored color, matched case-insensitively", () => {
		expect(tagColorFor("red", tags)).toBe("#ff0000");
	});

	it("falls back to the deterministic colorForName for an unknown name", () => {
		expect(tagColorFor("Gamma", tags)).toBe(colorForName("Gamma"));
	});
});

describe("compareNatural", () => {
	it("orders numeric strings by value, not lexically", () => {
		expect(["300", "80", "1000", "9"].sort(compareNatural)).toEqual(["9", "80", "300", "1000"]);
	});

	it("orders embedded-number strings naturally", () => {
		expect(["80 m", "300 m", "9 m"].sort(compareNatural)).toEqual(["9 m", "80 m", "300 m"]);
	});

	it("orders plain strings lexically", () => {
		expect(["gen4", "gen2", "gen1"].sort(compareNatural)).toEqual(["gen1", "gen2", "gen4"]);
	});
});

describe("relativeTime", () => {
	beforeEach(async () => {
		await initLocale("en");
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns 'just now' for timestamps less than a minute ago", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const recent = new Date(now - 30_000).toISOString();
		expect(relativeTime(recent)).toBe("just now");
	});

	it("returns minutes ago for timestamps under an hour", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const ago = new Date(now - 5 * 60_000).toISOString();
		expect(relativeTime(ago)).toBe("5m ago");
	});

	it("returns hours ago for timestamps under a day", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const ago = new Date(now - 3 * 3_600_000).toISOString();
		expect(relativeTime(ago)).toBe("3h ago");
	});

	it("returns days ago for timestamps under 30 days", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const ago = new Date(now - 7 * 86_400_000).toISOString();
		expect(relativeTime(ago)).toBe("7d ago");
	});

	it("returns formatted date for timestamps over 30 days", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const old = new Date(now - 60 * 86_400_000).toISOString();
		const result = relativeTime(old);
		expect(result).not.toContain("ago");
		expect(result.length).toBeGreaterThan(3);
	});
});

describe("cycle", () => {
	const items = ["a", "b", "c"];

	it("steps forward and wraps", () => {
		expect(cycle(items, "a")).toBe("b");
		expect(cycle(items, "c")).toBe("a");
	});

	it("steps backward and wraps", () => {
		expect(cycle(items, "b", -1)).toBe("a");
		expect(cycle(items, "a", -1)).toBe("c");
	});

	it("treats an unknown or missing current as sitting before the first item", () => {
		expect(cycle(items, "z")).toBe("a");
		expect(cycle(items, undefined)).toBe("a");
		expect(cycle(items, undefined, -1)).toBe("b");
	});

	it("holds on a single-item list", () => {
		expect(cycle(["only"], "only")).toBe("only");
		expect(cycle(["only"], "only", -1)).toBe("only");
	});

	it("visits every movement mode before repeating", () => {
		const seen = [MOVEMENT_CYCLE[0]];
		for (let i = 0; i < MOVEMENT_CYCLE.length; i++) seen.push(cycle(MOVEMENT_CYCLE, seen[i]));
		expect(seen).toEqual([...MOVEMENT_CYCLE, MOVEMENT_CYCLE[0]]);
	});
});

describe("phaseRate", () => {
	function feed(ticks: [done: number, total: number, at: number][]) {
		let state: PhaseRate | null = null;
		let rate: number | null = null;
		for (const [done, total, at] of ticks) {
			({ state, rate } = phaseRate(state, done, total, at));
		}
		return rate;
	}

	it("averages over the wave, not instantaneously", () => {
		// 100 rows in 1s, then a burst of 300 in the next second: average, not the burst.
		expect(
			feed([
				[0, 1000, 0],
				[100, 1000, 1000],
				[400, 1000, 2000],
			]),
		).toBe(200);
	});

	it("is null until the wave shows work", () => {
		expect(feed([[0, 1000, 0]])).toBeNull();
		expect(
			feed([
				[0, 1000, 0],
				[0, 1000, 5000],
			]),
		).toBeNull();
	});

	it("re-anchors when done resets for the next wave instead of carrying the old speed", () => {
		const rate = feed([
			[0, 100, 0],
			[100, 100, 100], // wave 1: 1000/s
			[0, 5000, 200], // wave 2 begins
			[50, 5000, 1200], // 50 rows in 1s of wave 2
		]);
		expect(rate).toBe(50);
	});

	it("re-anchors when the total grows, which only a new wave does", () => {
		const rate = feed([
			[10, 10, 0],
			[10, 10, 1000], // wave 1 finished at 10/10
			[20, 5000, 2000], // wave 2's counts arrive without ever dipping below 10
			[120, 5000, 3000],
		]);
		expect(rate).toBe(100);
	});

	it("a shrinking total stays inside the wave", () => {
		// Skips shrink the denominator mid-wave; the anchor must survive that.
		expect(
			feed([
				[0, 1000, 0],
				[100, 900, 1000],
				[200, 800, 2000],
			]),
		).toBe(100);
	});
});

// ERROR_CODES is the Rust vocabulary (types.rs `err_codes!`); a code with no message here is a
// compile error, and a code Rust dropped leaves an orphan the same way.
describe("errText", () => {
	it("translates every code Rust can stamp", async () => {
		await initLocale("en-XA");
		for (const code of ERROR_CODES) {
			if (code === "auth") continue;
			const rendered = errText(new Error(`${code}: 1024 2048`));
			expect({ code, translated: rendered.startsWith("[") }).toEqual({ code, translated: true });
		}
	});

	it("shows the provider's own words behind the auth code", async () => {
		await initLocale("en");
		expect(errText(new Error("auth: read: HTTP 401"))).toBe("read: HTTP 401");
	});

	it("interpolates the detail as data, not prose", async () => {
		await initLocale("en");
		expect(errText(new Error("attachment-too-large: 5242880"))).toBe(
			"That image is too large (5.00 MB maximum).",
		);
		expect(errText(new Error("geoguessr-draft-too-large: 17825792 16777216"))).toBe(
			"Too large for a GeoGuessr draft (stores as 17.00 MB; the limit is 16.00 MB).",
		);
		expect(errText(new Error("upload-rejected: 429 Too Many Requests"))).toBe(
			"The upload was rejected (429 Too Many Requests).",
		);
	});

	it("renders a code with no detail", async () => {
		await initLocale("en");
		expect(errText(new Error("attachment-not-staged"))).toBe(
			"That file was not staged for upload.",
		);
	});

	it("passes an uncoded message through untouched", () => {
		expect(errText(new Error("boom: everything is on fire"))).toBe("boom: everything is on fire");
		expect(errText("plain string")).toBe("plain string");
	});
});

describe("mmaBufUrl", () => {
	it("serves any local path, whatever characters its folders and name hold", () => {
		const url = new URL(mmaBufUrl("C:\\maps #1\\50% done?.json"));
		expect(decodeURIComponent(url.pathname)).toBe("/C:/maps #1/50% done?.json");
		expect(url.search + url.hash).toBe("");
	});
});

describe("async states", () => {
	it("gives the value only when ok, and maps only an ok value", () => {
		const states: AsyncState<number>[] = [new Loading(), new Ok(2), new Err(new Error("down"))];
		expect(states.map((s) => s.ok())).toEqual([null, 2, null]);
		const doubled = states.map((s) => s.map((n) => n * 2));
		expect(doubled.map((s) => s.ok())).toEqual([null, 4, null]);
		expect(doubled[0]).toBe(states[0]);
		expect(doubled[2]).toBe(states[2]);
	});
	it("is only built through its classes", () => {
		// @ts-expect-error a bare object is not a state
		const bare: AsyncState<number> = { status: "ok", value: 1 };
		expect(bare.status).toBe("ok");
	});
});

describe("each", () => {
	const double = async (all: number[]) => all.map((n) => n * 2);

	it("answers one input with one result and a list with a list", async () => {
		expect(await each(3, double)).toBe(6);
		expect(await each([1, 2], double)).toEqual([2, 4]);
		expect(await each([], double)).toEqual([]);
	});

	it("runs a single input as a list of one", async () => {
		const seen: number[][] = [];
		await each(5, async (all: number[]) => (seen.push(all), all));
		expect(seen).toEqual([[5]]);
	});
});

describe("downloadBlob", () => {
	afterEach(() => vi.restoreAllMocks());

	it("names the file it saved, since the desktop webview shows no download bar", () => {
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		URL.createObjectURL = vi.fn(() => "blob:x");
		URL.revokeObjectURL = vi.fn();
		downloadBlob(new Blob(["x"]), "tags.csv");
		expect(getToasts().map((t) => t.message)).toContain("Downloaded tags.csv");
	});
});
