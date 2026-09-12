// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { useFoundRate } from "@/plugins/generator/ui/progressSignal";
import { mount } from "./fixtures/harness";

function Probe({ v, active = true }: { v: number; active?: boolean }) {
	const rate = useFoundRate(v, 1000, active);
	return <output>{rate ?? "none"}</output>;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("useFoundRate", () => {
	it("answers nothing before a rate is observable", async () => {
		const m = mount(<Probe v={0} />);
		await act(async () => {});
		expect(m.container.textContent).toBe("none");
		m.unmount();
	});

	it("answers the observed pace once counts have moved", async () => {
		const m = mount(<Probe v={0} />);
		await act(async () => {});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		await act(async () => {
			m.root.render(<Probe v={10} />);
		});
		expect(Number(m.container.textContent)).toBe(10);
		m.unmount();
	});

	it("inactive answers nothing and drops its anchor", async () => {
		const m = mount(<Probe v={0} />);
		await act(async () => {});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		await act(async () => {
			m.root.render(<Probe v={10} />);
		});
		await act(async () => {
			m.root.render(<Probe v={10} active={false} />);
		});
		expect(m.container.textContent).toBe("none");
		m.unmount();
	});
});
