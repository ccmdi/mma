import { Edit } from "./edit";
import type { MergeWinner } from "@/bindings.consts";

/** Rename or remove metadata fields across the map. @api */
export const Field = {
	/** Rename extra-field `from` to `to` across all locations, its definition, and the listed
	 *  selections, in one undoable step. When a location already holds `to`, `winner` decides
	 *  which value survives. Saved selections are map-independent rules and keep their names. */
	rename: async (from: string, to: string, winner: MergeWinner = "from") => {
		if (from === to || !to) return;
		await Edit.work({ type: "Everything" }, { kind: "move", from, to, winner });
	},
	/** Delete extra-field `key` from every location, its definition, and the listed selections,
	 *  in one undoable step. */
	remove: async (key: string) => {
		await Edit.work({ type: "Everything" }, { kind: "delete", keys: [key] });
	},
};
