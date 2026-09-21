// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { mount } from "./fixtures/harness";
import { useFlashState, type FlashState } from "@/lib/hooks/useFlashState";

function probe() {
	const seen: { state: FlashState; run: ReturnType<typeof useFlashState>[1] } = {
		state: "idle",
		run: async () => {},
	};
	function Harness() {
		[seen.state, seen.run] = useFlashState();
		return null;
	}
	mount(<Harness />);
	return seen;
}

function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("useFlashState", () => {
	it("is busy while the task runs, done after it succeeds, then idle again", async () => {
		vi.useFakeTimers();
		const p = probe();
		const task = deferred();
		let running!: Promise<void>;
		act(() => {
			running = p.run(() => task.promise);
		});
		expect(p.state).toBe("busy");
		await act(async () => {
			task.resolve();
			await running;
		});
		expect(p.state).toBe("done");
		act(() => {
			vi.runAllTimers();
		});
		expect(p.state).toBe("idle");
	});

	it("returns to idle and rethrows when the task fails", async () => {
		const p = probe();
		await act(async () => {
			await expect(p.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		});
		expect(p.state).toBe("idle");
	});

	it("ignores a run while another is in flight", async () => {
		const p = probe();
		const first = deferred();
		const second = vi.fn(async () => {});
		let running!: Promise<void>;
		act(() => {
			running = p.run(() => first.promise);
		});
		await act(async () => {
			await p.run(second);
			first.resolve();
			await running;
		});
		expect(second).not.toHaveBeenCalled();
	});
});
