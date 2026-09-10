// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mmaRequire, preloadModules, getAvailableExternals } from "@/plugins/externals";

describe("mmaRequire", () => {
	it("returns react module", () => {
		const mod = mmaRequire("react");
		expect(mod).toBeTruthy();
		expect(mod).toHaveProperty("createElement");
	});

	it("returns react-dom module", () => {
		const mod = mmaRequire("react-dom");
		expect(mod).toBeTruthy();
		expect(mod).toHaveProperty("createPortal");
	});

	it("returns react/jsx-runtime module", () => {
		const mod = mmaRequire("react/jsx-runtime");
		expect(mod).toBeTruthy();
		expect(mod).toHaveProperty("jsx");
	});

	it("throws for unknown module with name in message", () => {
		expect(() => mmaRequire("lodash")).toThrowError(
			'Module "lodash" is not available as an MMA external.',
		);
	});

	it("throws for empty string module id", () => {
		expect(() => mmaRequire("")).toThrowError("not available as an MMA external");
	});
});

describe("getAvailableExternals", () => {
	it("returns an array", () => {
		const externals = getAvailableExternals();
		expect(Array.isArray(externals)).toBe(true);
	});

	it("contains react and react-dom", () => {
		const externals = getAvailableExternals();
		expect(externals).toContain("react");
		expect(externals).toContain("react-dom");
	});

	// The broker's keys and the SDK's `DEFAULT_EXTERNALS` are the same list: what the esbuild
	// plugin rewrites to `__mma_require` must be what the broker can hand back.
	// If either side drifts, this goes red.
	it("matches DEFAULT_EXTERNALS in the plugin SDK", () => {
		const sdk = readFileSync(join(__dirname, "../../../plugins/mma-externals.js"), "utf8");
		const list = /const DEFAULT_EXTERNALS = \[([^\]]*)\]/.exec(sdk)?.[1];
		expect(list).toBeTruthy();
		const names = [...list!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		expect(names.length).toBeGreaterThan(0);
		expect([...names].sort()).toEqual([...getAvailableExternals()].sort());
	});
});

describe("preloadModules", () => {
	it("resolves with empty array", async () => {
		await expect(preloadModules([])).resolves.toBeUndefined();
	});

	it("resolves for already-eager modules (no-op)", async () => {
		await expect(preloadModules(["react", "react-dom"])).resolves.toBeUndefined();
	});

	it("rejects for unknown module with name in message", async () => {
		await expect(preloadModules(["nonexistent"])).rejects.toThrowError(
			'Module "nonexistent" is not available as an MMA external.',
		);
	});

	it("rejects if any module in the list is unknown", async () => {
		await expect(preloadModules(["react", "unknown-lib"])).rejects.toThrowError(
			"not available as an MMA external",
		);
	});
});

describe("globalThis.__mma_require", () => {
	it("is set to the mmaRequire function", () => {
		expect(globalThis.__mma_require).toBe(mmaRequire);
	});

	it("works as a global lookup", () => {
		const mod = globalThis.__mma_require("react");
		expect(mod).toBeTruthy();
	});
});
