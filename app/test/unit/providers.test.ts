import { createFieldDef } from "@/types";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/util/log", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
}));

import {
	enabledEnrichKeys,
	enrichInputs,
	getEnrichFieldOptions,
	getAllEnrichKeys,
	getDefaultEnrichKeys,
	isFieldEnabled,
} from "@/lib/data/fieldDefs";
import { enrichRuns } from "@/lib/sv/providers";
import { getFieldDef } from "@/lib/data/fieldDefRegistry";
import type { ProcedureSpec } from "@/lib/data/procedure";
import { Provider } from "@/lib/data/provider";

const procedure: ProcedureSpec = { entry: "res://procedures/test.js", batch: { mode: "perRow" } };

// The providers array is module-level and accumulates, so tests see
// providers from prior registrations. We test behavior, not count.

describe("Provider.register", () => {
	it("registers a provider that appears in Provider.list", () => {
		const provider = {
			id: "test-provider-" + Math.random(),
			label: "Test",
			procedure: { ...procedure },
			fieldDefs: { testField: createFieldDef("number", { label: "Test" }) },
		};
		void Provider.register(provider);
		expect(Provider.list()).toContain(provider);
	});

	it("does not register duplicate providers", () => {
		const id = "dedup-test-" + Math.random();
		const p1 = { id, label: "P1", procedure: { ...procedure }, fieldDefs: {} };
		const p2 = { id, label: "P2", procedure: { ...procedure }, fieldDefs: {} };
		void Provider.register(p1);
		void Provider.register(p2);
		expect(Provider.list().filter((p) => p.id === id)).toHaveLength(1);
	});

	it("ignores a provider that declares no procedure", () => {
		const id = "no-procedure-" + Math.random();
		// @ts-expect-error procedure is required; this is the runtime guard for plugins.
		void Provider.register({ id, fieldDefs: {} });
		expect(Provider.list().some((p) => p.id === id)).toBe(false);
	});

	it("registers plugin fieldDefs into the registry", () => {
		const id = "registry-test-" + Math.random();
		const key = "registryTestField_" + Math.random().toString(36).slice(2);
		void Provider.register({
			id,
			label: "Registry test",
			procedure: { ...procedure },
			fieldDefs: { [key]: createFieldDef("number", { label: "Registered" }) },
		});
		expect(getFieldDef(key)).toBeDefined();
		expect(getFieldDef(key)!.label).toBe("Registered");
	});
});

describe("enrichment field options", () => {
	const provide = (key: string, extra: { defaultOff?: boolean } = {}) =>
		void Provider.register({
			id: "options-" + key,
			label: "Options",
			procedure: { ...procedure },
			fieldDefs: { [key]: createFieldDef("number", { label: "Label of " + key }) },
			...extra,
		});

	it("offers each provider field under its field label", () => {
		const key = "enrichTest_" + Math.random().toString(36).slice(2);
		provide(key);
		expect(getEnrichFieldOptions()).toContainEqual(
			expect.objectContaining({ key, label: "Label of " + key }),
		);
		expect(getDefaultEnrichKeys()).toContain(key);
	});

	it("keeps a defaultOff provider's fields selectable but out of the default set", () => {
		const key = "enrichOptIn_" + Math.random().toString(36).slice(2);
		provide(key, { defaultOff: true });
		expect(getAllEnrichKeys()).toContain(key);
		expect(getDefaultEnrichKeys()).not.toContain(key);
	});

	it("lists a core field once even when a provider produces it", () => {
		expect(getEnrichFieldOptions().filter((o) => o.key === "datetime")).toHaveLength(1);
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

describe("enrichment dependencies", () => {
	const field = (name: string) => name + "_" + Math.random().toString(36).slice(2);
	const provide = (key: string, requires: string[]) =>
		void Provider.register({
			id: "deps-" + key,
			label: "Deps " + key,
			procedure: { ...procedure },
			fieldDefs: { [key]: createFieldDef("number", { label: key }) },
			defaultOff: true,
			requires,
		});

	it("enables every field a chosen field reads, however deep", () => {
		const [sun, date, month] = [field("sun"), field("date"), field("month")];
		provide(month, ["panoId"]);
		provide(date, [month]);
		provide(sun, [date, "lat"]);
		expect(enrichInputs(sun)).toEqual([date]);
		expect(enabledEnrichKeys([sun]).sort()).toEqual([sun, date, month].sort());
		expect(isFieldEnabled([sun], month)).toBe(true);
		expect(isFieldEnabled([date], sun)).toBe(false);
	});

	it("stops at a cycle", () => {
		const [a, b] = [field("a"), field("b")];
		provide(a, [b]);
		provide(b, [a]);
		expect(enabledEnrichKeys([a]).sort()).toEqual([a, b].sort());
	});

	it("runs the providers of the fields a chosen field reads", () => {
		const [sun, date] = [field("sun"), field("date")];
		provide(date, []);
		provide(sun, [date]);
		const fieldsOf = (id: string) =>
			enrichRuns([sun]).find((run) => run.provider.id === "deps-" + id)?.fields;
		expect(fieldsOf(sun)).toEqual([sun]);
		expect(fieldsOf(date)).toEqual([date]);
	});

	it("never forces a field that runs only because a chosen field reads it", () => {
		const [sun, date] = [field("sun"), field("date")];
		provide(date, []);
		provide(sun, [date]);
		const runOf = (id: string) => enrichRuns([sun]).find((run) => run.provider.id === "deps-" + id);
		expect(runOf(sun)?.force).toBeUndefined();
		expect(runOf(date)?.force).toBe(false);
		expect(
			enrichRuns([sun, date]).find((run) => run.provider.id === "deps-" + date)?.force,
		).toBeUndefined();
	});
});
