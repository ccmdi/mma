// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { reloadStorage, storage } from "@/plugins/pluginStorage";

beforeEach(() => {
	localStorage.clear();
});

describe("storage", () => {
	it("returns the fallback when a key is unset", () => {
		const s = storage("p1");
		expect(s.get("k", 42)).toBe(42);
		expect(s.get("k")).toBeUndefined();
	});

	it("round-trips set -> get", () => {
		const s = storage("p1");
		s.set("k", { a: 1 });
		expect(s.get("k")).toEqual({ a: 1 });
	});

	it("persists across separate instances of the same id", () => {
		storage("p1").set("k", "v");
		expect(storage("p1").get("k")).toBe("v");
	});

	it("namespaces by plugin id (no cross-talk)", () => {
		storage("a").set("k", "from-a");
		storage("b").set("k", "from-b");
		expect(storage("a").get("k")).toBe("from-a");
		expect(storage("b").get("k")).toBe("from-b");
	});

	it("remove deletes the key", () => {
		const s = storage("p1");
		s.set("k", 1);
		s.remove("k");
		expect(s.get("k", "fb")).toBe("fb");
		expect(s.keys()).not.toContain("k");
	});

	it("keys lists the stored keys", () => {
		const s = storage("p1");
		s.set("a", 1);
		s.set("b", 2);
		expect(s.keys().sort()).toEqual(["a", "b"]);
	});

	it("reloadStorage picks up a write another window made to the backing store", () => {
		const s = storage("xwin");
		s.set("a", 1);
		localStorage.setItem("mma_plugin:xwin", JSON.stringify({ a: 1, b: 2 }));
		expect(s.keys()).toEqual(["a"]);
		reloadStorage("xwin");
		expect(s.keys().sort()).toEqual(["a", "b"]);
	});

	it("tolerates corrupt json, returning the fallback", () => {
		localStorage.setItem("mma_plugin:p1", "{not json");
		expect(storage("p1").get("k", "fb")).toBe("fb");
	});
});
