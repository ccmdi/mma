import type * as bindings from "@/bindings.gen";
import { type MapState, Store } from "./store";
import { Mutation } from "./mutation";
import { Editor } from "./editor";
import type { EntryKey } from "@/bindings.gen";
import type { Stack } from "@/bindings.consts";
import { cmd } from "@/lib/commands";
import { sceneReached } from "@/lib/render/sceneStore";
import { log } from "@/lib/util/log";

export type History = bindings.History;

/** Step through the edit history one way, closing the open location if the step removed it. */
async function step(stack: Stack) {
	try {
		const r = await Mutation.run(() => cmd.storeStep(stack, null));
		const { removed } = await sceneReached(r.mutation.version);
		const state = Store.get();
		if (state.open && removed.includes(state.open.id)) Editor.setArea("overview");
	} catch (e) {
		log.debug(`[${stack}] nothing or failed:`, e);
	}
}

export const History = {
	/** Whether a history action is available for one part or for the data edit as a whole. @unstable */
	available: (history: MapState["history"], stack: Stack, key?: EntryKey): boolean => {
		if (key) return history[key]?.[stack] ?? false;
		return Object.entries(history).some(
			([key, history]) => key !== "selections" && history?.[stack],
		);
	},
	/** Undo the last edit. */
	undo: () => {
		return step("undo");
	},
	/** Redo the last undone edit. */
	redo: () => {
		return step("redo");
	},
};
