import { describe, expect, it, vi } from "vitest";
import { debounce, delay, serial } from "@/lib/util/concurrent";

describe("delay", () => {
	it("resolves after its time and rejects with the signal's reason once aborted", async () => {
		vi.useFakeTimers();
		try {
			const done = vi.fn();
			void delay(300).then(done);
			await vi.advanceTimersByTimeAsync(299);
			expect(done).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(done).toHaveBeenCalled();
			const controller = new AbortController();
			const waiting = delay(300, controller.signal);
			controller.abort("superseded");
			await expect(waiting).rejects.toBe("superseded");
			await expect(delay(300, controller.signal)).rejects.toBe("superseded");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("serial", () => {
	it("starts each task only after every earlier task settles, in call order", async () => {
		const run = serial();
		const order: string[] = [];
		let release!: () => void;
		const first = run(
			() =>
				new Promise<void>((resolve) => {
					order.push("first starts");
					release = resolve;
				}),
		);
		const second = run(() => {
			order.push("second starts");
			return 2;
		});
		await Promise.resolve();
		expect(order).toEqual(["first starts"]);
		release();
		await first;
		expect(await second).toBe(2);
		expect(order).toEqual(["first starts", "second starts"]);
	});
	it("a failed task rejects only its own call and the queue keeps going", async () => {
		const run = serial();
		const error = new Error("task failed");
		const failing = run(() => Promise.reject(error));
		const throwing = run(() => {
			throw error;
		});
		const after = run(() => "after");
		await expect(failing).rejects.toBe(error);
		await expect(throwing).rejects.toBe(error);
		expect(await after).toBe("after");
	});
});

describe("debounce", () => {
	it("runs once with the last arguments after calls stop, and flush or cancel settle it now", async () => {
		vi.useFakeTimers();
		try {
			const run = vi.fn();
			const saves = debounce(run, 400);
			saves.schedule(1);
			await vi.advanceTimersByTimeAsync(300);
			saves.schedule(2);
			await vi.advanceTimersByTimeAsync(300);
			expect(run).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(100);
			expect(run.mock.calls).toEqual([[2]]);
			saves.schedule(3);
			saves.flush();
			saves.flush();
			expect(run.mock.calls).toEqual([[2], [3]]);
			saves.schedule(4);
			saves.cancel();
			await vi.advanceTimersByTimeAsync(400);
			expect(run.mock.calls).toEqual([[2], [3]]);
		} finally {
			vi.useRealTimers();
		}
	});
});
