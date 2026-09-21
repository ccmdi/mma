// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { mount } from "./fixtures/harness";
import { useItemDrag, type ItemDrag } from "@/lib/hooks/useItemDrag";

function press(session: ItemDrag) {
	let onMouseDown!: ReturnType<typeof useItemDrag<[]>>;
	function Harness() {
		onMouseDown = useItemDrag(() => session);
		return null;
	}
	mount(<Harness />);
	onMouseDown({
		button: 0,
		clientX: 100,
		clientY: 100,
		preventDefault: () => {},
	} as unknown as React.MouseEvent);
}

const mouse = (type: string, x: number, y: number) =>
	window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));

function session() {
	return {
		onStart: vi.fn(),
		onMove: vi.fn(),
		onDrop: vi.fn(),
		onKey: vi.fn(),
		onEnd: vi.fn(),
	};
}

describe("useItemDrag", () => {
	it("a press released within the threshold ends without starting or dropping", () => {
		const s = session();
		press(s);
		mouse("mousemove", 103, 102);
		mouse("mouseup", 103, 102);
		expect(s.onStart).not.toHaveBeenCalled();
		expect(s.onDrop).not.toHaveBeenCalled();
		expect(s.onEnd).toHaveBeenCalledOnce();
	});

	it("starts past the threshold in any direction, then moves, drops and ends", () => {
		const s = session();
		press(s);
		mouse("mousemove", 100, 106);
		expect(s.onStart).toHaveBeenCalledOnce();
		expect(s.onMove).toHaveBeenCalledOnce();
		expect(document.body.style.userSelect).toBe("none");
		mouse("mouseup", 100, 106);
		expect(s.onDrop).toHaveBeenCalledOnce();
		expect(s.onEnd).toHaveBeenCalledOnce();
		expect(document.body.style.userSelect).toBe("");
	});

	it("Escape cancels a started drag without dropping", () => {
		const s = session();
		press(s);
		mouse("mousemove", 110, 100);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		mouse("mouseup", 110, 100);
		expect(s.onDrop).not.toHaveBeenCalled();
		expect(s.onEnd).toHaveBeenCalledOnce();
	});

	it("forwards other keys only while dragging", () => {
		const s = session();
		press(s);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
		expect(s.onKey).not.toHaveBeenCalled();
		mouse("mousemove", 110, 100);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
		window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
		expect(s.onKey).toHaveBeenCalledTimes(2);
		mouse("mouseup", 110, 100);
	});
});
