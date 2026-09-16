// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { useFoundRate } from "@/plugins/generator/ui/progressSignal";
import { mount } from "./fixtures/harness";

function Probe({ v, active = true }: { v: number; active?: boolean }) {
	const rate = useFoundRate(v, active);
	return <output>{rate ?? "none"}</output>;
}

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
	});
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
		await advance(1000);
		await act(async () => {
			m.root.render(<Probe v={10} />);
		});
		await advance(500);
		expect(Number(m.container.textContent)).toBeCloseTo(10 / 1.5, 1);
		m.unmount();
	});

	it("a quiet stretch decays the rate instead of freezing it", async () => {
		const m = mount(<Probe v={0} />);
		await act(async () => {});
		await advance(1000);
		await act(async () => {
			m.root.render(<Probe v={100} />);
		});
		await advance(500);
		const busy = Number(m.container.textContent);
		await advance(4000);
		const quiet = Number(m.container.textContent);
		expect(quiet).toBeLessThan(busy / 2);
		m.unmount();
	});

	it("forgets counts older than the window", async () => {
		const m = mount(<Probe v={0} />);
		await act(async () => {});
		await act(async () => {
			m.root.render(<Probe v={100} />);
		});
		await advance(12_000);
		expect(Number(m.container.textContent)).toBe(0);
		m.unmount();
	});

	it("a count that went backward starts a fresh window", async () => {
		const m = mount(<Probe v={50} />);
		await act(async () => {});
		await advance(1000);
		await act(async () => {
			m.root.render(<Probe v={5} />);
		});
		await advance(500);
		expect(m.container.textContent).toBe("none");
		m.unmount();
	});

	it("inactive answers nothing and drops its window", async () => {
		const m = mount(<Probe v={0} />);
		await act(async () => {});
		await advance(1000);
		await act(async () => {
			m.root.render(<Probe v={10} />);
		});
		await advance(500);
		await act(async () => {
			m.root.render(<Probe v={10} active={false} />);
		});
		expect(m.container.textContent).toBe("none");
		m.unmount();
	});
});
