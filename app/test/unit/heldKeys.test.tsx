// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { mount } from "./fixtures/harness";
import { useHeldKeys } from "@/lib/hooks/useHeldKeys";
import { parseHotkey } from "@/lib/hooks/useHotkey";
import { getBinding } from "@/lib/util/hotkeys";

const ACTIONS = ["panLeft"] as const;
const panLeftKey = parseHotkey(getBinding("panLeft"))[0][0].key;

function probe(onPress?: () => boolean) {
	const ticks = vi.fn();
	let held: ReadonlySet<string> = new Set();
	function Harness() {
		held = useHeldKeys(ACTIONS, true, { onTick: ticks, onPress });
		return null;
	}
	const { unmount } = mount(<Harness />);
	return { ticks, held: () => held, unmount };
}

const key = (type: "keydown" | "keyup", init: KeyboardEventInit = {}) =>
	document.dispatchEvent(new KeyboardEvent(type, { key: panLeftKey, cancelable: true, ...init }));

const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(r)));

describe("useHeldKeys", () => {
	it("ticks while a bound key is held and stops once it is released", async () => {
		const p = probe();
		key("keydown");
		await nextFrame();
		expect(p.ticks).toHaveBeenCalled();
		expect(p.held().has("panLeft")).toBe(true);
		key("keyup");
		await nextFrame();
		p.ticks.mockClear();
		await nextFrame();
		expect(p.ticks).not.toHaveBeenCalled();
	});

	it("does not hold a press that onPress declines", async () => {
		const p = probe(() => false);
		key("keydown");
		await nextFrame();
		expect(p.held().size).toBe(0);
		expect(p.ticks).not.toHaveBeenCalled();
	});

	it("passes the Alt state to each tick", async () => {
		const p = probe();
		key("keydown", { altKey: true });
		await nextFrame();
		expect(p.ticks).toHaveBeenLastCalledWith(expect.anything(), expect.any(Number), true);
	});

	it("releases every held key when the window loses focus", async () => {
		const p = probe();
		key("keydown");
		window.dispatchEvent(new Event("blur"));
		expect(p.held().size).toBe(0);
	});

	it("releases every held key on unmount", () => {
		const p = probe();
		key("keydown");
		const held = p.held();
		p.unmount();
		expect(held.size).toBe(0);
	});
});
