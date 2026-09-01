// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import type { Selector } from "@/bindings.gen";

// A bulk run whose selector is a live selection can add selections as it goes -- applying
// tags, say. If the run re-read that selector it would see its own output, restart, and
// loop forever. `BulkProgress` freezes the selector it started with; nothing exercised
// that, because no test ever mounted the component.
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { BulkProgress } from "@/components/dialogs/BulkOperationModal";
import { mount } from "./fixtures/harness";

const sel = (n: number): Selector => ({ type: "Locations", locations: [n], name: null });

describe("a bulk run keeps the selector it started with", () => {
	it("hands the runner the selector present at mount", async () => {
		const seen: Selector[] = [];
		const runner = vi.fn(async ({ selector }: { selector: Selector }) => {
			seen.push(selector);
			return {};
		});

		const m = mount(<BulkProgress runner={runner} selector={sel(1)} onClose={() => {}} />);
		await act(async () => {});

		expect(seen).toEqual([sel(1)]);
		m.unmount();
	});

	it("does not restart when the selector prop changes under it", async () => {
		const seen: Selector[] = [];
		const runner = vi.fn(async ({ selector }: { selector: Selector }) => {
			seen.push(selector);
			return {};
		});

		const m = mount(<BulkProgress runner={runner} selector={sel(1)} onClose={() => {}} />);
		await act(async () => {});

		// What a run that tags its own results looks like from here.
		await act(async () => {
			m.root.render(<BulkProgress runner={runner} selector={sel(2)} onClose={() => {}} />);
		});
		await act(async () => {});

		expect(runner).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([sel(1)]);
		m.unmount();
	});

	it("restarts only when the runner itself changes", async () => {
		const runnerA = vi.fn(async () => ({}));
		const runnerB = vi.fn(async () => ({}));

		const m = mount(<BulkProgress runner={runnerA} selector={sel(1)} onClose={() => {}} />);
		await act(async () => {});
		await act(async () => {
			m.root.render(<BulkProgress runner={runnerB} selector={sel(1)} onClose={() => {}} />);
		});
		await act(async () => {});

		expect(runnerA).toHaveBeenCalledTimes(1);
		expect(runnerB).toHaveBeenCalledTimes(1);
		m.unmount();
	});
});
