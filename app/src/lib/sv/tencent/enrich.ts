/**
 * Tencent enrichment — patches Google-semantic extra fields from sv API.
 */
import { log } from "@/lib/util/log";
import type { Location } from "@/bindings.gen";
import { registerEnrichmentProvider, type EnrichCtx } from "@/lib/data/fieldDefs";
import { getLocationPanoId, getLocationProvider } from "@/lib/sv/providers/types";
import { fetchTencentMeta, resolveTencentNear } from "./api";
import { buildTencentExtra } from "./panoExtra";

function fieldWanted(enrichFields: string[] | null, key: string): boolean {
	return !enrichFields || enrichFields.includes(key);
}

export function registerTencentEnrichment(): void {
	registerEnrichmentProvider({
		id: "tencentMeta",
		label: "Tencent Street View metadata",
		fieldDefs: {},
		async enrich(locations, enrichFields, ctx?: EnrichCtx) {
			const patches = new Map<number, Record<string, unknown>>();

			const targets = locations.filter(
				(l: Location) => getLocationProvider(l) === "tencent",
			);

			for (const loc of targets) {
				if (ctx?.signal?.aborted) break;
				try {
					const savedId = getLocationPanoId(loc);
					const meta = savedId
						? await fetchTencentMeta(savedId)
						: await resolveTencentNear(loc.lat, loc.lng);
					if (!meta) continue;
					const full = buildTencentExtra(meta);
					const patch: Record<string, unknown> = {};
					for (const [key, value] of Object.entries(full)) {
						if (fieldWanted(enrichFields, key)) patch[key] = value;
					}
					if (Object.keys(patch).length) patches.set(loc.id, patch);
				} catch (e) {
					log.warn("[tencent] enrich failed", loc.id, e);
				}
			}
			return patches;
		},
	});
}
