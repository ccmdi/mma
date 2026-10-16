import { Store } from "./store";
import { Autosave } from "./autosave";
import type { ChangeEvent } from "@/bindings.gen";
import { Channel } from "@tauri-apps/api/core";
import { emit as emitEvent } from "@/lib/events";
import { watermark } from "@/lib/util/watermark";

const delivered = watermark<void>(() => {});
let following: Channel<ChangeEvent> | null = null;
let held: ChangeEvent[] | null = null;

function applyChange(e: ChangeEvent) {
	const moved = e.version > delivered.version();
	delivered.pass(e.version);
	if (!Store.get().map) return;
	Store.apply(e.patch, e.version);
	if (moved) Autosave.schedule();
	emitEvent("store:change", e);
}

export const Feed = {
	/** A channel for the next open to deliver its changes on, holding them until `seed`. */
	channel: () => {
		const ch = new Channel<ChangeEvent>();
		ch.onmessage = (e) => {
			if (ch !== following) return;
			if (held) held.push(e);
			else applyChange(e);
		};
		following = ch;
		held = [];
		return ch;
	},
	seed: (version: number) => {
		delivered.reset(version, () => {});
		const waiting = held ?? [];
		held = null;
		waiting.forEach(applyChange);
	},
	/** Resolves once the change feed has delivered `version`'s event (or a later one), or the map closes. */
	waitFor: (version: number): Promise<void> => {
		return delivered.reached(version);
	},
	reset: () => {
		delivered.reset(0, () => {});
		following = null;
		held = null;
	},
};
