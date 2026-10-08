import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/util/log", () => ({
	log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
	fireAndForget: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock("@/lib/commands", () => ({ cmd: {} }));

import { hold, schedule, cancel } from "@/store/autosave";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	cancel();
	vi.useRealTimers();
});

describe("holdAutosave defers saves until every hold is released", () => {
	it("schedules nothing while held, then one save on release", () => {
		const release = hold();
		schedule();
		schedule();
		expect(vi.getTimerCount()).toBe(0);
		release();
		expect(vi.getTimerCount()).toBe(1);
	});

	it("releasing with nothing deferred schedules nothing", () => {
		hold()();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("nested holds release only when the last one does", () => {
		const outer = hold();
		const inner = hold();
		schedule();
		inner();
		expect(vi.getTimerCount()).toBe(0);
		outer();
		expect(vi.getTimerCount()).toBe(1);
	});
});
