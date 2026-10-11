import { Maps } from "./maps";
import { Store } from "./store";
import { Mutation } from "./mutation";
import { Autosave } from "./autosave";
import { cmd } from "@/lib/commands";
import { trace } from "@/lib/util/debug";
import { Scene } from "@/lib/render/scene";
import { CommitDiff } from "./commitDiff";
import { Editor } from "./editor";

export const Commit = {
	/** Commit all pending changes to the map's version history. Clears the undo stack. */
	create: async (message?: string): Promise<string> => {
		const state = Store.get();
		if (!state.mapId) throw new Error("No map open");
		const t = trace("commit");
		const r = await Autosave.exclusive(() => cmd.storeCommit(Store.get().mapId!, message ?? null));
		t.step("commit");
		t.end();
		CommitDiff.resetCounts();
		void Maps.invalidate();
		return r.id;
	},
	/** Restore a previous commit as a new revert commit and refresh the view. Clears undo/redo. @unstable */
	checkout: async (commitId: string) => {
		const state = Store.get();
		if (!state.mapId) return;
		await Autosave.flush();
		await Mutation.run(() => cmd.storeCheckoutCommit(Store.get().mapId!, commitId));
		await Autosave.exclusive(() =>
			cmd.storeCommit(Store.get().mapId!, `Revert to ${commitId.slice(0, 7)}`),
		);
		const map = await cmd.storeGetMap(Store.get().mapId!);
		if (map) Store.setMeta(map);
		if (Store.get().open) Editor.close();

		void Scene.load();
		await Maps.invalidate();
	},
};
