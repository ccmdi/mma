import type * as bindings from "@/bindings.gen";
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
		const caughtUp = Promise.all([Scene.reached(m.version), Feed.waitFor(m.version)]);
		await Autosave.waitForInflight();
		await caughtUp;
	},
	run: async <R extends Mutation | { mutation: Mutation } = Mutation>(
		fn: () => Promise<R>,
		...fallback: Mutation extends R ? [empty?: R] : [empty: R]
	): Promise<R> => {
		if (!Store.get().map) return (fallback[0] ?? Mutation.none()) as R;
		const r = await fn();
		await Mutation.settle("mutation" in r ? r.mutation : r);
		return r;
	},
};
