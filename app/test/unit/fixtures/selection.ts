import type { Selection } from "@/bindings.gen";
import type { Selector } from "@/types";
import { childSelections, withChildren } from "@/store/selections";

export function selectionFixture(
	selector: Selector,
	color: Selection["color"] = [128, 128, 128],
): Selection {
	const children = childSelections(selector).map((child) =>
		selectionFixture(child.selector, child.color ?? color),
	);
	const stored = withChildren(selector, children) as Selection["selector"];
	return { key: `fixture:${JSON.stringify(stored)}`, color, selector: stored };
}
