import { describe, it, expect, vi } from "vitest";
import { createSelectorPick, selectorForPick } from "@/store/selectorPick";

// A missing saved rule triggers a body fetch; there is no Tauri host here to answer it.
vi.mock("@/lib/commands", () => ({ cmd: { storeGetSavedSelections: async () => [] } }));

describe("selectorForPick", () => {
	it("turns each pick into a Selector -- the only language below the UI", () => {
		expect(selectorForPick({ pick: "all" })).toEqual({ type: "Everything" });
		// Nothing selected, so the live selection is an empty union rather than a sentinel.
		expect(selectorForPick({ pick: "selection" })).toEqual({ type: "Union", selections: [] });
		// A saved rule that this map cannot resolve contributes no members.
		expect(selectorForPick({ pick: "saved", id: "missing" })).toEqual({
			type: "Locations",
			locations: [],
			name: null,
		});
	});
});

describe("createSelectorPick", () => {
	it("get/set holds the pick and derives the selector, notifying subscribers", () => {
		const h = createSelectorPick({ pick: "all" });
		const cb = vi.fn();
		const unsub = h.subscribe(cb);
		expect(h.getChoice()).toEqual({ pick: "all" });
		expect(h.get()).toEqual({ type: "Everything" });

		h.set({ pick: "selection" });
		expect(h.getChoice()).toEqual({ pick: "selection" });
		expect(cb).toHaveBeenCalledTimes(1);

		h.set({ pick: "selection" }); // no-op, same pick
		expect(cb).toHaveBeenCalledTimes(1);

		unsub();
		h.set({ pick: "all" });
		expect(cb).toHaveBeenCalledTimes(1); // unsubscribed, not notified
	});

	it("handles are isolated — one consumer's choice never leaks into another", () => {
		const a = createSelectorPick({ pick: "all" });
		const b = createSelectorPick({ pick: "all" });
		a.set({ pick: "selection" });
		expect(a.getChoice()).toEqual({ pick: "selection" });
		expect(b.getChoice()).toEqual({ pick: "all" });
	});
});
