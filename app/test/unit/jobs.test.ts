import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { emit } from "@/lib/events";
import {
	registerJob,
	runJob,
	cancelJobs,
	getJobs,
	confirmMapExit,
	resolveMapExit,
	getExitRequest,
} from "@/lib/jobs";
import { getToasts } from "@/lib/util/toast";

describe("job registry", () => {
	it("register/update/finish lifecycle", () => {
		const h = registerJob("Working", { scope: "app" });
		expect(getJobs()).toHaveLength(1);
		expect(getJobs()[0]).toMatchObject({ label: "Working", scope: "app", fraction: 0 });

		h.update(0.5, "5 / 10");
		expect(getJobs()[0]).toMatchObject({ fraction: 0.5, detail: "5 / 10" });

		h.finish();
		expect(getJobs()).toHaveLength(0);
	});

	it("handle methods are no-ops after the job ended", () => {
		const h = registerJob("Working");
		h.finish();
		h.update(0.9);
		h.finish("late");
		h.fail("late");
		expect(getJobs()).toHaveLength(0);
		expect(getToasts()).toHaveLength(0);
	});

	it("finish with a message leaves a toast", () => {
		vi.useFakeTimers();
		const h = registerJob("Working");
		h.finish("Done");
		expect(getToasts().map((t) => t.message)).toContain("Done");
		vi.runAllTimers();
		vi.useRealTimers();
	});

	it("hidden entries stay in the registry", () => {
		const h = registerJob("Working");
		h.setHidden(true);
		expect(getJobs()[0].hidden).toBe(true);
		h.setHidden(false);
		expect(getJobs()[0].hidden).toBe(false);
		h.finish();
	});

	it("snapshot reference is stable between changes", () => {
		const h = registerJob("Working");
		const a = getJobs();
		expect(getJobs()).toBe(a);
		h.update(0.1);
		expect(getJobs()).not.toBe(a);
		h.finish();
	});
});

describe("job scope", () => {
	it("cancelJobs hits only the matching scope, via the cancel callback", () => {
		const mapCancel = vi.fn();
		const appCancel = vi.fn();
		const m = registerJob("Map work", { scope: "map", cancel: mapCancel });
		const a = registerJob("App work", { scope: "app", cancel: appCancel });

		cancelJobs("map");
		expect(mapCancel).toHaveBeenCalledOnce();
		expect(appCancel).not.toHaveBeenCalled();
		// The owner ends its own job after aborting; the registry does not remove it.
		expect(getJobs()).toHaveLength(2);
		m.finish();
		a.finish();
	});

	it("cancelJobs removes uncancellable jobs outright", () => {
		registerJob("Map work", { scope: "map" });
		cancelJobs("map");
		expect(getJobs()).toHaveLength(0);
	});

	it("map close cancels map-scoped jobs and spares app-scoped ones", () => {
		const mapCancel = vi.fn();
		const m = registerJob("Map work", { scope: "map", cancel: mapCancel });
		const a = registerJob("App work", { scope: "app" });

		emit("map:close");
		expect(mapCancel).toHaveBeenCalledOnce();
		expect(getJobs()).toHaveLength(2);
		m.finish();
		a.finish();
	});
});

describe("runJob", () => {
	it("reports progress, resolves the result, and ends the job", async () => {
		const result = await runJob("Working", async ({ report }) => {
			report(0.5);
			expect(getJobs()[0].fraction).toBe(0.5);
			return 42;
		});
		expect(result).toBe(42);
		expect(getJobs()).toHaveLength(0);
	});

	it("cancel aborts the signal and resolves null without a failure toast", async () => {
		const p = runJob("Working", async ({ signal }) => {
			getJobs()[0].cancel?.();
			expect(signal.aborted).toBe(true);
			throw new DOMException("aborted", "AbortError");
		});
		await expect(p).resolves.toBeNull();
		expect(getJobs()).toHaveLength(0);
		expect(getToasts()).toHaveLength(0);
	});

	it("failure toasts the message and rethrows", async () => {
		vi.useFakeTimers();
		const p = runJob("Working", async () => {
			throw new Error("boom");
		});
		await expect(p).rejects.toThrow("boom");
		expect(getJobs()).toHaveLength(0);
		expect(getToasts().map((t) => t.message)).toContain("boom");
		vi.runAllTimers();
		vi.useRealTimers();
	});
});

describe("confirmMapExit", () => {
	it("resolves true immediately when no map-scoped jobs are live", async () => {
		const a = registerJob("App work", { scope: "app" });
		await expect(confirmMapExit("leave")).resolves.toBe(true);
		expect(getExitRequest()).toBeNull();
		a.finish();
	});

	it("stay leaves the jobs running; proceed cancels them", async () => {
		const cancel = vi.fn();
		const m = registerJob("Map work", { scope: "map", cancel });

		const stay = confirmMapExit("leave");
		expect(getExitRequest()?.kind).toBe("leave");
		resolveMapExit(false);
		await expect(stay).resolves.toBe(false);
		expect(cancel).not.toHaveBeenCalled();

		const proceed = confirmMapExit("quit");
		resolveMapExit(true);
		await expect(proceed).resolves.toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
		expect(getExitRequest()).toBeNull();
		m.finish();
	});

	it("a second request while one is pending resolves false", async () => {
		const m = registerJob("Map work", { scope: "map", cancel: () => {} });
		const first = confirmMapExit("leave");
		await expect(confirmMapExit("quit")).resolves.toBe(false);
		resolveMapExit(false);
		await expect(first).resolves.toBe(false);
		m.finish();
	});
});
