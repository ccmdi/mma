import type * as bindings from "@/bindings.gen";
import type { MapState } from "./store";
import type { Stack, Timeline } from "@/bindings.consts";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { SelectionList } from "./selectionList";

export type History = bindings.History;

export const History = {
	/** Whether `timeline` can step back (undo) or forward (redo). @unstable */
	available: (history: MapState["history"], stack: Stack, timeline: Timeline): boolean => {
		return history[timeline]?.[stack] ?? false;
	},
	/** Undo the newest edit on `timeline`, or redo the newest undone one. */
	step: async (stack: Stack, timeline: Timeline) => {
		try {
			await SelectionList.run(() => cmd.storeStep(stack, timeline));
		} catch (e) {
			log.debug(`[${stack} ${timeline}] nothing or failed:`, e);
		}
	},
};
