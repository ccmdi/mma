import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/util/log", () => ({
	log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
	fireAndForget: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock("@/lib/commands", () => ({ cmd: { storeSaveDirty: vi.fn(async () => null) } }));
vi.mock("@/store/useMapStore", () => ({ getMapState: () => ({ mapId: "m1", map: { id: "m1" } }) }));
vi.mock("@/store/mapList", () => ({ invalidateMapList: vi.fn(async () => {}) }));

import { hold, schedule, cancel } from "@/store/autosave";
import { cmd } from "@/lib/commands";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	cancel();
	vi.useRealTimers();
});

describe("autosave debounce", () => {
	it("cancel clears a scheduled write and prevents a save", async () => {
		schedule();
		cancel();
		await vi.runAllTimersAsync();
		expect(vi.getTimerCount()).toBe(0);
		expect(cmd.storeSaveDirty).not.toHaveBeenCalled();
	});

	it("resets the quiet period when another mutation schedules a save", async () => {
		schedule();
		await vi.advanceTimersByTimeAsync(1999);
		schedule();
		await vi.advanceTimersByTimeAsync(1999);
		expect(cmd.storeSaveDirty).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(cmd.storeSaveDirty).toHaveBeenCalledOnce();
	});
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
