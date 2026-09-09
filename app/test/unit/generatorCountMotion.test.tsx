// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { useCountMotion } from "@/plugins/generator/ui/progressSignal";
import { mount } from "./fixtures/harness";

function Probe({ v, active = true }: { v: number; active?: boolean }) {
	const { shown } = useCountMotion(v, 1000, active);
	return <output>{shown}</output>;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
});
afterEach(() => {
	vi.useRealTimers();
});

const frames = async (n: number) => {
	for (let i = 0; i < n; i++) {
		await act(async () => {
			vi.advanceTimersToNextFrame();
		});
	}
};

describe("useCountMotion", () => {
	it("snaps while no rate is observable yet", async () => {
		const m = mount(<Probe v={0} />);
		const shown = () => Number(m.container.textContent);
		await act(async () => {});
		await act(async () => {
			m.root.render(<Probe v={7} />);
		});
		expect(shown()).toBe(7);
		m.unmount();
	});

	it("advances at the observed rate and clamps at the real count", async () => {
		const m = mount(<Probe v={0} />);
		const shown = () => Number(m.container.textContent);
		await act(async () => {});
		// establish a 10/s rate: 10 finds over one second
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		await act(async () => {
			m.root.render(<Probe v={10} />);
		});

		await frames(30); // ~0.5s at 10/s: partway up
		expect(shown()).toBeGreaterThan(0);
		expect(shown()).toBeLessThan(10);

		await frames(60); // well past 1s: clamped at the real count
		expect(shown()).toBe(10);

		await frames(30); // and stays there
		expect(shown()).toBe(10);
		m.unmount();
	});

	it("a count that went down snaps immediately", async () => {
		const m = mount(<Probe v={50} />);
		const shown = () => Number(m.container.textContent);
		await act(async () => {});
		await act(async () => {
			m.root.render(<Probe v={5} />);
		});
		expect(shown()).toBe(5);
		m.unmount();
	});

	it("inactive shows the real count with no rate", async () => {
		const m = mount(<Probe v={0} active={false} />);
		const shown = () => Number(m.container.textContent);
		await act(async () => {});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		await act(async () => {
			m.root.render(<Probe v={9} active={false} />);
		});
		expect(shown()).toBe(9);
		m.unmount();
	});
});
