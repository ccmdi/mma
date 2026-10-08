import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { emit as emitEvent } from "@/lib/events";
import { resetCommitDiffCounts } from "./commitDiff";
import { invalidateMapList } from "./mapList";
import { getMapState } from "./useMapStore";

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
const DELAY_MS = 2000;

let holds = 0;
let deferred = false;

/** Defer autosave until the returned release function runs. Useful for batches that land many mutations. @unstable */
export function hold(): () => void {
	holds++;
	return () => {
		holds--;
		if (holds === 0 && deferred) {
			deferred = false;
			schedule();
		}
	};
}

/** Schedule a debounced autosave. Mutations call this automatically. @unstable */
export function schedule() {
	if (holds > 0) {
		deferred = true;
		return;
	}
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		void save();
	}, DELAY_MS);
}

/** Cancel any pending autosave timer. @unstable */
export function cancel() {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}

/** Wait for any in-progress save to finish. @unstable */
export function waitForInflight() {
	return inflight;
}

/** Background auto-commit after an import with autoCommit set. @unstable */
export function scheduleAutoCommit(mapId: string, importedCount: number) {
	inflight = cmd
		.storeCommit(mapId, `Import ${importedCount} locations`)
		.then(() => {
			resetCommitDiffCounts();
			void invalidateMapList();
		})
		.catch((e: unknown) => log.error("[import] background commit failed:", e))
		.finally(() => {
			inflight = null;
			emitEvent("store:changed");
		});
}

async function save(): Promise<void> {
	const { mapId, map } = getMapState();
	if (!mapId || !map) return;
	await inflight;

	const t = trace("save");
	inflight = cmd
		.storeSaveDirty()
		.then(() => {
			t.end();
			void invalidateMapList();
		})
		.catch((err) => {
			schedule();
			log.error("Autosave failed, will retry:", err);
		})
		.finally(() => {
			inflight = null;
		});
	await inflight;
}

/** Save any unsaved changes now instead of waiting for the timer. @unstable */
export async function flush(): Promise<void> {
	cancel();
	await save();
}
