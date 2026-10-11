import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/util/log", () => ({
	log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
	fireAndForget: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock("@/lib/commands", () => ({ cmd: { storeSaveDirty: vi.fn(async () => null) } }));
vi.mock("@/store/store", () => ({ Store: { get: () => ({ mapId: "m1", map: { id: "m1" } }) } }));

vi.mock("@/store/maps", () => ({ Maps: { invalidate: vi.fn(async () => {}) } }));
import { Autosave } from "@/store/autosave";
import { cmd } from "@/lib/commands";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	Autosave.cancel();
	vi.useRealTimers();
});

describe("autosave debounce", () => {
	it("cancel clears a scheduled write and prevents a save", async () => {
		Autosave.schedule();
		Autosave.cancel();
		await vi.runAllTimersAsync();
		expect(vi.getTimerCount()).toBe(0);
		expect(cmd.storeSaveDirty).not.toHaveBeenCalled();
	});

	it("resets the quiet period when another mutation schedules a save", async () => {
		Autosave.schedule();
		await vi.advanceTimersByTimeAsync(1999);
		Autosave.schedule();
		await vi.advanceTimersByTimeAsync(1999);
		expect(cmd.storeSaveDirty).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(cmd.storeSaveDirty).toHaveBeenCalledOnce();
	});
});

describe("holdAutosave defers saves until every hold is released", () => {
	it("schedules nothing while held, then one save on release", () => {
		const release = Autosave.hold();
		Autosave.schedule();
		Autosave.schedule();
		expect(vi.getTimerCount()).toBe(0);
		release();
		expect(vi.getTimerCount()).toBe(1);
	});

	it("releasing with nothing deferred schedules nothing", () => {
		Autosave.hold()();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("nested holds release only when the last one does", () => {
		const outer = Autosave.hold();
		const inner = Autosave.hold();
		Autosave.schedule();
		inner();
		expect(vi.getTimerCount()).toBe(0);
		outer();
		expect(vi.getTimerCount()).toBe(1);
	});
});
