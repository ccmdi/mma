// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createPluginStorage } from "@/plugins/registry";

beforeEach(() => {
	localStorage.clear();
});

describe("createPluginStorage", () => {
	it("returns the fallback when a key is unset", () => {
		const s = createPluginStorage("p1");
		expect(s.get("k", 42)).toBe(42);
		expect(s.get("k")).toBeUndefined();
	});

	it("round-trips set -> get", () => {
		const s = createPluginStorage("p1");
		s.set("k", { a: 1 });
		expect(s.get("k")).toEqual({ a: 1 });
	});

	it("persists across separate instances of the same id", () => {
		createPluginStorage("p1").set("k", "v");
		expect(createPluginStorage("p1").get("k")).toBe("v");
	});

	it("namespaces by plugin id (no cross-talk)", () => {
		createPluginStorage("a").set("k", "from-a");
		createPluginStorage("b").set("k", "from-b");
		expect(createPluginStorage("a").get("k")).toBe("from-a");
		expect(createPluginStorage("b").get("k")).toBe("from-b");
	});

	it("remove deletes the key", () => {
		const s = createPluginStorage("p1");
		s.set("k", 1);
		s.remove("k");
		expect(s.get("k", "fb")).toBe("fb");
		expect(s.keys()).not.toContain("k");
	});

	it("keys lists the stored keys", () => {
		const s = createPluginStorage("p1");
		s.set("a", 1);
		s.set("b", 2);
		expect(s.keys().sort()).toEqual(["a", "b"]);
	});

	it("tolerates corrupt json, returning the fallback", () => {
		localStorage.setItem("mma_plugin:p1", "{not json");
		expect(createPluginStorage("p1").get("k", "fb")).toBe("fb");
	});
});
