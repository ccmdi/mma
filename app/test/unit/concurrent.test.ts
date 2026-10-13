import { describe, expect, it, vi } from "vitest";
import { delay } from "@/lib/util/concurrent";

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
