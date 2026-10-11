import { Maps } from "./maps";
import { Store } from "@/store/store";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { emit as emitEvent } from "@/lib/events";
import { CommitDiff } from "./commitDiff";

let timer: ReturnType<typeof setTimeout> | null = null;
/** Every write to the map's files, each starting only after the one before has finished. */
let writes: Promise<void> = Promise.resolve();
const DELAY_MS = 2000;

let holds = 0;
let deferred = false;

function save(): Promise<void> {
	return Autosave.exclusive(async () => {
		if (!Store.get().map) return;
		const t = trace("save");
		try {
			await cmd.storeSaveDirty();
			t.end();
			void Maps.invalidate();
		} catch (err) {
			Autosave.schedule();
			log.error("Autosave failed, will retry:", err);
		}
	});
}

export const Autosave = {
	/** Defer autosave until the returned release function runs. Useful for batches that land many mutations. @unstable */
	hold: (): (() => void) => {
		holds++;
		return () => {
			holds--;
			if (holds === 0 && deferred) {
				deferred = false;
				Autosave.schedule();
			}
		};
	},
	/** Schedule a debounced autosave. Mutations call this automatically. @unstable */
	schedule: () => {
		if (holds > 0) {
			deferred = true;
			return;
		}
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void save();
		}, DELAY_MS);
	},
	/** Cancel any pending autosave timer. @unstable */
	cancel: () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	},
	/** Wait until every save and background commit started so far has finished. @unstable */
	waitForInflight: (): Promise<void> => {
		return writes;
	},
	/** Run `write` once every save started so far has finished, and hold later saves until it does.
	 *  Writes to the map's files that must not interleave with a save go through here. @unstable */
	exclusive: <T>(write: () => Promise<T>): Promise<T> => {
		Autosave.cancel();
		const result = writes.then(write);
		writes = result.then(
			() => {},
			() => {},
		);
		return result;
	},
	/** Background auto-commit after an import with autoCommit set. @unstable */
	scheduleAutoCommit: (mapId: string, importedCount: number) => {
		void Autosave.exclusive(() => cmd.storeCommit(mapId, `Import ${importedCount} locations`))
			.then(() => {
				CommitDiff.resetCounts();
				void Maps.invalidate();
			})
			.catch((e: unknown) => log.error("[import] background commit failed:", e))
			.finally(() => emitEvent("store:changed"));
	},
	/** Save any unsaved changes now instead of waiting for the timer. @unstable */
	flush: (): Promise<void> => save(),
};
