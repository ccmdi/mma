import { Store } from "./store";
import { Autosave } from "./autosave";
import type { ChangeEvent } from "@/bindings.gen";
import { Channel } from "@tauri-apps/api/core";
import { cmd } from "@/lib/commands";
import { emit as emitEvent } from "@/lib/events";

let feedVersion = 0;
let feedWaiters: { version: number; resolve: () => void }[] = [];

/** Resolves once the change feed has delivered `version`'s event (or a later one). */
function waitFor(version: number): Promise<void> {
	if (feedVersion >= version) return Promise.resolve();
	return new Promise((resolve) => feedWaiters.push({ version, resolve }));
}

function applyChange(e: ChangeEvent) {
	feedVersion = Math.max(feedVersion, e.version);
	feedWaiters = feedWaiters.filter((w) => {
		if (e.version < w.version) return true;
		w.resolve();
		return false;
	});
	if (!Store.get().map) return;
	Store.merge(e.derived);
	Autosave.schedule();
	emitEvent("store:change", e);
	emitEvent("store:changed");
}

function seed(version: number) {
	feedVersion = version;
}

function reset() {
	feedVersion = 0;
	feedWaiters = [];
}

async function start() {
	const ch = new Channel<ChangeEvent>();
	ch.onmessage = applyChange;
	await cmd.storeSubscribeChanges(ch);
}

export const Feed = {
	seed,
	waitFor,
	reset,
	start,
};
