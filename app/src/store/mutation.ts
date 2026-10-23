import type * as bindings from "@/bindings.gen";
import { log } from "@/lib/util/log";
import { Store } from "./store";
import { Autosave } from "./autosave";
import { Feed } from "./feed";
import type { Location } from "@/bindings.gen";
import { Scene } from "@/lib/render/scene";

export type Mutation<T = Location> = bindings.Mutation<T>;

/** Run mutations and wait for their state and display updates. @api */
export const Mutation = {
	/** The result of a mutation that reached no map. */
	none: (): Mutation => ({ version: 0, keys: [] }),
	/** Resolves once the open map's state and its markers both show `m`. A mutation that reached
	 *  no map (version 0) settles at once. */
	settle: async (m: Mutation): Promise<void> => {
		if (!m.version) return;
		const t0 = performance.now();
		const scene = Scene.reached(m.version).then(() => performance.now() - t0);
		const feed = Feed.waitFor(m.version).then(() => performance.now() - t0);
		await Autosave.waitForInflight();
		const autosaveMs = performance.now() - t0;
		const [sceneMs, feedMs] = await Promise.all([scene, feed]);
		const total = performance.now() - t0;
		if (total > 50) {
			log.debug(
				`[settle] v${m.version} total=${total.toFixed(0)}ms autosave=${autosaveMs.toFixed(0)}ms scene=${sceneMs.toFixed(0)}ms feed=${feedMs.toFixed(0)}ms`,
			);
		}
	},
	/** Send a store write, then wait until the open map shows it. */
	write: async <R extends Mutation | { mutation: Mutation } | null>(
		fn: () => Promise<R>,
	): Promise<R> => {
		const r = await fn();
		if (r) await Mutation.settle("mutation" in r ? r.mutation : r);
		return r;
	},
	run: async <R extends Mutation | { mutation: Mutation } = Mutation>(
		fn: () => Promise<R>,
		...fallback: Mutation extends R ? [empty?: R] : [empty: R]
	): Promise<R> => {
		if (!Store.get().map) return (fallback[0] ?? Mutation.none()) as R;
		return Mutation.write(fn);
	},
};
