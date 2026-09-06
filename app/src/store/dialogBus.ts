import { useEffect, useEffectEvent, useState, type Dispatch, type SetStateAction } from "react";

type DialogPayloads = {
	commit: void;
	export: void;
	import: void;
	history: void;
	seen: void;
	"copy-to-map": void;
	"quick-copy-to-map": number;
	"tag-find-replace": void;
	"apply-field-as-tags": void;
	"merge-duplicates": void;
	"save-selections": void;
	"apply-saved-selection": void;
	"review-sessions": void;
	"review-selected": void;
	"doclink-assign": void;
	"command-palette": void;
	feedback: void;
	"bulk-op": string;
	"plugin-modal": string;
	"inline-panel": string;
};

export type DialogKey = keyof DialogPayloads;

type VoidDialogKey = { [K in DialogKey]: DialogPayloads[K] extends void ? K : never }[DialogKey];

type Handler<K extends DialogKey> = DialogPayloads[K] extends void
	? () => void
	: (payload: DialogPayloads[K]) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cb = (...args: any[]) => void;
const listeners = new Map<DialogKey, Set<Cb>>();

export function openDialog<K extends DialogKey>(
	...args: DialogPayloads[K] extends void ? [key: K] : [key: K, payload: DialogPayloads[K]]
): void {
	const [key, payload] = args as [K, unknown];
	const set = listeners.get(key);
	if (set) for (const fn of set) fn(payload);
}

export function useDialog<K extends DialogKey>(key: K, handler: Handler<K>): void {
	const stable = useEffectEvent(handler);
	useEffect(() => {
		let set = listeners.get(key);
		if (!set) {
			set = new Set();
			listeners.set(key, set);
		}
		set.add(stable as Cb);
		return () => {
			set!.delete(stable as Cb);
			if (set!.size === 0) listeners.delete(key);
		};
	}, [key]);
}

/** Local open state for a dialog the bus can also open. */
export function useDialogState(key: VoidDialogKey): [boolean, Dispatch<SetStateAction<boolean>>] {
	const [open, setOpen] = useState(false);
	useDialog(key, () => setOpen(true));
	return [open, setOpen];
}
