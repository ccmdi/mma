// Decomposes the awaited path of a mutation at scale into its legs: the command's
// reply (IPC + Rust), the scene reaching the version (frame apply), the rest of
// Mutation.settle (feed delivery + inflight autosave), and the next paint.
// A diagnostic tool, not a regression gate: run it by hand against one build.
//
//   MMA_E2E_PROFILE=release bash scripts/e2e.sh test/e2e/settle-probe.test.ts
//   MMA_PROBE_SCALE=200000 to change the fixture size (default 200000).

import { writeFixture } from "../perf/benchmarkHarness.ts";
import { waitForReady, withApi } from "./helpers";

const SCALE = Number(process.env.MMA_PROBE_SCALE ?? 200_000);
const SCENE_TIMEOUT_MS = 600_000;

interface Legs {
	ipc: number;
	scene: number;
	rest: number;
	paint: number;
}

async function waitForScene(minimumMarkers: number): Promise<void> {
	await browser.waitUntil(
		async () =>
			(await withApi(async () => {
				const perf = window.__mmaPerf;
				if (!perf) return -1;
				await perf.settled();
				return perf.render()?.totalMarkers ?? -2;
			})) >= minimumMarkers,
		{ interval: 200 },
	);
}

/** Run the op `kind` names in the page and time each awaited leg of its settle. */
function probe(label: string, op: string): Promise<Legs> {
	return withApi(async (api, opKey) => {
		const ops: Record<string, () => Promise<{ version: number; keys: number[] }>> = {
			"single-update": async () => {
				const [id] = await api.resolveIds({ type: "Everything" });
				const r = await api.cmd.storeEdit({
					locations: {
						target: { kind: "map" },
						edits: [{ put: { id, heading: 7 } }],
						records: {},
					},
				});
				return r.mutation;
			},
			"bulk-update": async () => {
				const ids = await api.resolveIds({ type: "Everything" });
				const edits = ids.map((id) => ({ put: { id, pitch: 0.5 } }));
				const r = await api.cmd.storeEdit({
					locations: { target: { kind: "map" }, edits, records: {} },
				});
				return r.mutation;
			},
			"delete-all": async () => {
				const ids = await api.resolveIds({ type: "Everything" });
				const edits = ids.map((id) => ({ remove: id }));
				const r = await api.cmd.storeEdit({
					locations: { target: { kind: "map" }, edits, records: {} },
				});
				return r.mutation;
			},
			undo: () => api.cmd.storeStep("undo", "edits"),
			redo: () => api.cmd.storeStep("redo", "edits"),
		};
		const mutate = ops[opKey];
		if (!mutate) throw new Error(`unknown probe op ${opKey}`);
		const t0 = performance.now();
		const mutation = await mutate();
		const t1 = performance.now();
		await api.Scene.reached(mutation.version);
		const t2 = performance.now();
		await api.Mutation.settle(mutation);
		const t3 = performance.now();
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		const t4 = performance.now();
		api.Autosave.cancel();
		return { ipc: t1 - t0, scene: t2 - t1, rest: t3 - t2, paint: t4 - t3 };
	}, op).then((legs) => {
		// eslint-disable-next-line no-console -- this spec is a tool, its output is the point
		console.log(
			`[probe] ${label}: ipc=${legs.ipc.toFixed(0)}ms scene=${legs.scene.toFixed(0)}ms ` +
				`rest=${legs.rest.toFixed(0)}ms paint=${legs.paint.toFixed(0)}ms`,
		);
		return legs;
	});
}

describe("Settle decomposition", () => {
	it(`probes mutation legs at ${SCALE}`, async function () {
		this.timeout(SCENE_TIMEOUT_MS * 4);
		await waitForReady();

		const fixture = await writeFixture(SCALE);
		await withApi(
			async (api, path, target) => {
				const map = await api.cmd.storeCreateMap(`Settle probe ${Date.now()}`, null);
				await api._test.openMap(map.id);
				await api.Import.fromPath(path);
				const result = await api.Import.confirm([], undefined);
				if (!result || result.importedCount !== target)
					throw new Error(`fixture import produced ${result?.importedCount ?? 0}`);
				await api.Autosave.waitForInflight();
				await api.Commit.create("probe fixture");
			},
			fixture,
			SCALE,
		);
		await waitForScene(SCALE);

		for (let i = 0; i < 3; i += 1) await probe(`single-update#${i}`, "single-update");

		await probe("bulk-update", "bulk-update");
		await probe("undo-bulk-update", "undo");

		await withApi(async (api) => {
			const tag = Object.values(api.Tag.all()).find((t) => t.name === "benchmark-tag");
			if (!tag) throw new Error("fixture is missing the benchmark-tag");
			await api.Edit.selections({ kind: "set", selections: [] });
			await api.Edit.selections(api.addSelection(api.tagSelector(tag.id)));
		});

		await probe("delete-all-selected", "delete-all");
		await probe("undo-delete", "undo");
		await probe("redo-delete", "redo");
		await probe("undo-delete#2", "undo");
	});
});
