// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { mount } from "./fixtures/harness";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { emit, track, useTracked } = await import("@/lib/events");

let a = false;
let b = false;
const readA = () => {
	track("scene:changed");
	return a;
};
const readB = () => {
	track("editor:changed");
	return b;
};

function Probe({ read }: { read: () => boolean }) {
	return <span>{String(useTracked(read))}</span>;
}

describe("useTracked", () => {
	it("follows state a read only reaches once earlier state moved", () => {
		a = false;
		b = false;
		const { container } = mount(<Probe read={() => readA() && readB()} />);
		expect(container.textContent).toBe("false");

		a = true;
		act(() => emit("scene:changed"));
		expect(container.textContent).toBe("false");

		b = true;
		act(() => emit("editor:changed"));
		expect(container.textContent).toBe("true");
	});

	it("ignores events for state the read did not touch", () => {
		a = false;
		let renders = 0;
		function Counted() {
			renders++;
			return <span>{String(useTracked(readA))}</span>;
		}
		mount(<Counted />);
		const before = renders;
		act(() => emit("editor:changed"));
		expect(renders).toBe(before);
	});
});
