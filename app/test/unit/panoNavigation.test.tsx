// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { mount as mountRoot } from "./fixtures/harness";

const viewer = vi.hoisted(() => ({
	exists: () => true,
	nudge: vi.fn(),
	step: vi.fn(() => true),
}));
vi.mock("@/lib/hooks/usePano", () => ({ usePano: () => viewer }));

import { usePanoNavigation } from "@/components/editor/location/usePanoNavigation";
import { getSettings, type MovementMode } from "@/store/settings";

function Harness({ mode }: { mode: MovementMode }) {
	usePanoNavigation({ ...getSettings(), defaultMovementMode: mode });
	return null;
}

function mount(mode: MovementMode) {
	return mountRoot(<Harness mode={mode} />).unmount;
}

const press = (key: string, init: KeyboardEventInit = {}) =>
	document.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));

const waitFrames = async (n: number) => {
	await act(async () => {
		for (let i = 0; i < n; i++) {
			await new Promise((r) => requestAnimationFrame(r));
		}
	});
};

beforeEach(() => {
	viewer.step.mockClear();
	viewer.nudge.mockClear();
});

describe("usePanoNavigation movement-mode gates", () => {
	it("move hotkey navigates in moving mode", () => {
		const unmount = mount("moving");
		press("ArrowUp", { shiftKey: true });
		expect(viewer.step).toHaveBeenCalledWith("forward");
		unmount();
	});

	it("move hotkey is a no-op in no-move mode", () => {
		const unmount = mount("no-move");
		press("ArrowUp", { shiftKey: true });
		expect(viewer.step).not.toHaveBeenCalled();
		unmount();
	});

	it("move hotkey is a no-op in nmpz mode", () => {
		const unmount = mount("nmpz");
		press("ArrowUp", { shiftKey: true });
		expect(viewer.step).not.toHaveBeenCalled();
		unmount();
	});

	it("look hotkey pans in no-move mode", async () => {
		const unmount = mount("no-move");
		press("ArrowLeft");
		await waitFrames(2);
		expect(viewer.nudge).toHaveBeenCalled();
		unmount();
	});

	it("look hotkey is a no-op in nmpz mode", async () => {
		const unmount = mount("nmpz");
		press("ArrowLeft");
		await waitFrames(2);
		expect(viewer.nudge).not.toHaveBeenCalled();
		unmount();
	});
});
