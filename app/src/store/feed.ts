import { Store } from "./store";
import { Autosave } from "./autosave";
import type { ChangeEvent } from "@/bindings.gen";
import { Channel } from "@tauri-apps/api/core";
import { cmd } from "@/lib/commands";
import { emit as emitEvent } from "@/lib/events";
import { watermark } from "@/lib/util/watermark";

const delivered = watermark<void>(() => {});

function applyChange(e: ChangeEvent) {
	const moved = e.version > delivered.version();
	delivered.pass(e.version);
	if (!Store.get().map) return;
	Store.merge(e.derived, e.version);
	if (moved) Autosave.schedule();
	emitEvent("store:change", e);
}

export const Feed = {
	seed: (version: number) => {
		delivered.reset(version, () => {});
	},
	/** Resolves once the change feed has delivered `version`'s event (or a later one), or the map closes. */
	waitFor: (version: number): Promise<void> => {
		return delivered.reached(version);
	},
	reset: () => {
		delivered.reset(0, () => {});
	},
	start: async () => {
		const ch = new Channel<ChangeEvent>();
		ch.onmessage = applyChange;
		await cmd.storeSubscribeChanges(ch);
	},
};
