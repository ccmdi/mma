import type * as bindings from "@/bindings.gen";
import { Store } from "./store";
import { Mutation } from "./mutation";
import { Query } from "./query";
import { Edit } from "./edit";
import type { MutationResult, Target } from "@/bindings.gen";
import type { Patch } from "@/types";
import type { ReadonlyIdSet } from "@/lib/render/CellManager";
import { cmd } from "@/lib/commands";
import { mmaBufUrl } from "@/lib/util/util";
import { trace } from "@/lib/util/debug";
import { log } from "@/lib/util/log";

export type Location = bindings.Location;

const MAP: Target = { kind: "map" };
/** Upload chunk size, targeting roughly 1 MB of JSON per request. */
const ADD_CHUNK = 5000;

/** Stage `locs` as chunked JSON adds in an upload session, then commit them in one mutation.
 *  Only one chunk is serialized at a time, so peak memory is O(chunk), not O(batch). */
async function addViaUpload(locs: Location[]): Promise<MutationResult> {
	const session = await cmd.storeUploadBegin();
	try {
		for (let i = 0, n = 0; i < locs.length; i += ADD_CHUNK, n++) {
			const res = await fetch(mmaBufUrl(`${session}/${n}.json`), {
				method: "POST",
				body: JSON.stringify(locs.slice(i, i + ADD_CHUNK).map((add) => ({ add }))),
			});
			if (!res.ok) throw new Error(`staged add: chunk ${n} upload failed (${res.status})`);
		}
	} catch (e) {
		await cmd.storeUploadAbort(session).catch(() => {});
		throw e;
	}
	return cmd.storeEditUploaded(MAP, session);
}

export const Location = {
	/** Add locations to the map. Each gets a fresh id, written back into the passed object,
	 *  so read `loc.id` after. Undoable. */
	add: async (locs: Location[]) => {
		if (locs.length === 0) return;
		const t = trace("add");
		const r =
			locs.length > ADD_CHUNK
				? await Mutation.run(() => addViaUpload(locs))
				: await Edit.locations(
						MAP,
						locs.map((l) => ({ add: l })),
					);
		t.end({ added: locs.length });
		if (Store.get().map) locs.forEach((l, i) => (l.id = r.mutation.keys[i] ?? l.id));
	},
	/** Add `location` to another map unless that map already holds it, its interned values
	 *  named by `records`. Resolves to whether it was added. Undoable in that map. @unstable */
	addTo: async (
		mapId: string,
		location: Location,
		records: Parameters<typeof Edit.locations>[2],
	): Promise<boolean> => {
		const target: Target = { kind: "map", id: mapId };
		const [held] = await Query.read(
			{ type: "Everything" },
			{ kind: "held", locations: [location] },
			target,
		);
		if (held) return false;
		await Edit.locations(target, [{ add: location }], records);
		return true;
	},
	/** Clone a location in place and return the new id, or null if it doesn't exist. Undoable. */
	duplicate: async (id: number): Promise<number | null> => {
		const state = Store.get();
		if (!state.map) return null;
		const [loc] = await Query.read(
			{ type: "Locations", locations: [id], name: null },
			{ kind: "locations" },
		);
		if (!loc) return null;
		const clone: Location = { ...loc, createdAt: 0 };
		await Location.add([clone]);
		return clone.id;
	},
	/** Remove locations by id. Undoable. */
	remove: async (ids: ReadonlyIdSet) => {
		if (ids.size === 0) return;
		await Edit.locations(
			MAP,
			[...ids].map((id) => ({ remove: id })),
		).catch((e) => log.error("[delete] store_edit remove failed:", e));
	},
	/** Patch locations by id. Only include the fields you're changing; `extra` merges
	 *  per-key (null deletes a key). Undoable by default. */
	update: async (updates: Patch<Location>[]) => {
		if (updates.length === 0) return;
		await Edit.locations(
			MAP,
			updates.map((put) => ({ put })),
		);
	},
	/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. @unstable */
	duplicateGroups: async (distance: number): Promise<number[][]> => {
		return Query.read({ type: "Everything" }, { kind: "duplicateGroups", distance });
	},
};
