// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { MIGRATIONS, SUPPORTED_FROM, migrationsFor } from "@/store/migrations";
import { cmpVersion } from "@/lib/util/util";

describe("cmpVersion", () => {
	it("orders by numeric component", () => {
		expect(cmpVersion("0.9.2", "0.10.0")).toBeLessThan(0);
		expect(cmpVersion("1.0.0", "0.9.9")).toBeGreaterThan(0);
		expect(cmpVersion("0.9", "0.9.0")).toBe(0);
	});
});

describe("migration registry", () => {
	// Bumping SUPPORTED_FROM is how migrations get pruned: this names whatever aged out.
	it("holds no migration older than SUPPORTED_FROM", () => {
		const stale = MIGRATIONS.filter((m) => cmpVersion(m.since, SUPPORTED_FROM) < 0);
		expect(stale.map((m) => `${m.since} ${m.key}: ${m.describe}`)).toEqual([]);
	});

	it("is ordered oldest first", () => {
		const versions = MIGRATIONS.map((m) => m.since);
		expect([...versions].sort(cmpVersion)).toEqual(versions);
	});

	it("describes every entry", () => {
		for (const m of MIGRATIONS) {
			expect(m.describe.length, `${m.since} ${m.key}`).toBeGreaterThan(0);
			expect(m.key.length, `${m.since}`).toBeGreaterThan(0);
		}
	});

	it("selects by store key", () => {
		expect(migrationsFor("appSettings").length).toBe(
			MIGRATIONS.filter((m) => m.key === "appSettings").length,
		);
		expect(migrationsFor("no-such-blob")).toEqual([]);
	});
});

describe("globalCopyBindings and fullscreenTagbarCollapsed migration", () => {
	const apply = (stored: Record<string, unknown>) => {
		for (const migrate of migrationsFor("appSettings")) migrate(stored);
	};

	it("migrates both keys out into their own localStorage entries", () => {
		localStorage.clear();
		const bindings = [{ key: "q", action: { type: "copyToMap", mapId: "map-b" } }];
		const stored: Record<string, unknown> = {
			globalCopyBindings: bindings,
			fullscreenTagbarCollapsed: true,
		};
		apply(stored);
		expect(stored).not.toHaveProperty("globalCopyBindings");
		expect(stored).not.toHaveProperty("fullscreenTagbarCollapsed");
		expect(JSON.parse(localStorage.getItem("globalCopyBindings")!)).toEqual(bindings);
		expect(JSON.parse(localStorage.getItem("fullscreenTagbarCollapsed")!)).toBe(true);
	});

	it("leaves a blob without them untouched", () => {
		localStorage.clear();
		const stored: Record<string, unknown> = { showFps: true };
		apply(stored);
		expect(stored).toEqual({ showFps: true });
		expect(localStorage.getItem("globalCopyBindings")).toBeNull();
		expect(localStorage.getItem("fullscreenTagbarCollapsed")).toBeNull();
	});

	it("running it twice is a no-op", () => {
		localStorage.clear();
		const stored: Record<string, unknown> = {
			globalCopyBindings: [{ key: "q", action: { type: "copyToMap", mapId: "map-b" } }],
			fullscreenTagbarCollapsed: true,
		};
		apply(stored);
		const afterFirst = {
			globalCopyBindings: localStorage.getItem("globalCopyBindings"),
			fullscreenTagbarCollapsed: localStorage.getItem("fullscreenTagbarCollapsed"),
		};
		apply(stored);
		expect(localStorage.getItem("globalCopyBindings")).toBe(afterFirst.globalCopyBindings);
		expect(localStorage.getItem("fullscreenTagbarCollapsed")).toBe(
			afterFirst.fullscreenTagbarCollapsed,
		);
		expect(stored).toEqual({});
	});
});

describe("selectOnly -> clickMode migration", () => {
	const apply = (stored: Record<string, unknown>) => {
		for (const migrate of migrationsFor("mapEmbedPrefs")) migrate(stored);
	};

	it("maps the boolean onto the enum and drops the old key", () => {
		const on: Record<string, unknown> = { selectOnly: true };
		apply(on);
		expect(on).toEqual({ clickMode: "selectOnly" });

		const off: Record<string, unknown> = { selectOnly: false };
		apply(off);
		expect(off).toEqual({ clickMode: "default" });
	});

	it("never overwrites an already-chosen clickMode", () => {
		const stored: Record<string, unknown> = { selectOnly: true, clickMode: "nearest" };
		apply(stored);
		expect(stored).toEqual({ clickMode: "nearest" });
	});

	it("leaves a blob without the key untouched and is idempotent", () => {
		const stored: Record<string, unknown> = { clickMode: "nearest" };
		apply(stored);
		apply(stored);
		expect(stored).toEqual({ clickMode: "nearest" });
	});
});
