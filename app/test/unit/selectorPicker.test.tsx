// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// The picker lists saved rules; this suite is about the radios, so keep the list empty
// rather than reaching for the store.
vi.mock("@/store/savedSelections", () => ({ useSavedSelectionIndex: () => [] }));

import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import type { SelectorPickController } from "@/store/selectorPick";

const ctl = (over: Partial<SelectorPickController>): SelectorPickController => ({
	selector: { type: "Everything" },
	choice: { pick: "all" },
	setChoice: () => {},
	allCount: 1234,
	selectionCount: 0,
	...over,
});

describe("SelectorPicker", () => {
	it("checks the radio matching the pick", () => {
		const all = renderToStaticMarkup(<SelectorPicker ctl={ctl({ choice: { pick: "all" } })} />);
		// first (all) radio checked, second not
		expect(all.match(/checked=""/g)?.length).toBe(1);
		expect(all).toMatch(/All locations/);

		const sel = renderToStaticMarkup(
			<SelectorPicker ctl={ctl({ choice: { pick: "selection" }, selectionCount: 3 })} />,
		);
		expect(sel.match(/checked=""/g)?.length).toBe(1);
		expect(sel).toMatch(/Current selection/);
	});

	it("disables and dims the selection option when nothing is selected", () => {
		const html = renderToStaticMarkup(<SelectorPicker ctl={ctl({ selectionCount: 0 })} />);
		expect(html).toMatch(/disabled=""/);
		expect(html).toMatch(/opacity:0\.5/);
	});

	it("renders formatted counts", () => {
		const html = renderToStaticMarkup(
			<SelectorPicker ctl={ctl({ allCount: 1234, selectionCount: 56 })} />,
		);
		expect(html).toMatch(/1,234/);
		expect(html).toMatch(/56/);
	});
});
