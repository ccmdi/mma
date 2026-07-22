import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createScheduler } from "@/lib/sync/scheduler";

const POLL = 15000;

describe("sync scheduler - failure backoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function ticks(n: number) {
		for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(POLL);
	}

	it("polls at full rate while runs succeed", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const s = createScheduler(run, { pollMs: POLL });
		s.start();
		await ticks(3);
		s.stop();
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("backs off exponentially on consecutive failures", async () => {
		const run = vi.fn().mockRejectedValue(new Error("down"));
		const s = createScheduler(run, { pollMs: POLL });
		s.start();
		// Ticks at 15/30/45/60/75/90s. Backoff windows: 15s (after #1), 30s (after #2),
		// 60s (after #3) - so only ticks 1, 2, 4 fire within the first six.
		await ticks(6);
		s.stop();
		expect(run).toHaveBeenCalledTimes(3);
		expect(s.status()).toBe("error");
	});

	it("one success resets the backoff", async () => {
		const run = vi
			.fn()
			.mockRejectedValueOnce(new Error("down"))
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValue(undefined);
		const s = createScheduler(run, { pollMs: POLL });
		s.start();
		// Fails at 15s and 30s, skips 45s (blocked until 60s), succeeds at 60s, 75s, 90s.
		await ticks(6);
		expect(s.status()).toBe("idle");
		expect(run).toHaveBeenCalledTimes(5);
		// After the success, every subsequent tick fires again at full rate.
		run.mockClear();
		await ticks(2);
		expect(run).toHaveBeenCalledTimes(2);
		s.stop();
	});

	it("runNow bypasses the backoff window", async () => {
		const run = vi.fn().mockRejectedValue(new Error("down"));
		const s = createScheduler(run, { pollMs: POLL });
		s.start();
		await ticks(1);
		expect(run).toHaveBeenCalledTimes(1);
		await s.runNow();
		expect(run).toHaveBeenCalledTimes(2);
		s.stop();
	});

	it("caps the backoff at maxBackoffMs", async () => {
		const run = vi.fn().mockRejectedValue(new Error("down"));
		const s = createScheduler(run, { pollMs: POLL, maxBackoffMs: POLL });
		s.start();
		// With the cap at one poll interval, every tick is past the backoff window.
		await ticks(4);
		s.stop();
		expect(run).toHaveBeenCalledTimes(4);
	});
});
