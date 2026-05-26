/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	withApi,
} from "./helpers";
import type { Location } from "@/types";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCALES = [100, 1_000, 10_000, 100_000, 1_000_000];
const RUNS = 3;

interface Timing {
	op: string;
	scale: number;
	avg: number;
	min: number;
	max: number;
}
const results: Timing[] = [];

function record(op: string, scale: number, times: number[]) {
	const sorted = [...times].sort((a, b) => a - b);
	const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
	const entry: Timing = {
		op,
		scale,
		avg,
		min: Math.round(sorted[0]),
		max: Math.round(sorted.at(-1)!),
	};
	results.push(entry);
	console.log(
		`  [SPEED] ${op} @ ${scale.toLocaleString()}: avg=${entry.avg}ms min=${entry.min}ms max=${entry.max}ms`,
	);
}

// --- Helpers ---

function seedLocs(n: number, tagId?: number, panoFrac = 0, flagsFrac = 0): Promise<string> {
	return withApi(
		async (api, count: number, tid: number, pf: number, ff: number) => {
			const locs: Location[] = [];
			for (let i = 0; i < count; i++) {
				locs.push(api.createLocation({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					heading: Math.random() * 360,
					zoom: 1,
					panoId: pf > 0 && i < Math.floor(count * pf) ? "pano_" + i : null,
					flags: ff > 0 && i < Math.floor(count * ff) ? 1 : 0,
					tags: tid > 0 && i < Math.floor(count * 0.5) ? [tid] : [],
				}));
			}
			const json = JSON.stringify({ customCoordinates: locs });
			await api.importPaste(json);
			return "ok";
		},
		n,
		tagId ?? 0,
		panoFrac,
		flagsFrac,
	);
}

async function seedMap(
	name: string,
	n: number,
	tagId?: number,
	panoFrac = 0,
	flagsFrac = 0,
): Promise<string> {
	const mapId = await createAndOpenMap(name);
	await seedLocs(n, tagId, panoFrac, flagsFrac);
	await flushAndWait();
	return mapId;
}

function timeOp(fnName: string, ...args: any[]): Promise<number> {
	return withApi(
		async (api, name: string, a: any[]) => {
			const t0 = performance.now();
			try {
				const result = (api as any)[name](...a);
				if (result && typeof result.then === "function") {
					await result;
				}
				return performance.now() - t0;
			} catch {
				return -1;
			}
		},
		fnName,
		args,
	);
}

function addOneLoc(): Promise<void> {
	return withApi(async (api) => {
		await api.addLocations([
			api.createLocation({ lat: 0, lng: 0, zoom: 1 }),
		]);
	});
}

function timeAddLocs(n: number): Promise<number> {
	return withApi(async (api, count: number) => {
		const locs: Location[] = [];
		for (let i = 0; i < count; i++) {
			locs.push(api.createLocation({
				lat: Math.random() * 170 - 85,
				lng: Math.random() * 360 - 180,
				heading: Math.random() * 360,
				zoom: 1,
			}));
		}
		const t0 = performance.now();
		await api.addLocations(locs);
		return performance.now() - t0;
	}, n);
}

function timeOpenMap(id: string): Promise<number> {
	return withApi(async (api, mapId: string) => {
		const t0 = performance.now();
		await api.openMap(mapId);
		return performance.now() - t0;
	}, id);
}

function timeSelection(selName: string, tagId: number): Promise<number> {
	return withApi(
		async (api, name: string, tid: number) => {
			api.resetSelections();
			const t0 = performance.now();
			const result = name === "selectTag" ? api.selectTag(tid) : (api as any)[name]();
			if (result && typeof result.then === "function") {
				await result;
			}
			return performance.now() - t0;
		},
		selName,
		tagId,
	);
}

function timeComposite(setup: string, measure: string, tagId: number): Promise<number> {
	return withApi(
		async (api, s: string, m: string, tid: number) => {
			api.resetSelections();
			if (s === "pano+tag") {
				await api.selectPanoIds();
				await api.selectTag(tid);
			} else if (s === "pano") {
				await api.selectPanoIds();
			}
			const t0 = performance.now();
			const result = (api as any)[m]();
			if (result && typeof result.then === "function") {
				await result;
			}
			return performance.now() - t0;
		},
		setup,
		measure,
		tagId,
	);
}

function timeRemoveAll(): Promise<number> {
	return withApi(async (api) => {
		const ids: number[] = await api.cmd.storeResolveSelection({ type: "Everything" });
		const t0 = performance.now();
		await api.removeLocations(new Set(ids));
		return performance.now() - t0;
	});
}

function timeRemoveOne(): Promise<number> {
	return withApi(async (api) => {
		const ids: number[] = await api.cmd.storeResolveSelection({ type: "Everything" });
		if (ids.length === 0) return -1;
		const t0 = performance.now();
		await api.removeLocations(new Set([ids[0]]));
		return performance.now() - t0;
	});
}

function timeBatchUpdate(count: number, iter: number): Promise<number> {
	return withApi(
		async (api, n: number, it: number) => {
			const ids: number[] = await api.cmd.storeResolveSelection({ type: "Everything" });
			const updates = ids.slice(0, n).map((id: number) => ({ id, patch: { heading: it * 10 } }));
			const t0 = performance.now();
			await api.batchUpdateLocations(updates);
			return performance.now() - t0;
		},
		count,
		iter,
	);
}

function timeTagCounts(): Promise<number> {
	return withApi(async (api) => {
		const t0 = performance.now();
		await api.cmd.storeTagCounts();
		return performance.now() - t0;
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Speed Matrix", () => {
	before(async () => {
		await waitForReady();
	});

	after(async () => {
		const lines: string[] = [];
		const ops = [...new Set(results.map((r) => r.op))];
		const scales = [...new Set(results.map((r) => r.scale))].sort((a, b) => a - b);

		lines.push(`MMA Speed Matrix -- ${new Date().toISOString()}`);
		lines.push("=".repeat(80));
		lines.push("");

		const scaleHeaders = scales.map((s) => s.toLocaleString().padStart(10));
		lines.push(`${"Operation".padEnd(35)} ${scaleHeaders.join("  ")}`);
		lines.push("-".repeat(35 + scales.length * 12));

		for (const op of ops) {
			const cells = scales.map((s) => {
				const r = results.find((x) => x.op === op && x.scale === s);
				return r ? `${r.avg}ms`.padStart(10) : "---".padStart(10);
			});
			lines.push(`${op.padEnd(35)} ${cells.join("  ")}`);
		}

		lines.push("");
		lines.push("All times in ms (avg of " + RUNS + " runs)");

		const artifactPath = path.resolve(__dirname, "../../speed-matrix.txt");
		fs.writeFileSync(artifactPath, lines.join("\n") + "\n");
		console.log(`\n[SPEED] Matrix written to ${artifactPath}`);
	});

	// --- addLocations (capped at 10K — larger scales are IPC-bound, not Rust-bound) ---
	for (const n of SCALES.filter((s) => s <= 10_000)) {
		it(`addLocations @ ${n.toLocaleString()}`, async () => {
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				const mapId = await createAndOpenMap(`speed-add-${n}-${i}`);
				const ms = await timeAddLocs(n);
				if (ms >= 0) times.push(ms);
				await closeMap();
				await deleteMap(mapId);
			}
			if (times.length > 0) record("addLocations", n, times);
		});
	}

	// --- save (incremental) ---
	for (const n of SCALES) {
		it(`save @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-save-${n}`, n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				await addOneLoc();
				const ms = await timeOp("flushSave");
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("save (incremental)", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}

	// --- map open ---
	for (const n of SCALES) {
		it(`mapOpen @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-open-${n}`, n);
			await closeMap();
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				const ms = await timeOpenMap(mapId);
				if (ms >= 0) times.push(ms);
				await closeMap();
			}
			if (times.length > 0) record("mapOpen", n, times);
			await deleteMap(mapId);
		});
	}

	// --- map close ---
	for (const n of SCALES) {
		it(`mapClose @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-close-${n}`, n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				await timeOpenMap(mapId);
				const ms = await timeOp("closeMap");
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("mapClose", n, times);
			await deleteMap(mapId);
		});
	}

	// --- single add into existing N ---
	for (const n of SCALES) {
		it(`addOne @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-add1-${n}`, n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				const ms = await timeAddLocs(1);
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("addOne", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}

	// --- undo ---
	for (const n of [100, 1_000, 10_000]) {
		it(`undo @ ${n.toLocaleString()}`, async () => {
			const mapId = await createAndOpenMap(`speed-undo-${n}`);
			await seedLocs(n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				if (i > 0) await timeOp("redo");
				const ms = await timeOp("undo");
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("undo", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}

	// --- redo ---
	for (const n of [100, 1_000, 10_000]) {
		it(`redo @ ${n.toLocaleString()}`, async () => {
			const mapId = await createAndOpenMap(`speed-redo-${n}`);
			await seedLocs(n);
			await timeOp("undo");
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				if (i > 0) await timeOp("undo");
				const ms = await timeOp("redo");
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("redo", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}

	// --- selections ---
	for (const n of SCALES) {
		describe(`selections @ ${n.toLocaleString()}`, () => {
			let mapId: string;
			let tagId = 0;

			before(async () => {
				mapId = await createAndOpenMap(`speed-sel-${n}`);
				const resolved: any = await withApi(async (api) => {
					return api.createTags(["bench-tag"]);
				});
				tagId = resolved?.[0]?.id ?? 0;
				await seedLocs(n, tagId, 0.4, 0.3);
			});

			after(async () => {
				await closeMap();
				await deleteMap(mapId);
			});

			for (const selName of [
				"selectEverything",
				"selectTag",
				"selectUntagged",
				"selectPanoIds",
				"selectNotPanoIds",
				"selectUnpanned",
			]) {
				it(selName, async () => {
					const times: number[] = [];
					for (let i = 0; i < RUNS; i++) {
						const ms = await timeSelection(selName, tagId);
						if (ms >= 0) times.push(ms);
					}
					if (times.length > 0) record(selName, n, times);
				});
			}

			it("selectIntersection", async () => {
				const times: number[] = [];
				for (let i = 0; i < RUNS; i++) {
					const ms = await timeComposite("pano+tag", "selectIntersection", tagId);
					if (ms >= 0) times.push(ms);
				}
				if (times.length > 0) record("selectIntersection", n, times);
			});

			it("selectUnion", async () => {
				const times: number[] = [];
				for (let i = 0; i < RUNS; i++) {
					const ms = await timeComposite("pano+tag", "selectUnion", tagId);
					if (ms >= 0) times.push(ms);
				}
				if (times.length > 0) record("selectUnion", n, times);
			});

			it("selectInverse", async () => {
				const times: number[] = [];
				for (let i = 0; i < RUNS; i++) {
					const ms = await timeComposite("pano", "selectInverse", tagId);
					if (ms >= 0) times.push(ms);
				}
				if (times.length > 0) record("selectInverse", n, times);
			});
		});
	}

	// --- tag counts ---
	for (const n of SCALES) {
		it(`tagCounts @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-tc-${n}`, n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				const ms = await timeTagCounts();
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("tagCounts", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}

	// --- batch update ---
	for (const n of [100, 1_000, 10_000]) {
		it(`batchUpdate @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-batch-${n}`, n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				const ms = await timeBatchUpdate(n, i);
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("batchUpdate", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}

	// --- removeLocations (bulk) ---
	for (const n of SCALES) {
		it(`removeLocations @ ${n.toLocaleString()}`, async () => {
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				const mapId = await createAndOpenMap(`speed-rm-${n}-${i}`);
				await seedLocs(n);
				await flushAndWait();
				const ms = await timeRemoveAll();
				if (ms >= 0) times.push(ms);
				await closeMap();
				await deleteMap(mapId);
			}
			if (times.length > 0) record("removeLocations", n, times);
		});
	}

	// --- removeOne from existing N ---
	for (const n of SCALES) {
		it(`removeOne @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-rm1-${n}`, n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				const ms = await timeRemoveOne();
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("removeOne", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}

	// --- commit ---
	for (const n of [100, 1_000, 10_000]) {
		it(`commit @ ${n.toLocaleString()}`, async () => {
			const mapId = await seedMap(`speed-commit-${n}`, n);
			const times: number[] = [];
			for (let i = 0; i < RUNS; i++) {
				await addOneLoc();
				const ms = await timeOp("commitMap", `bench ${i}`);
				if (ms >= 0) times.push(ms);
			}
			if (times.length > 0) record("commit", n, times);
			await closeMap();
			await deleteMap(mapId);
		});
	}
});
