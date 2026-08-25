import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/util/log", () => ({
	log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
	fireAndForget: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock("@/lib/commands", () => ({ cmd: {} }));

import { holdAutosave, scheduleSave, cancelAutosave } from "@/store/useMapStore";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	cancelAutosave();
	vi.useRealTimers();
});

describe("holdAutosave defers saves until every hold is released", () => {
	it("schedules nothing while held, then one save on release", () => {
		const release = holdAutosave();
		scheduleSave();
		scheduleSave();
		expect(vi.getTimerCount()).toBe(0);
		release();
		expect(vi.getTimerCount()).toBe(1);
	});

	it("releasing with nothing deferred schedules nothing", () => {
		holdAutosave()();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("nested holds release only when the last one does", () => {
		const outer = holdAutosave();
		const inner = holdAutosave();
		scheduleSave();
		inner();
		expect(vi.getTimerCount()).toBe(0);
		outer();
		expect(vi.getTimerCount()).toBe(1);
	});
});
