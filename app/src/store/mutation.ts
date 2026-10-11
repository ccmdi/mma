import type * as bindings from "@/bindings.gen";
import { Store } from "./store";
import { Autosave } from "./autosave";
import { Feed } from "./feed";
import type { Location } from "@/bindings.gen";
import type { MutationResult } from "@/bindings.gen";
import { sceneReached } from "@/lib/render/sceneStore";

export type Mutation<T = Location> = bindings.Mutation<T>;

const EMPTY_MUTATION: MutationResult = { mutation: { version: 0, keys: [] } };

async function settle(m: Mutation): Promise<void> {
	await Autosave.waitForInflight();
	await Promise.all([sceneReached(m.version), Feed.waitFor(m.version)]);
	Autosave.schedule();
}

async function run<R extends MutationResult = MutationResult>(
	fn: () => Promise<R>,
	...fallback: MutationResult extends R ? [empty?: R] : [empty: R]
): Promise<R> {
	if (!Store.get().map) return (fallback[0] ?? EMPTY_MUTATION) as R;
	const r = await fn();
	await settle(r.mutation);
	return r;
}

export const Mutation = {
	settle,
	run,
};
