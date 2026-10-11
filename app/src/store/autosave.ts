import { Maps } from "./maps";
import { Store } from "@/store/store";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { emit as emitEvent } from "@/lib/events";
import { resetCommitDiffCounts } from "./commitDiff";

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
const DELAY_MS = 2000;

let holds = 0;
let deferred = false;

async function save(): Promise<void> {
	const { mapId, map } = Store.get();
	if (!mapId || !map) return;
	await inflight;

	const t = trace("save");
	inflight = cmd
		.storeSaveDirty()
		.then(() => {
			t.end();
			void Maps.invalidate();
		})
		.catch((err) => {
			Autosave.schedule();
			log.error("Autosave failed, will retry:", err);
		})
		.finally(() => {
			inflight = null;
		});
	await inflight;
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
	/** Wait for any in-progress save to finish. @unstable */
	waitForInflight: () => {
		return inflight;
	},
	/** Background auto-commit after an import with autoCommit set. @unstable */
	scheduleAutoCommit: (mapId: string, importedCount: number) => {
		inflight = cmd
			.storeCommit(mapId, `Import ${importedCount} locations`)
			.then(() => {
				resetCommitDiffCounts();
				void Maps.invalidate();
			})
			.catch((e: unknown) => log.error("[import] background commit failed:", e))
			.finally(() => {
				inflight = null;
				emitEvent("store:changed");
			});
	},
	/** Save any unsaved changes now instead of waiting for the timer. @unstable */
	flush: async (): Promise<void> => {
		Autosave.cancel();
		await save();
	},
};
