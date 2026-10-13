import type * as bindings from "@/bindings.gen";
import { Store } from "./store";
import { Autosave } from "./autosave";
import { Feed } from "./feed";
import type { Location } from "@/bindings.gen";
import type { MutationResult } from "@/bindings.gen";
import { Scene } from "@/lib/render/scene";

export type Mutation<T = Location> = bindings.Mutation<T>;

const EMPTY_MUTATION: MutationResult = { mutation: { version: 0, keys: [] } };

export const Mutation = {
	settle: async (m: Mutation): Promise<void> => {
		const caughtUp = Promise.all([Scene.reached(m.version), Feed.waitFor(m.version)]);
		await Autosave.waitForInflight();
		await caughtUp;
		Autosave.schedule();
	},
	run: async <R extends MutationResult = MutationResult>(
		fn: () => Promise<R>,
		...fallback: MutationResult extends R ? [empty?: R] : [empty: R]
	): Promise<R> => {
		if (!Store.get().map) return (fallback[0] ?? EMPTY_MUTATION) as R;
		const r = await fn();
		await Mutation.settle(r.mutation);
		return r;
	},
};
