import { useMemo, useState } from "react";
import { Store } from "@/store/store";
import { Scene } from "@/lib/render/scene";
import type { Selector } from "@/types";

/** What the selector picker offers. Not a location set -- `selectorForPick` turns it
 *  into a `Selector`. */
export type SelectorPick = { pick: "all" } | { pick: "selection" };

export interface SelectorPickController {
	/** The picked locations. Hand it straight to any `Selector` consumer. */
	selector: Selector;
	/** The picker's own state. Persist this, not `selector`: it tracks the live selection. */
	choice: SelectorPick;
	setChoice(c: SelectorPick): void;
	allCount: number;
	selectionCount: number;
}

/** Convert a picker choice into the corresponding `Selector`. @api @unstable */
export function selectorForPick(choice: SelectorPick): Selector {
	switch (choice.pick) {
		case "all":
			return { type: "Everything" };
		case "selection":
			return { type: "Selected" };
	}
}

/** React hook: selector state with live counts. Defaults to the current selection when one
 *  exists, else all locations. @api @unstable */
export function useSelectorPick(initial?: SelectorPick): SelectorPickController {
	const selectedIds = Scene.useSelected();
	const allCount = Store.use((s) => s.locationCount);
	const [choice, setChoice] = useState<SelectorPick>(
		() => initial ?? (selectedIds.size > 0 ? { pick: "selection" } : { pick: "all" }),
	);
	const selector = useMemo(() => selectorForPick(choice), [choice]);
	return { selector, choice, setChoice, allCount, selectionCount: selectedIds.size };
}
