// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import type { Selector } from "@/bindings.gen";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import {
	startBulkRun,
	getBulkRuns,
	BulkProgress,
	type BulkOperation,
} from "@/components/dialogs/BulkOperationModal";
import { getJobs } from "@/lib/jobs";
import { mount } from "./fixtures/harness";

const sel = (n: number): Selector => ({ type: "Locations", locations: [n], name: null });

const tick = () => new Promise<void>((r) => setTimeout(r));

/** Attach and drop a run's dialog view so a terminal run is cleared between tests. */
async function drain(operation: BulkOperation) {
	const m = mount(<BulkProgress operation={operation} onClose={() => {}} />);
	await act(async () => {});
	m.unmount();
	await act(async () => {});
}

describe("a bulk run keeps the selector it started with", () => {
	// A bulk run whose selector is a live selection can add selections as it goes --
	// applying tags, say. If the run re-read a changing selector it would see its own
	// output, restart, and loop forever. The selector is frozen at startBulkRun.
	it("hands the runner the selector present at start, exactly once", async () => {
		const seen: Selector[] = [];
		const runner = vi.fn(async ({ selector }: { selector: Selector }) => {
			seen.push(selector);
			return {};
		});

		startBulkRun("validate", runner, sel(1));
		await tick();

		expect(runner).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([sel(1)]);
		await drain("validate");
	});
});

describe("closing the dialog backgrounds the run", () => {
	it("unmount does not abort; the job surfaces in the tray instead", async () => {
		let signal: AbortSignal | null = null;
		let finish!: () => void;
		const runner = async (ctx: { signal: AbortSignal }) => {
			signal = ctx.signal;
			await new Promise<void>((r) => {
				finish = r;
			});
			return { doneMessage: "done!" };
		};

		startBulkRun("enrich", runner, sel(1));
		const m = mount(<BulkProgress operation="enrich" onClose={() => {}} />);
		await act(async () => {});
		expect(getJobs().find((j) => !j.hidden)).toBeUndefined();

		m.unmount();
		await act(async () => {});

		expect(signal!.aborted).toBe(false);
		expect(getBulkRuns().get("enrich")?.status).toBe("running");
		expect(getJobs().some((j) => !j.hidden)).toBe(true);

		finish();
		await tick();
		expect(getBulkRuns().has("enrich")).toBe(false);
		expect(getJobs()).toHaveLength(0);
	});

	it("a run that ends while backgrounded is dropped and announced", async () => {
		vi.useFakeTimers();
		let finish!: () => void;
		const runner = async () => {
			await new Promise<void>((r) => {
				finish = r;
			});
			return { doneMessage: "all done" };
		};
		startBulkRun("pinPano", runner, sel(1));
		const m = mount(<BulkProgress operation="pinPano" onClose={() => {}} />);
		await act(async () => {});
		m.unmount();
		await act(async () => {});

		finish();
		await vi.runAllTimersAsync();
		expect(getBulkRuns().has("pinPano")).toBe(false);
		vi.useRealTimers();
	});
});

describe("cancel and duplicate starts", () => {
	it("abort marks the run cancelled", async () => {
		const runner = async ({ signal }: { signal: AbortSignal }) => {
			await new Promise<void>((_, reject) => {
				signal.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
			return {};
		};
		startBulkRun("headingRoad", runner, sel(1));
		getBulkRuns().get("headingRoad")!.controller.abort();
		await tick();
		expect(getBulkRuns().get("headingRoad")?.status).toBe("cancelled");
		await drain("headingRoad");
	});

	it("starting an operation already running is a no-op", async () => {
		let finish!: () => void;
		const first = vi.fn(async () => {
			await new Promise<void>((r) => {
				finish = r;
			});
			return {};
		});
		const second = vi.fn(async () => ({}));

		startBulkRun("setField", first, sel(1));
		startBulkRun("setField", second, sel(2));
		await tick();
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();

		finish();
		await tick();
		await drain("setField");
	});
});
