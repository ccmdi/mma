/**
 * Generic engine for Street-View-dependent bulk operations. Every such op derives
 * a `Partial<Location>` from a location's pano data; each is a `SvResolver`. The
 * runner does the shared work once -- resolve missing pano IDs, fetch metadata in
 * batches (with all-null bisection), merge every selected resolver's patch per
 * location, write once -- then runs the enrichment providers in dependency waves.
 *
 * `enrichAll` and `bulkPinToPano` are thin selectors over this engine; the modal's
 * "Street View" operation runs an arbitrary set of resolvers.
 */

import type { Location, ExtraFieldDef } from "@/bindings.gen";
import { fetchLocationsByIds, updateLocations } from "@/store/useMapStore";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { resolvePanoIds } from "@/lib/sv/lookup";
import { getEnrichmentProviders, providerWaves } from "@/lib/data/fieldDefs";
import { runConcurrent } from "@/lib/util/concurrent";
import type { Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";

// 200 is GetMetadata's hard per-request cap; concurrency saturates the endpoint ~48.
const BATCH_SIZE = 200;
const META_CONCURRENCY = 48;

export type PanoData = google.maps.StreetViewResolvedPanoramaData;

export interface SvResolver {
	id: string;
	label: string;
	/** Locations this resolver would act on, given `force` (drives counts + skip). */
	pending(loc: Location, force: boolean): boolean;
	/** Locations this resolver needs a coords->panoId resolution for (prelude). */
	needsPanoResolve?(loc: Location, force: boolean): boolean;
	/** Whether this resolver consumes fetched `PanoData` (joins the metadata phase).
	 *  When a function, receives the config passed via `selected[].config`. */
	needsMetadata?: boolean | ((config: unknown) => boolean);
	/** Per-location patch derived in the metadata phase. `data` is null for resolvers
	 *  that don't need metadata (they act off the prelude-resolved panoId).
	 *  `ctx.resolvedPanoId` is set only when this run resolved the pano from coords. */
	resolve?(
		loc: Location,
		data: PanoData | null,
		ctx: { config: unknown; resolvedPanoId?: string },
	): Partial<Location> | null;
	/** When set, the runner also runs the registered enrichment providers. */
	runsProviders?: boolean;
	fieldDefs?: Record<string, ExtraFieldDef>;
}

export interface ResolverOutcome {
	success: number[];
	failed: number[];
}
export type SvRunResult = Record<string, ResolverOutcome>;

const registry: SvResolver[] = [];

export function registerSvResolver(r: SvResolver) {
	if (!registry.some((x) => x.id === r.id)) registry.push(r);
}

export function getSvResolvers(): SvResolver[] {
	return registry;
}

/** Merge resolver patches for one location: `extra` deep-merges into the location's
 *  existing extra; every other key overwrites. Same rule as `fieldOps.planFieldSet`. */
export function mergePatches(
	loc: Location,
	patches: Partial<Location>[],
): Partial<Location> | null {
	const out: Record<string, unknown> = {};
	let extra: Record<string, unknown> | undefined;
	for (const p of patches) {
		for (const [k, v] of Object.entries(p)) {
			if (k === "extra")
				extra = { ...(extra ?? (loc.extra as Record<string, unknown>) ?? {}), ...(v as object) };
			else out[k] = v;
		}
	}
	if (extra) out.extra = extra;
	return Object.keys(out).length > 0 ? (out as Partial<Location>) : null;
}

export interface RunOpts {
	signal?: AbortSignal;
	force?: boolean;
	/** `label` names the current phase (set by slow provider waves; undefined = main pass).
	 *  `done`/`total` are per-phase -- they reset when the label changes. */
	onProgress?: (done: number, total: number, label?: string) => void;
}

export async function runResolvers(
	locations: Location[],
	selected: { id: string; config?: unknown }[],
	opts: RunOpts = {},
): Promise<SvRunResult> {
	const { signal, force = false, onProgress } = opts;
	const chosen = selected
		.map((s) => ({ r: registry.find((x) => x.id === s.id), config: s.config }))
		.filter((x): x is { r: SvResolver; config: unknown } => !!x.r);

	const result: SvRunResult = {};
	for (const { r } of chosen) result[r.id] = { success: [], failed: [] };
	if (chosen.length === 0) return result;

	const scopeIds = locations.map((l) => l.id);
	const configOf = (id: string) => chosen.find((c) => c.r.id === id)?.config;

	// --- Progress: each pass reports as its own labeled phase (per-phase done/total) --
	//     pano-resolve prelude, metadata, then the provider waves. ---
	const wantsMeta = ({ r, config }: { r: SvResolver; config: unknown }) =>
		typeof r.needsMetadata === "function" ? r.needsMetadata(config) : !!r.needsMetadata;
	const metaResolvers = chosen.filter(wantsMeta);
	const metaPending = locations.filter((l) => metaResolvers.some(({ r }) => r.pending(l, force)));
	const needResolve = locations.filter((l) =>
		chosen.some(({ r }) => r.pending(l, force) && r.needsPanoResolve?.(l, force)),
	);
	let done = 0;
	const tick = (n = 1) => {
		done += n;
		onProgress?.(done, metaPending.length);
	};

	// --- Phase 0: resolve missing pano IDs for the union that needs them. ---
	const allUpdates: Update<LocationPatch>[] = [];
	let resolvedPanoIds: Map<number, string> | undefined;
	if (needResolve.length > 0) {
		onProgress?.(0, needResolve.length, "Resolving panoramas");
		const pr = await resolvePanoIds(needResolve, {
			signal,
			onProgress: (d) => onProgress?.(d, needResolve.length, "Resolving panoramas"),
		});
		resolvedPanoIds = new Map(pr.resolved.map((x) => [x.id, x.panoId]));
		for (const { id, panoId } of pr.resolved) {
			allUpdates.push({ id, patch: { panoId } });
		}
	}
	const panoIdFor = (l: Location) => l.panoId ?? resolvedPanoIds?.get(l.id);

	// --- Resolvers that act off the prelude only (no metadata), e.g. pin to pano. ---
	const flagResolvers = chosen.filter((c) => c.r.resolve && !wantsMeta(c));

	// --- Phase 1: metadata. Fetch each pano once, run every metadata resolver. ---
	const metaLocs = metaPending.filter((l) => panoIdFor(l));
	// Locations that need metadata but have no pano fail their metadata resolvers.
	const metaNoPano = metaPending.filter((l) => !panoIdFor(l));
	for (const loc of metaNoPano)
		for (const { r } of metaResolvers) if (r.pending(loc, force)) result[r.id].failed.push(loc.id);

	async function metaBatch(batch: Location[], panoIds: string[]): Promise<void> {
		signal?.throwIfAborted();
		const datas = await fetchSvMetadata(panoIds);
		signal?.throwIfAborted();

		if (batch.length > 1 && datas.every((d) => d == null)) {
			const mid = Math.ceil(batch.length / 2);
			await metaBatch(batch.slice(0, mid), panoIds.slice(0, mid));
			await metaBatch(batch.slice(mid), panoIds.slice(mid));
			return;
		}

		for (let j = 0; j < batch.length; j++) {
			const loc = batch[j];
			const data = datas[j];
			const patches: Partial<Location>[] = [];
			for (const { r, config } of metaResolvers) {
				if (!r.pending(loc, force)) continue;
				if (!data) {
					result[r.id].failed.push(loc.id);
					continue;
				}
				const patch = r.resolve?.(loc, data, {
					config,
					resolvedPanoId: resolvedPanoIds?.get(loc.id),
				});
				result[r.id].success.push(loc.id);
				if (patch) patches.push(patch);
			}
			const merged = mergePatches(loc, patches);
			if (merged) allUpdates.push({ id: loc.id, patch: merged });
		}
	}

	if (metaPending.length > 0) onProgress?.(0, metaPending.length);
	const metaBatches: Location[][] = [];
	for (let i = 0; i < metaLocs.length; i += BATCH_SIZE)
		metaBatches.push(metaLocs.slice(i, i + BATCH_SIZE));
	await runConcurrent(
		metaBatches,
		async (batch) => {
			await metaBatch(
				batch,
				batch.map((l) => panoIdFor(l)!),
			);
			tick(Math.min(BATCH_SIZE, batch.length));
		},
		{ concurrency: META_CONCURRENCY, signal },
	);
	if (metaNoPano.length > 0) tick(metaNoPano.length);

	// --- Flag-only resolvers (pin to pano): patch off the prelude result. ---
	if (flagResolvers.length > 0) {
		for (const loc of locations) {
			const patches: Partial<Location>[] = [];
			for (const { r, config } of flagResolvers) {
				if (!r.pending(loc, force)) continue;
				const patch = r.resolve?.(loc, null, {
					config,
					resolvedPanoId: resolvedPanoIds?.get(loc.id),
				});
				if (patch) {
					result[r.id].success.push(loc.id);
					patches.push(patch);
				} else {
					result[r.id].failed.push(loc.id);
				}
			}
			const merged = mergePatches(loc, patches);
			if (merged) allUpdates.push({ id: loc.id, patch: merged });
		}
	}

	await updateLocations(allUpdates);

	// --- Phase 2: enrichment providers (when an enrich-style resolver ran), in
	//     dependency waves -- a provider runs once no other provider still produces
	//     a field it requires, against fresh store data re-fetched per wave.
	//     Slow waves (units > 0) report as their own labeled progress phase. ---
	if (chosen.some(({ r }) => r.runsProviders)) {
		const enrichFields = (configOf("enrichMeta") as string[] | null | undefined) ?? null;
		for (const wave of providerWaves(getEnrichmentProviders())) {
			signal?.throwIfAborted();
			const pluginLocs = await fetchLocationsByIds(scopeIds);
			const byId = new Map(pluginLocs.map((l) => [l.id, l]));
			const units = wave.map((p) => p.units?.(pluginLocs, enrichFields, force) ?? 0);
			const waveTotal = units.reduce((a, b) => a + b, 0);
			const slow = wave.filter((p, i) => units[i] > 0 && p.label);
			const label =
				slow.length === 1 ? slow[0].label : slow.length > 1 ? "Enriching fields" : undefined;
			let waveDone = 0;
			if (waveTotal > 0) onProgress?.(0, waveTotal, label);
			const outcomeOf = (id: string) => (result[id] ??= { success: [], failed: [] });
			const results = await Promise.all(
				wave.map((p) =>
					p.enrich(pluginLocs, enrichFields, {
						signal,
						force,
						onUnit: () => onProgress?.(++waveDone, waveTotal, label),
						onFail: (id) => outcomeOf(p.id).failed.push(id),
					}),
				),
			);
			const mergedById = new Map<number, Record<string, unknown>>();
			results.forEach((res, i) => {
				const outcome = outcomeOf(wave[i].id);
				for (const [id, patch] of res) {
					outcome.success.push(id);
					mergedById.set(id, { ...mergedById.get(id), ...patch });
				}
			});
			// Write before honoring an abort, so partial provider results persist.
			if (mergedById.size > 0) {
				await updateLocations(
					[...mergedById.entries()].map(([id, patch]) => ({
						id,
						patch: { extra: { ...byId.get(id)?.extra, ...patch } },
					})),
				);
			}
			signal?.throwIfAborted();
		}
	}

	return result;
}
