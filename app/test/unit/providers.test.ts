import { createFieldDef } from "@/types";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/util/log", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
}));

import {
	registerProvider,
	getProviders,
	registerEnrichFields,
	getEnrichFieldOptions,
	getAllEnrichKeys,
	getDefaultEnrichKeys,
	isFieldEnabled,
} from "@/lib/data/fieldDefs";
import { getFieldDef } from "@/lib/data/fieldDefRegistry";
import type { ProcedureSpec } from "@/lib/data/fieldDefs";

const procedure: ProcedureSpec = { entry: "res://procedures/test.js", batch: { mode: "perRow" } };

// The providers array is module-level and accumulates, so tests see
// providers from prior registrations. We test behavior, not count.

describe("registerProvider", () => {
	it("registers a provider that appears in getProviders", () => {
		const provider = {
			id: "test-provider-" + Math.random(),
			procedure: { ...procedure },
			fieldDefs: { testField: createFieldDef("number", { label: "Test" }) },
		};
		registerProvider(provider);
		expect(getProviders()).toContain(provider);
	});

	it("does not register duplicate providers", () => {
		const id = "dedup-test-" + Math.random();
		const p1 = { id, procedure: { ...procedure }, fieldDefs: {} };
		const p2 = { id, procedure: { ...procedure }, fieldDefs: {} };
		registerProvider(p1);
		registerProvider(p2);
		expect(getProviders().filter((p) => p.id === id)).toHaveLength(1);
	});

	it("ignores a provider that declares no procedure", () => {
		const id = "no-procedure-" + Math.random();
		// @ts-expect-error procedure is required; this is the runtime guard for plugins.
		registerProvider({ id, fieldDefs: {} });
		expect(getProviders().some((p) => p.id === id)).toBe(false);
	});

	it("registers plugin fieldDefs into the registry", () => {
		const id = "registry-test-" + Math.random();
		const key = "registryTestField_" + Math.random().toString(36).slice(2);
		registerProvider({
			id,
			procedure: { ...procedure },
			fieldDefs: { [key]: createFieldDef("number", { label: "Registered" }) },
		});
		expect(getFieldDef(key)).toBeDefined();
		expect(getFieldDef(key)!.label).toBe("Registered");
	});
});

describe("registerEnrichFields", () => {
	it("adds field options for the enrichment settings UI", () => {
		const key = "enrichTest_" + Math.random().toString(36).slice(2);
		registerEnrichFields([{ key, label: "Test enrichment field" }]);
		const options = getEnrichFieldOptions();
		expect(options.some((o) => o.key === key)).toBe(true);
	});

	it("does not add duplicate field options", () => {
		const key = "enrichDedup_" + Math.random().toString(36).slice(2);
		registerEnrichFields([{ key, label: "A" }]);
		registerEnrichFields([{ key, label: "B" }]);
		expect(getEnrichFieldOptions().filter((o) => o.key === key)).toHaveLength(1);
	});

	it("includes core fields by default", () => {
		const options = getEnrichFieldOptions();
		expect(options.some((o) => o.key === "altitude")).toBe(true);
		expect(options.some((o) => o.key === "countryCode")).toBe(true);
		expect(options.some((o) => o.key === "datetime")).toBe(true);
	});

	it("excludes defaultOff fields from the default set but keeps them selectable", () => {
		expect(getAllEnrichKeys()).toContain("drivingDirection");
		expect(getDefaultEnrichKeys()).not.toContain("drivingDirection");
		// non-defaultOff core fields remain in the default set
		expect(getDefaultEnrichKeys()).toContain("altitude");
	});

	it("treats exact date / timezone as opt-in (expensive, not enriched by default)", () => {
		expect(getDefaultEnrichKeys()).not.toContain("datetime");
		expect(getDefaultEnrichKeys()).not.toContain("timezone");
		expect(getAllEnrichKeys()).toContain("datetime");
	});
});

describe("isFieldEnabled", () => {
	it("is false for opt-in fields under the default set", () => {
		expect(isFieldEnabled(null, "datetime")).toBe(false);
		expect(isFieldEnabled(null, "altitude")).toBe(true);
	});

	it("respects an explicit enrichFields list", () => {
		expect(isFieldEnabled(["datetime"], "datetime")).toBe(true);
		expect(isFieldEnabled(["altitude"], "datetime")).toBe(false);
	});
});
