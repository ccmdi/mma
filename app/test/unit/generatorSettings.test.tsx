// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/store/settings", () => ({
	getSettings: () => ({ units: "metric" }),
	useSetting: () => "metric",
}));

import { DEFAULT_SETTINGS, type GeneratorSettings } from "@/plugins/generator/engine/types";
import { SettingsPanel } from "@/plugins/generator/ui/SettingsPanel";
import { mount } from "./fixtures/harness";

function render(objective: "count" | "spacing", running = false) {
	return mount(
		<SettingsPanel
			settings={{ ...DEFAULT_SETTINGS, objective }}
			onChange={() => {}}
			running={running}
		/>,
	);
}

describe("generator objective settings", () => {
	it("shows sampling allocation only for Count and distance only for Spacing", () => {
		const count = render("count");
		expect(count.container.textContent).toContain("Goal");
		expect(count.container.textContent).toContain("Sampling");
		expect(count.container.textContent).not.toContain("Spacing (");

		const spacing = render("spacing");
		expect(spacing.container.textContent).toContain("Spacing (");
		expect(spacing.container.textContent).toContain("Spacing defines the probe plan.");
		expect(spacing.container.textContent).not.toContain("Sampling");
	});

	it("freezes plan-defining controls while generation runs", () => {
		const view = render("spacing", true);
		const count = [...view.container.querySelectorAll("button")].find(
			(button) => button.textContent === "Count",
		);
		const spacing = [...view.container.querySelectorAll("input")].find((input) =>
			input.closest("label")?.textContent?.startsWith("Spacing"),
		);

		expect(count?.disabled).toBe(true);
		expect(spacing?.disabled).toBe(true);
	});
});

describe("generator ranges", () => {
	function field(container: HTMLElement, label: string, nth = 0) {
		return [...container.querySelectorAll("label")]
			.filter((l) => l.textContent?.trim().startsWith(label))
			.map((l) => l.querySelector("input") as HTMLInputElement)[nth];
	}

	function leaveWith(input: HTMLInputElement, text: string) {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		act(() => {
			input.focus();
			setter.call(input, text);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.blur();
		});
	}

	function render(settings: Partial<GeneratorSettings>) {
		const changes: Partial<GeneratorSettings>[] = [];
		const view = mount(
			<SettingsPanel
				settings={{ ...DEFAULT_SETTINGS, ...settings }}
				onChange={(next) => changes.push(next)}
				running={false}
			/>,
		);
		return { container: view.container, changes };
	}

	it("keeps the link count pair from crossing", () => {
		const { container, changes } = render({ filterByLinks: true, minLinks: 1, maxLinks: 5 });
		const advanced = [...container.querySelectorAll(".plugin-section__trigger")].find(
			(trigger) => trigger.textContent === "Advanced filters",
		) as HTMLElement;
		act(() => advanced.click());
		leaveWith(field(container, "Min"), "8");
		expect(changes.at(-1)?.minLinks).toBe(5);
		leaveWith(field(container, "Max"), "0");
		expect(changes.at(-1)?.maxLinks).toBe(1);
	});

	it("stores months as two digits and keeps years in order", () => {
		const { container, changes } = render({
			selectMonths: true,
			rejectOfficial: false,
			fromYear: "2010",
			toYear: "2015",
		});
		leaveWith(field(container, "From month"), "3");
		expect(changes.at(-1)?.fromMonth).toBe("03");
		leaveWith(field(container, "Between years"), "2020");
		expect(changes.at(-1)?.fromYear).toBe("2015");
	});
});
