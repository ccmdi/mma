// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { CoverageBar } from "@/components/primitives/CoverageBar";
import { mount } from "./fixtures/harness";

describe("a coverage bar", () => {
	const read = (ratio: number, status = true) => {
		const m = mount(<CoverageBar ratio={ratio} status={status} />);
		const root = m.container.querySelector(".coverage-bar")!;
		const out = { pct: root.textContent, className: root.className };
		m.unmount();
		return out;
	};

	it("never reads 100% while a location is missing", () => {
		expect(read(0.996)).toEqual({
			pct: "99%",
			className: expect.stringContaining("coverage-bar--incomplete") as string,
		});
	});

	it("reads complete only at full coverage", () => {
		expect(read(1)).toEqual({
			pct: "100%",
			className: expect.stringContaining("coverage-bar--complete") as string,
		});
	});

	it("stays neutral without status", () => {
		expect(read(0.5, false).className).toContain("coverage-bar--accent");
	});
});
