import { describe, it, expect, beforeEach } from "vitest";
import {
	getFieldDef,
	getAllFieldDefs,
	registerPluginFieldDefs,
	unregisterPluginFieldDefs,
	setUserFieldDefs,
	isBuiltinField,
	isWritableField,
	projectionsForType,
	isListableField,
	getBuiltinKeys,
} from "@/lib/data/fieldDefRegistry";
import { getEventVersion } from "@/lib/events";

beforeEach(() => {
	setUserFieldDefs({});
});

// SV field defs live in Rust (`known_field_def`) and reach the registry via the user
// layer (persisted into a map's `extra.fields`). The registry itself hardcodes only
// the builtin/virtual Location fields; user > plugin > builtin resolution.

describe("field kinds", () => {
	it("identity fields are builtin, readable, but never writable or listable", () => {
		for (const key of ["lat", "lng", "id"]) {
			expect(isBuiltinField(key)).toBe(true);
			expect(getFieldDef(key)).toBeDefined();
			expect(isWritableField(key)).toBe(false);
			expect(isListableField(key)).toBe(false);
		}
	});

	it("virtual fields are not builtin and not writable", () => {
		expect(isBuiltinField("tagCount")).toBe(false);
		expect(isWritableField("tagCount")).toBe(false);
		expect(isListableField("tagCount")).toBe(true);
		expect(getBuiltinKeys()).not.toContain("tagCount");
	});

	it("kindless builtins are listable and readable but not writable", () => {
		for (const key of ["createdAt", "modifiedAt"]) {
			expect(isBuiltinField(key)).toBe(true);
			expect(isWritableField(key)).toBe(false);
			expect(isListableField(key)).toBe(true);
		}
	});

	it("writable builtins are exactly heading, pitch, zoom", () => {
		expect(getBuiltinKeys().filter(isWritableField).sort()).toEqual(["heading", "pitch", "zoom"]);
	});

	it("extra fields are writable and listable", () => {
		expect(isWritableField("countryCode")).toBe(true);
		expect(isListableField("countryCode")).toBe(true);
		expect(isBuiltinField("countryCode")).toBe(false);
	});
});

describe("lookup", () => {
	it("returns undefined for keys with no def in any layer", () => {
		expect(getFieldDef("plumbus")).toBeUndefined();
		expect(getFieldDef("altitude")).toBeUndefined();
	});
});

describe("plugin defs", () => {
	it("registers and retrieves plugin field defs", () => {
		registerPluginFieldDefs({
			sunAzimuth: { type: "number", label: "Sun azimuth" },
		});
		const def = getFieldDef("sunAzimuth");
		expect(def).toBeDefined();
		expect(def!.label).toBe("Sun azimuth");
	});

	it("plugin defs survive a map change", () => {
		registerPluginFieldDefs({
			sunAzimuth: { type: "number", label: "Sun azimuth" },
		});
		setUserFieldDefs({});
		expect(getFieldDef("sunAzimuth")).toBeDefined();
	});
});

describe("user defs (highest priority)", () => {
	it("overrides plugin defs", () => {
		registerPluginFieldDefs({
			sunAzimuth: { type: "number", label: "Sun azimuth" },
		});
		setUserFieldDefs({
			sunAzimuth: { type: "number", label: "My custom label" },
		});
		expect(getFieldDef("sunAzimuth")!.label).toBe("My custom label");
	});

	it("cleared on map change", () => {
		const key = "userOnly_" + Math.random().toString(36).slice(2);
		setUserFieldDefs({
			[key]: { type: "number", label: "Custom" },
		});
		expect(getFieldDef(key)!.label).toBe("Custom");
		setUserFieldDefs({});
		expect(getFieldDef(key)).toBeUndefined();
	});
});

describe("getAllFieldDefs", () => {
	it("merges user and plugin layers", () => {
		registerPluginFieldDefs({
			sunAzimuth: { type: "number", label: "Sun azimuth" },
		});
		setUserFieldDefs({
			altitude: { type: "number", label: "Custom alt" },
			userField: { type: "string", label: "Custom" },
		});
		const all = getAllFieldDefs();
		expect(all.altitude.label).toBe("Custom alt");
		expect(all.sunAzimuth.label).toBe("Sun azimuth");
		expect(all.userField.label).toBe("Custom");
	});

	it("drops user defs on map change", () => {
		setUserFieldDefs({ onlyUser: { type: "string", label: "User" } });
		expect(getAllFieldDefs().onlyUser).toBeDefined();
		setUserFieldDefs({});
		expect(getAllFieldDefs().onlyUser).toBeUndefined();
	});
});

describe("priority order", () => {
	it("user > plugin", () => {
		registerPluginFieldDefs({
			altitude: { type: "number", label: "Plugin alt" },
		});
		expect(getFieldDef("altitude")!.label).toBe("Plugin alt");

		setUserFieldDefs({
			altitude: { type: "number", label: "User alt" },
		});
		expect(getFieldDef("altitude")!.label).toBe("User alt");

		setUserFieldDefs({});
		expect(getFieldDef("altitude")!.label).toBe("Plugin alt");
	});
});

// Rust auto-registers a label-less placeholder into the user layer the first time a
// plugin-owned key appears in data (it can't see the plugin layer). That placeholder
// must not shadow the plugin's real label/comparison -- per-attribute fallthrough.
describe("placeholder does not shadow plugin def", () => {
	it("falls through to the plugin label/comparison when the user attr is null", () => {
		registerPluginFieldDefs({
			sunAzimuth: {
				type: "number",
				label: "Sun azimuth",
				comparison: { type: "circular", period: 360 },
			},
		});
		// Simulates Rust's inferred placeholder landing in the user layer on first write.
		setUserFieldDefs({ sunAzimuth: { type: "number", label: null, comparison: null } });

		const def = getFieldDef("sunAzimuth")!;
		expect(def.label).toBe("Sun azimuth");
		expect(def.comparison).toEqual({ type: "circular", period: 360 });
	});

	it("a real user label still wins over the plugin label", () => {
		registerPluginFieldDefs({ sunAzimuth: { type: "number", label: "Sun azimuth" } });
		setUserFieldDefs({ sunAzimuth: { type: "number", label: "Solar bearing" } });
		expect(getFieldDef("sunAzimuth")!.label).toBe("Solar bearing");
	});

	it("getAllFieldDefs composes the same way", () => {
		registerPluginFieldDefs({
			sunAzimuth: {
				type: "number",
				label: "Sun azimuth",
				comparison: { type: "circular", period: 360 },
			},
		});
		setUserFieldDefs({ sunAzimuth: { type: "number", label: null, comparison: null } });
		const all = getAllFieldDefs();
		expect(all.sunAzimuth.label).toBe("Sun azimuth");
		expect(all.sunAzimuth.comparison).toEqual({ type: "circular", period: 360 });
	});
});

// Consumers (e.g. the filter field list) memo on the key set, which doesn't change on
// a label rename. The version must bump on any def edit so those memos invalidate.
describe("def-change version", () => {
	it("bumps on every layer mutation", () => {
		const v0 = getEventVersion("fields:changed");
		setUserFieldDefs({ a: { type: "number", label: "A" } });
		const v1 = getEventVersion("fields:changed");
		expect(v1).toBeGreaterThan(v0);

		// A label-only rename (same key set) must still bump.
		setUserFieldDefs({ a: { type: "number", label: "A renamed" } });
		expect(getEventVersion("fields:changed")).toBeGreaterThan(v1);

		const v2 = getEventVersion("fields:changed");
		registerPluginFieldDefs({ p: { type: "number", label: "P" } });
		expect(getEventVersion("fields:changed")).toBeGreaterThan(v2);

		const v4 = getEventVersion("fields:changed");
		unregisterPluginFieldDefs(["p"]);
		expect(getEventVersion("fields:changed")).toBeGreaterThan(v4);

		const v5 = getEventVersion("fields:changed");
		setUserFieldDefs({});
		expect(getEventVersion("fields:changed")).toBeGreaterThan(v5);
	});

	it("does not bump when unregistering an empty key list", () => {
		const v = getEventVersion("fields:changed");
		unregisterPluginFieldDefs([]);
		expect(getEventVersion("fields:changed")).toBe(v);
	});
});

describe("projectionsForType", () => {
	// The catalog of grouping keys (UI + KeySpec mapping); key derivation itself lives in
	// Rust (selections.rs), parity-tested in selections.test.rs.
	it("filters projections by field type", () => {
		expect(projectionsForType("string").map((p) => p.id)).toEqual(["value"]);
		expect(projectionsForType("enum").map((p) => p.id)).toEqual(["value"]);
		expect(projectionsForType("number").map((p) => p.id)).toEqual(["value"]);
		expect(projectionsForType("month").map((p) => p.id)).toEqual(["value", "year", "monthOfYear"]);
		expect(projectionsForType("date").map((p) => p.id)).toEqual([
			"year",
			"yearMonth",
			"day",
			"monthOfYear",
			"hourOfDay",
		]);
	});
});
