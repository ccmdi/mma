// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const confirmMapExit = vi.fn<(kind: string) => Promise<boolean>>();
const close = vi.fn();

vi.mock("@/store/store", () => ({ Store: { get: () => ({ mapId: "m1", map: null }) } }));
vi.mock("@/store/maps", () => ({ Maps: { open: vi.fn(), close } }));
vi.mock("@/lib/jobs", () => ({ confirmMapExit: (kind: string) => confirmMapExit(kind) }));

const settle = () => new Promise((r) => setTimeout(r, 0));

async function backToList() {
	history.replaceState({}, "", "#");
	window.dispatchEvent(new PopStateEvent("popstate"));
	await settle();
}

beforeAll(async () => {
	history.replaceState({}, "", "#map/m1");
	const { initRouter } = await import("@/store/router");
	initRouter();
});

beforeEach(() => {
	close.mockClear();
	history.replaceState({}, "", "#map/m1");
});

describe("history back out of an open map", () => {
	it("stays on the map and restores the URL when the exit is declined", async () => {
		confirmMapExit.mockResolvedValue(false);
		await backToList();
		expect(confirmMapExit).toHaveBeenCalledWith("leave");
		expect(close).not.toHaveBeenCalled();
		expect(location.hash).toBe("#map/m1");
	});

	it("closes the map when the exit is confirmed", async () => {
		confirmMapExit.mockResolvedValue(true);
		await backToList();
		expect(close).toHaveBeenCalledOnce();
	});
});
