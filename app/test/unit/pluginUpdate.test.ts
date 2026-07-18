import { describe, it, expect } from "vitest";
import { isPluginUpdatable, needsUpdate } from "@/plugins/registry";

describe("isPluginUpdatable", () => {
	it("flags an update when versions differ", () => {
		expect(isPluginUpdatable("1.0.0", "1.1.0")).toBe(true);
	});

	it("no update when versions match", () => {
		expect(isPluginUpdatable("1.0.0", "1.0.0")).toBe(false);
	});

	it("no update when the installed version is unknown", () => {
		expect(isPluginUpdatable("", "1.0.0")).toBe(false);
		expect(isPluginUpdatable(undefined, "1.0.0")).toBe(false);
	});

	it("no update when the registry version is unknown", () => {
		expect(isPluginUpdatable("1.0.0", "")).toBe(false);
		expect(isPluginUpdatable("1.0.0", undefined)).toBe(false);
	});

	it("does not flag update when installed semver is newer than registry", () => {
		expect(isPluginUpdatable("1.1.0", "1.0.0")).toBe(false);
	});
});

describe("needsUpdate (sidecar-aware)", () => {
	it("flags a JS version drift regardless of sidecar", () => {
		expect(needsUpdate("1.0.0", "1.1.0", "0.1.0", "0.1.0")).toBe(true);
	});

	it("flags a sidecar drift even when JS versions match", () => {
		expect(needsUpdate("1.0.0", "1.0.0", "0.1.0", "0.2.0")).toBe(true);
	});

	it("flags a missing sidecar (nothing installed yet) as an update", () => {
		expect(needsUpdate("1.0.0", "1.0.0", null, "0.1.0")).toBe(true);
		expect(needsUpdate("1.0.0", "1.0.0", undefined, "0.1.0")).toBe(true);
	});

	it("no update when both JS and sidecar match", () => {
		expect(needsUpdate("1.0.0", "1.0.0", "0.1.0", "0.1.0")).toBe(false);
	});

	it("no update for a plugin without a registry sidecar", () => {
		expect(needsUpdate("1.0.0", "1.0.0", null, undefined)).toBe(false);
	});
});
