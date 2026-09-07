import { useMemo, useState, useSyncExternalStore } from "react";
import type { Selector } from "@/bindings.gen";
import { savedSelector } from "./savedSelections";

import { useMapState, currentSelection } from "./useMapStore";

/** What the selector picker offers. Not a location set -- `selectorForPick` turns it
 *  into a `Selector`. */
export type SelectorPick = { pick: "all" } | { pick: "selection" } | { pick: "saved"; id: string };

export interface SelectorPickController {
	/** The picked locations. Hand it straight to any `Selector` consumer. */
	selector: Selector;
	/** The picker's own state. Persist this, not `selector`: it tracks the live selection. */
	choice: SelectorPick;
	setChoice(c: SelectorPick): void;
	allCount: number;
	selectionCount: number;
	/** Opt-in: the picker additionally offers saved selections. */
	saved?: boolean;
}

/** Convert a picker choice into the corresponding `Selector`. */
export function selectorForPick(choice: SelectorPick): Selector {
	switch (choice.pick) {
		case "all":
			return { type: "Everything" };
		case "selection":
			return currentSelection();
		case "saved":
			return savedSelector(choice.id);
	}
}

function defaultChoice(selectionCount: number): SelectorPick {
	return selectionCount > 0 ? { pick: "selection" } : { pick: "all" };
}

/** React hook: selector state with live counts. Defaults to the current selection when one
 *  exists, else all locations. Use `createSelectorPick` when non-React code also reads the selector. */
export function useSelectorPick(initial?: SelectorPick): SelectorPickController {
	const selections = useMapState((s) => s.selections);
	const selectedIds = useMapState((s) => s.selectedLocationIds);
	const allCount = useMapState((s) => s.locationCount);
	const [choice, setChoice] = useState<SelectorPick>(
		() => initial ?? defaultChoice(selectedIds.size),
	);
	// `selections` is the invalidation key, not a value read here: selectorForPick reads
	// the live selection, which eslint cannot see.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const selector = useMemo(() => selectorForPick(choice), [choice, selections]);
	return { selector, choice, setChoice, allCount, selectionCount: selectedIds.size };
}

/** A standalone selector store that can be read from both React and non-React code.
 *  Each `createSelectorPick` call returns an isolated instance. */
export interface SelectorPickHandle {
	get(): Selector;
	getChoice(): SelectorPick;
	set(choice: SelectorPick): void;
	subscribe(listener: () => void): () => void;
	/** React view of this handle: re-renders on change, with live counts. */
	use(): SelectorPickController;
}

/** A standalone "all locations vs current selection" switch, for features that operate on a subset. */
export function createSelectorPick(initial?: SelectorPick): SelectorPickHandle {
	let choice: SelectorPick = initial ?? { pick: "all" };
	const listeners = new Set<() => void>();
	const getChoice = () => choice;
	const set = (next: SelectorPick) => {
		if (JSON.stringify(next) === JSON.stringify(choice)) return;
		choice = next;
		for (const l of listeners) l();
	};
	const sub = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	return {
		get: () => selectorForPick(choice),
		getChoice,
		set,
		subscribe: sub,
		use(): SelectorPickController {
			useSyncExternalStore(sub, getChoice);
			const selections = useMapState((s) => s.selections);
			const selectedIds = useMapState((s) => s.selectedLocationIds);
			const allCount = useMapState((s) => s.locationCount);
			// eslint-disable-next-line react-hooks/exhaustive-deps -- as in useSelectorPick
			const selector = useMemo(() => selectorForPick(choice), [choice, selections]);
			return {
				selector,
				choice,
				setChoice: set,
				allCount,
				selectionCount: selectedIds.size,
			};
		},
	};
}
