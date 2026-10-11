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
	vi.mocked(cmd.storeSaveDirty).mockClear();
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

describe("writes to the map's files never overlap", () => {
	it("a flush and an exclusive write each wait for the one before to finish", async () => {
		const order: string[] = [];
		let finishSave!: () => void;
		vi.mocked(cmd.storeSaveDirty).mockImplementationOnce(async () => {
			order.push("save start");
			await new Promise<void>((r) => (finishSave = r));
			order.push("save end");
			return null;
		});
		const saving = Autosave.flush();
		const committing = Autosave.exclusive(async () => {
			order.push("commit");
		});
		const again = Autosave.flush();
		await vi.waitFor(() => expect(order).toEqual(["save start"]));
		finishSave();
		await Promise.all([saving, committing, again]);
		expect(order).toEqual(["save start", "save end", "commit"]);
		expect(cmd.storeSaveDirty).toHaveBeenCalledTimes(2);
	});

	it("an exclusive write cancels a pending timer, so no save starts beneath it", async () => {
		Autosave.schedule();
		await Autosave.exclusive(async () => {});
		await vi.runAllTimersAsync();
		expect(cmd.storeSaveDirty).not.toHaveBeenCalled();
	});

	it("a failed exclusive write does not stall the writes after it", async () => {
		await expect(Autosave.exclusive(() => Promise.reject(new Error("boom")))).rejects.toThrow(
			"boom",
		);
		await Autosave.flush();
		expect(cmd.storeSaveDirty).toHaveBeenCalledOnce();
	});
});
