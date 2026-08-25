import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginManifest } from "@/bindings.gen";

const installPlugin = vi.fn();
const sidecarInstall = vi.fn();
const sidecarInstalledVersion = vi.fn();
vi.mock("@/lib/commands", () => ({
	cmd: {
		installPlugin: (...a: unknown[]) => installPlugin(...a),
		sidecarInstall: (...a: unknown[]) => sidecarInstall(...a),
		sidecarInstalledVersion: (...a: unknown[]) => sidecarInstalledVersion(...a),
	},
}));
const toast = vi.fn();
vi.mock("@/lib/util/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { isPluginUpdatable, needsUpdate, autoUpdatePlugin } from "@/plugins/registry";

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

	// Plain inequality, not semver ordering — a downgrade still reads as "differs".
	it("treats any mismatch as updatable, including lower registry versions", () => {
		expect(isPluginUpdatable("1.1.0", "1.0.0")).toBe(true);
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

describe("autoUpdatePlugin (startup silent refresh)", () => {
	const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
		id: "p",
		name: "P",
		description: "",
		icon: "",
		main: "index.js",
		version: "1.0.0",
		...over,
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("never touches a plugin absent from the registry (hand-installed)", async () => {
		const m = manifest();
		expect(await autoUpdatePlugin(m, undefined, "1.0.0")).toBe(m);
		expect(installPlugin).not.toHaveBeenCalled();
	});

	it("never installs a registry build that requires a newer app", async () => {
		const m = manifest();
		const latest = manifest({ version: "2.0.0", minAppVersion: "9.0.0" });
		expect(await autoUpdatePlugin(m, latest, "1.0.0")).toBe(m);
		expect(installPlugin).not.toHaveBeenCalled();
	});

	it("leaves a current install alone", async () => {
		const m = manifest();
		expect(await autoUpdatePlugin(m, manifest(), "1.0.0")).toBe(m);
		expect(installPlugin).not.toHaveBeenCalled();
	});

	it("re-downloads a stale install and returns the fresh manifest", async () => {
		const fresh = manifest({ version: "2.0.0" });
		installPlugin.mockResolvedValue(fresh);
		const got = await autoUpdatePlugin(manifest(), manifest({ version: "2.0.0" }), "1.0.0");
		expect(got).toBe(fresh);
		expect(installPlugin).toHaveBeenCalledWith("p");
		expect(sidecarInstall).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalled();
	});

	it("updates on sidecar drift alone and installs the sidecar", async () => {
		const sidecar = { name: "mma-x", version: "0.2.0" };
		sidecarInstalledVersion.mockResolvedValue("0.1.0");
		installPlugin.mockResolvedValue(manifest({ sidecar }));
		await autoUpdatePlugin(manifest({ sidecar: { name: "mma-x", version: "0.1.0" } }), manifest({ sidecar }), "1.0.0");
		expect(installPlugin).toHaveBeenCalledWith("p");
		expect(sidecarInstall).toHaveBeenCalledWith("p", "mma-x", "0.2.0");
	});

	it("falls back to the on-disk manifest when the download fails", async () => {
		installPlugin.mockRejectedValue(new Error("offline"));
		const m = manifest();
		expect(await autoUpdatePlugin(m, manifest({ version: "2.0.0" }), "1.0.0")).toBe(m);
		expect(toast).not.toHaveBeenCalled();
	});
});
