import { Store } from "./store";
import { Mutation } from "./mutation";
import { Autosave } from "./autosave";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { Scene } from "@/lib/render/scene";
import { Editor } from "./editor";

/** Save and restore map versions. @api */
export const Commit = {
	/** Commit all pending changes to the map's version history. Clears the undo stack. */
	create: async (message?: string): Promise<string> => {
		const state = Store.get();
		if (!state.mapId) throw new Error("No map open");
		const t = trace("commit");
		const r = await Autosave.exclusive(() => cmd.storeCommit(Store.get().mapId!, message ?? null));
		t.step("commit");
		t.end();
		return r.id;
	},
	/** Commit `mapId` in the background once pending saves finish. @unstable */
	background: (mapId: string, message: string) => {
		void Autosave.exclusive(() => cmd.storeCommit(mapId, message)).catch((e: unknown) =>
			log.error("[commit] background commit failed:", e),
		);
	},
	/** Restore a previous commit as a new revert commit and refresh the view. Clears undo/redo. @unstable */
	checkout: async (commitId: string) => {
		const state = Store.get();
		if (!state.mapId) return;
		await Autosave.flush();
		const restored = await cmd.storeCheckoutCommit(Store.get().mapId!, commitId);
		if (restored) await Mutation.settle(restored);
		await Autosave.exclusive(() =>
			cmd.storeCommit(Store.get().mapId!, `Revert to ${commitId.slice(0, 7)}`),
		);
		if (Editor.get().open) Editor.close();

		void Scene.load();
	},
};
