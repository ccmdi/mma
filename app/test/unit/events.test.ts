import { describe, it, expect, vi } from "vitest";

// emit() routes caught handler errors through log.error, which hits the tauri logger
// (absent under vitest). Stub it so the error-isolation test doesn't leak a rejection.
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import {
	emit,
	subscribe,
	subscribeMany,
	LOCATION_DATA_EVENTS,
	SELECTION_EVENTS,
} from "@/lib/events";

// The group constants are derived from the event registry by prefix. If an event name
// stops matching its prefix, a whole group silently drops it — pin them explicitly.
describe("event group constants", () => {
	it("LOCATION_DATA_EVENTS contains exactly the location:* events", () => {
		expect([...LOCATION_DATA_EVENTS].sort()).toEqual([
			"location:add",
			"location:invalidate",
			"location:remove",
			"location:update",
		]);
	});

	it("SELECTION_EVENTS is only user-facing selection state", () => {
		expect([...SELECTION_EVENTS].sort()).toEqual(["selection:change"]);
	});
});

describe("subscribeMany", () => {
	it("fans out to every event and the combined unsubscribe detaches all", () => {
		const fn = vi.fn();
		const off = subscribeMany(["location:add", "tag:add"], fn);
		emit("location:add", []);
		emit("tag:add", []);
		expect(fn).toHaveBeenCalledTimes(2);

		off();
		emit("location:add", []);
		emit("tag:add", []);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

describe("emit", () => {
	it("isolates handler errors — a throwing handler doesn't block the rest", () => {
		const good = vi.fn();
		const offBad = subscribe("active:change", () => {
			throw new Error("boom");
		});
		const offGood = subscribe("active:change", good);

		expect(() => emit("active:change", 1)).not.toThrow();
		expect(good).toHaveBeenCalledOnce();

		offBad();
		offGood();
	});
});
