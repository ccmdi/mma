import { waitForReady, withApi } from "./helpers";

describe("parity probe", () => {
	before(async () => {
		await waitForReady();
	});

	it("reports the API shape this build exposes", async () => {
		const shape = await withApi(async (api) => {
			const a = api as unknown as Record<string, unknown>;
			const kind = (v: unknown) =>
				typeof v === "function" ? `fn/${(v as (...x: unknown[]) => unknown).length}` : typeof v;
			const names = [
				"addLocations",
				"createMap",
				"openMap",
				"closeMap",
				"deleteMap",
				"fetchLocations",
				"updateLocations",
				"updateMapMeta",
				"getMapState",
				"waitForInflightPersist",
				"cancelAutosave",
				"enrichAll",
				"bulkPinToPano",
				"validateLocations",
				"cmd",
				"_test",
			];
			const present: Record<string, string> = {};
			for (const n of names) present[n] = kind(a[n]);

			const cmd = a.cmd as Record<string, (...x: unknown[]) => Promise<unknown>> | undefined;
			const test = a._test as Record<string, (...x: unknown[]) => Promise<unknown>> | undefined;
			const out: Record<string, unknown> = { present };
			if (!cmd?.storeCreateMap) return out;

			const created = (await cmd.storeCreateMap("Probe map", null)) as Record<string, unknown>;
			out.createdKeys = Object.keys(created ?? {});
			const meta = (created?.meta ?? created) as Record<string, unknown>;
			const id = String(meta.id);
			out.mapId = id;
			if (test?.openMap) await test.openMap(id);
			else if (a.openMap) await (a.openMap as (i: string) => Promise<unknown>)(id);

			const state = (a.getMapState as () => Record<string, unknown>)();
			out.stateKeys = Object.keys(state).slice(0, 40);
			const map = state.map as Record<string, unknown> | null;
			out.mapKeys = map ? Object.keys(map) : [];
			const settings = (map && ("meta" in map ? (map.meta as Record<string, unknown>) : map))
				?.settings as Record<string, unknown> | undefined;
			out.settingsKeys = settings ? Object.keys(settings) : [];

			const enrich = a.enrichAll as ((...x: unknown[]) => unknown) | undefined;
			out.enrichAllSource = enrich ? String(enrich).slice(0, 220) : null;

			if (a.closeMap) await (a.closeMap as () => Promise<void>)();
			if (a.deleteMap) await (a.deleteMap as (i: string) => Promise<void>)(id);
			return out;
		});
		console.log("[probe] " + JSON.stringify(shape, null, 1));
	});
});
