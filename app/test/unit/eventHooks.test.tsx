// @vitest-environment jsdom
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { emit, useEvent, useEventValue } from "@/lib/events";
import { mount } from "./fixtures/harness";

const h = vi.hoisted(() => ({ value: 0, versions: [] as number[], values: [] as number[] }));

function EventProbe() {
	h.versions.push(useEvent(["settings:changed", "plugins:changed"]));
	return null;
}

function ValueProbe() {
	h.values.push(useEventValue("settings:changed", () => h.value));
	return null;
}

describe("event hooks", () => {
	it("re-renders a version subscriber for each subscribed event", async () => {
		h.versions = [];
		const root = mount(createElement(EventProbe), { attach: false });

		await act(async () => emit("settings:changed"));
		await act(async () => emit("plugins:changed"));
		await act(async () => emit("toasts:changed"));

		root.unmount();
		const initial = h.versions[0];
		expect(h.versions).toEqual([initial, initial + 1, initial + 2]);
	});

	it("subscribes a value reader to its event and rerenders only when the value changes", async () => {
		h.value = 3;
		h.values = [];
		const root = mount(createElement(ValueProbe), { attach: false });

		await act(async () => emit("settings:changed"));
		expect(h.values).toEqual([3]);

		h.value = 4;
		await act(async () => emit("settings:changed"));
		root.unmount();
		expect(h.values).toEqual([3, 4]);
	});
});
