// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createElement, act } from "react";
import { mount } from "./fixtures/harness";
import { createSelectorPick, type SelectorPickController } from "@/store/selectorPick";

let result: SelectorPickController;

describe("createSelectorPick.use", () => {
	it("re-derives the selector when the pick changes after mount", async () => {
		const h = createSelectorPick({ pick: "all" });
		function Probe() {
			// eslint-disable-next-line react-hooks/globals -- renderHook-style probe
			result = h.use();
			return null;
		}
		mount(createElement(Probe), { attach: false });
		expect(result.selector).toEqual({ type: "Everything" });
		expect(result.choice).toEqual({ pick: "all" });

		await act(async () => h.set({ pick: "selection" }));

		expect(result.selector).toEqual({ type: "Selected" });
		expect(result.choice).toEqual({ pick: "selection" });
	});
});
