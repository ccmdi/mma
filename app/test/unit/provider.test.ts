import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFieldDef } from "@/types";

const h = vi.hoisted(() => ({
	registered: [] as unknown[],
	unregistered: [] as string[],
	runs: [] as unknown[][],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/autosave", () => ({ Autosave: { hold: () => () => {} } }));
vi.mock("@/bindings.gen", () => ({
	events: {
		procedureProgress: { listen: async () => () => {} },
		procedureResult: { listen: async () => () => {} },
	},
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		providerRegister: async (def: unknown) => {
			h.registered.push(def);
		},
		providerUnregister: async (id: string) => {
			h.unregistered.push(id);
		},
		runReserve: async () => 1,
		procedureRun: async (items: unknown[]) => {
			h.runs.push(items);
			throw new Error("stop after sending");
		},
	},
}));

import { Provider } from "@/lib/data/provider";
import { disposePlugin, runAsPlugin } from "@/plugins/scope";

const sun = {
	id: "sun",
	label: "Sun",
	requires: ["lat", "lng"],
	fieldDefs: {
		sunAltitude: createFieldDef("number", { label: "Altitude" }),
		sunAzimuth: createFieldDef("number", { label: "Azimuth" }),
	},
	procedure: {
		entry: "res://procedures/sun.js",
		batch: { mode: "chunk", size: 500 } as const,
		config: { precise: true },
	},
};

beforeEach(() => {
	h.registered = [];
	h.unregistered = [];
	h.runs = [];
});

describe("Provider", () => {
	it("registers its declaration with the engine once, and unregisters when its plugin goes", async () => {
		await runAsPlugin("sun-plugin", () => Provider.register(sun));
		expect(h.registered).toEqual([
			{
				id: "sun",
				label: "Sun",
				entry: "res://procedures/sun.js",
				rate: null,
				retry: null,
				inflight: null,
				config: '{"precise":true}',
				fields: ["sunAltitude", "sunAzimuth"],
				provides: [],
				requires: ["lat", "lng"],
				batch: { mode: "chunk", size: 500 },
				instances: null,
			},
		]);
		await Provider.register(sun);
		expect(h.registered).toHaveLength(1);
		expect(Provider.forField("sunAzimuth")?.id).toBe("sun");

		disposePlugin("sun-plugin");
		expect(h.unregistered).toEqual(["sun"]);
		expect(Provider.list().some((p) => p.id === "sun")).toBe(false);
	});

	it("runs registered providers by id with only what the run changes", async () => {
		await runAsPlugin("sun-plugin", () => Provider.register(sun));
		await expect(
			Provider.run(
				[{ provider: sun, fields: ["sunAzimuth"], config: { precise: false }, force: true }],
				{ type: "Everything" },
			),
		).rejects.toThrow("stop after sending");
		expect(h.runs).toEqual([
			[
				{
					kind: "provider",
					id: "sun",
					fields: ["sunAzimuth"],
					select: { type: "Everything" },
					config: '{"precise":false}',
					force: true,
				},
			],
		]);
		disposePlugin("sun-plugin");
	});
});
