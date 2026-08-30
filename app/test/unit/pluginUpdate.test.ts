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

import {
	isPluginUpdatable,
	needsUpdate,
	needsBuildUpdate,
	resolveBuild,
	autoUpdatePlugin,
} from "@/plugins/registry";

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

const REF = "471972e1b93fb7bb10dc6ce5f786c223a1f59120";

describe("resolveBuild", () => {
	const entry = (over: Partial<PluginManifest> = {}): PluginManifest => ({
		id: "p",
		name: "P",
		description: "",
		icon: "",
		main: "index.js",
		version: "2.0.0",
		...over,
	});

	it("takes the registry's latest when the app satisfies its floor", () => {
		expect(resolveBuild(entry({ minAppVersion: "1.0.0" }), "1.0.0")).toEqual({
			version: "2.0.0",
			ref: null,
			minAppVersion: "1.0.0",
		});
	});

	it("falls back to the newest build the app can run", () => {
		const e = entry({
			minAppVersion: "9.0.0",
			builds: [
				{ version: "1.5.0", ref: REF, minAppVersion: "1.0.0" },
				{ version: "1.0.0", ref: "a".repeat(40) },
			],
		});
		expect(resolveBuild(e, "1.0.0")).toEqual({
			version: "1.5.0",
			ref: REF,
			minAppVersion: "1.0.0",
		});
	});

	// builds are newest-first, so the first compatible one is the answer.
	it("skips fallbacks that also require a newer app", () => {
		const e = entry({
			minAppVersion: "9.0.0",
			builds: [
				{ version: "1.5.0", ref: REF, minAppVersion: "5.0.0" },
				{ version: "1.0.0", ref: "a".repeat(40) },
			],
		});
		expect(resolveBuild(e, "1.0.0")?.version).toBe("1.0.0");
	});

	it("is null when no published build supports this app", () => {
		expect(resolveBuild(entry({ minAppVersion: "9.0.0" }), "1.0.0")).toBeNull();
		const e = entry({
			minAppVersion: "9.0.0",
			builds: [{ version: "1.5.0", ref: REF, minAppVersion: "5.0.0" }],
		});
		expect(resolveBuild(e, "1.0.0")).toBeNull();
	});
});

describe("needsBuildUpdate", () => {
	it("compares versions only for a pinned build", () => {
		const target = { version: "1.5.0", ref: REF, minAppVersion: null };
		expect(needsBuildUpdate("1.0.0", target, "0.1.0", "0.9.0")).toBe(true);
		// Sidecar drift against the latest build says nothing about a pinned one.
		expect(needsBuildUpdate("1.5.0", target, "0.1.0", "0.9.0")).toBe(false);
	});

	it("stays sidecar-aware for the latest build", () => {
		const target = { version: "1.0.0", ref: null, minAppVersion: null };
		expect(needsBuildUpdate("1.0.0", target, "0.1.0", "0.2.0")).toBe(true);
		expect(needsBuildUpdate("1.0.0", target, "0.2.0", "0.2.0")).toBe(false);
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

	it("installs the newest compatible build from its ref when latest is out of reach", async () => {
		const fresh = manifest({ version: "1.5.0" });
		installPlugin.mockResolvedValue(fresh);
		const latest = manifest({
			version: "2.0.0",
			minAppVersion: "9.0.0",
			builds: [{ version: "1.5.0", ref: REF }],
		});
		expect(await autoUpdatePlugin(manifest(), latest, "1.0.0")).toBe(fresh);
		expect(installPlugin).toHaveBeenCalledWith("p", REF);
	});

	// The fallback's sidecar version is only knowable from its own manifest, so the
	// pre-download check can't compare it -- install reconciles it after.
	it("installs a pinned build's sidecar from the manifest it downloads", async () => {
		sidecarInstalledVersion.mockResolvedValue("0.9.0");
		installPlugin.mockResolvedValue(manifest({ sidecar: { name: "mma-x", version: "0.1.0" } }));
		const latest = manifest({
			version: "2.0.0",
			minAppVersion: "9.0.0",
			sidecar: { name: "mma-x", version: "0.9.0" },
			builds: [{ version: "1.5.0", ref: REF }],
		});
		await autoUpdatePlugin(manifest(), latest, "1.0.0");
		expect(installPlugin).toHaveBeenCalledWith("p", REF);
		expect(sidecarInstall).toHaveBeenCalledWith("p", "mma-x", "0.1.0");
	});

	it("leaves the install alone when it already is the newest compatible build", async () => {
		const m = manifest({ version: "1.5.0" });
		const latest = manifest({
			version: "2.0.0",
			minAppVersion: "9.0.0",
			builds: [{ version: "1.5.0", ref: REF }],
		});
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
		expect(installPlugin).toHaveBeenCalledWith("p", null);
		expect(sidecarInstall).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalled();
	});

	it("updates on sidecar drift alone and installs the sidecar", async () => {
		const sidecar = { name: "mma-x", version: "0.2.0" };
		sidecarInstalledVersion.mockResolvedValue("0.1.0");
		installPlugin.mockResolvedValue(manifest({ sidecar }));
		await autoUpdatePlugin(
			manifest({ sidecar: { name: "mma-x", version: "0.1.0" } }),
			manifest({ sidecar }),
			"1.0.0",
		);
		expect(installPlugin).toHaveBeenCalledWith("p", null);
		expect(sidecarInstall).toHaveBeenCalledWith("p", "mma-x", "0.2.0");
	});

	it("falls back to the on-disk manifest when the download fails", async () => {
		installPlugin.mockRejectedValue(new Error("offline"));
		const m = manifest();
		expect(await autoUpdatePlugin(m, manifest({ version: "2.0.0" }), "1.0.0")).toBe(m);
		expect(toast).not.toHaveBeenCalled();
	});
});
