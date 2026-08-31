/* The exactDate procedure against a stubbed host. Pins that progress ramps across the
 * search rounds (partial credit per round) instead of arriving as one lump when the whole
 * batch settles -- every row needs the same number of rounds, so without partial credit
 * they would all finish in the same instant. */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../..", import.meta.url));
// The bundle is a build artifact, not a checked-in one.
execFileSync(process.execPath, ["scripts/build-procedures.mjs", "exactDate"], { cwd: app });
/* eslint-disable @typescript-eslint/no-explicit-any */
const mod: any = await import(
	new URL("../../src-tauri/procedures/exactDate.js", import.meta.url).href
);

const enc = new TextEncoder();
const NO_IMAGES = enc.encode("Search returned no images.");
const COVERED = enc.encode("[]");

/** Coverage everywhere except at `deadLat`, which never has images. Records the event
 *  stream: one "fetch" per round, one "progress" per credited row. */
function withHost<T>(deadLat: string, run: () => T): { out: T; events: string[]; failed: number[] } {
	const events: string[] = [];
	const failed: number[] = [];
	(globalThis as any).mma = {
		fetchMany: (reqs: { body: string }[]) => {
			events.push("fetch");
			return reqs.map((r) => ({ status: 200, body: r.body.includes(deadLat) ? NO_IMAGES : COVERED }));
		},
		log: () => {},
		progress: (n: number) => {
			for (let i = 0; i < n; i++) events.push("progress");
		},
		fail: (id: number) => failed.push(id),
		aborted: () => false,
	};
	const out = run();
	return { out, events, failed };
}

const covered = (id: number) => ({ id, lat: 22.5, lng: 3, extra: { imageDate: "2021-09" } });

describe("exactDate procedure", () => {
	it("resolves a covered row to a timestamp inside its month window", () => {
		const { out, failed } = withHost("99", () => mod.run([covered(1)]));
		expect(failed).toEqual([]);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe(1);
		const ts = out[0].patch.extra.datetime;
		const first = Date.UTC(2021, 8, 1) / 1000;
		expect(ts).toBeGreaterThanOrEqual(first - 86400);
		expect(ts).toBeLessThan(first + 32 * 86400);
	});

	it("fails a seed-rejected row and credits it before the search rounds finish", () => {
		const { events, failed } = withHost("11.5", () =>
			mod.run([{ id: 1, lat: 11.5, lng: 3, extra: { imageDate: "2021-09" } }, covered(2)]),
		);
		expect(events.filter((e) => e === "progress")).toHaveLength(2);
		expect(events.indexOf("progress")).toBeLessThan(events.lastIndexOf("fetch"));
		expect(failed).toEqual([1]);
	});

	it("ramps progress across the rounds instead of lumping it at the end", () => {
		const rows = Array.from({ length: 50 }, (_, i) => covered(i + 1));
		const { events } = withHost("99", () => mod.run(rows));
		expect(events.filter((e) => e === "progress")).toHaveLength(50);
		// Partial credit lands between rounds: count the fetch->progress interleavings.
		let stretches = 0;
		for (let i = 1; i < events.length; i++) {
			if (events[i] === "progress" && events[i - 1] === "fetch") stretches++;
		}
		expect(stretches).toBeGreaterThanOrEqual(5);
		// And no single lump carries the majority of the batch.
		let lump = 0;
		let maxLump = 0;
		for (const e of events) {
			lump = e === "progress" ? lump + 1 : 0;
			maxLump = Math.max(maxLump, lump);
		}
		expect(maxLump).toBeLessThan(25);
	});

	it("fails a row whose imageDate is not a month, with its own tick", () => {
		const { out, events, failed } = withHost("99", () =>
			mod.run([{ id: 5, lat: 1, lng: 2, extra: { imageDate: "sometime" } }]),
		);
		expect(out).toEqual([]);
		expect(failed).toEqual([5]);
		expect(events.filter((e) => e === "progress")).toHaveLength(1);
	});
});
