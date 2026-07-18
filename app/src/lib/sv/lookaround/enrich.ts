/**
 * Look Around enrichment � patches Google-semantic extra fields from lookmap meta.
 */
import { log } from "@/lib/util/log";
import type { Location } from "@/bindings.gen";
import { registerEnrichmentProvider, type EnrichCtx } from "@/lib/data/fieldDefs";
import { getLocationPanoId, getLocationProvider } from "@/lib/sv/providers/types";
import { META_OPEN } from "./api";
import { resolvePanoForLocation } from "./tile"
import { buildPanoExtra } from "./panoExtra";

function fieldWanted(enrichFields: string[] | null, key: string): boolean {
	return !enrichFields || enrichFields.includes(key);
}

function buildApplePatch(
	pano: NonNullable<Awaited<ReturnType<typeof resolvePanoForLocation>>>,
	enrichFields: string[] | null,
): Record<string, unknown> | null {
	const full = buildPanoExtra(pano);
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(full)) {
		if (fieldWanted(enrichFields, key)) patch[key] = value;
	}
	return Object.keys(patch).length ? patch : null;
}

export function registerLookAroundEnrichment(): void {
	registerEnrichmentProvider({
		id: "lookAroundMeta",
		label: "Look Around metadata",
		fieldDefs: {},
		async enrich(locations, enrichFields, ctx?: EnrichCtx) {
			const patches = new Map<number, Record<string, unknown>>();

			const targets = locations.filter((l: Location) => {
				if (getLocationProvider(l) === "apple") return true;
				if (ctx?.force && !l.panoId) return true;
				return false;
			});

			for (const loc of targets) {
				if (ctx?.signal?.aborted) break;
				try {
					const savedId = getLocationPanoId(loc);
					const pano = await resolvePanoForLocation(loc.lat, loc.lng, savedId, META_OPEN);
					const patch = pano ? buildApplePatch(pano, enrichFields) : null;
					if (patch) patches.set(loc.id, patch);
				} catch (e) {
					log.warn("[lookaround] enrich failed", loc.id, e);
				}
			}
			return patches;
		},
	});
}
