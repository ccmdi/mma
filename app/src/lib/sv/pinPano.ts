import type { Selector } from "@/bindings.gen";
import { PanoType, type CapturePick } from "@/bindings.consts";
import { buildSelection } from "@/store/selections";
import { applyFieldOp } from "@/store/useMapStore";
import { runProviders, type BatchOutcome, type BulkOpts } from "@/lib/data/procedures";
import { panoResolveProvider } from "@/lib/sv/enrich";

/** How a bulk pin settles each location's pano before pinning it. */
export interface PinOpts extends BulkOpts {
	/** Resolve pano ids first; off, only locations that already carry one are pinned. */
	resolve?: boolean;
	/** Move each resolved pano to this capture of its timeline. */
	capture?: CapturePick | null;
	/** Re-resolve already pinned locations too. */
	force?: boolean;
}

/** What a bulk pin did: the locations newly pinned, the ones whose pano could not be
 *  resolved, and how many pano ids the resolve wrote. */
export interface PinOutcome extends BatchOutcome {
	resolved: number;
}

const intersect = (...selectors: Selector[]): Selector => ({
	type: "Intersection",
	selections: selectors.map(buildSelection),
});

/** Pin every location in the selector to its pano id, resolving pano ids first when asked. */
export async function bulkPinToPano(selector: Selector, opts: PinOpts = {}): Promise<PinOutcome> {
	const { resolve = true, capture = null, force = false, ...runOpts } = opts;
	let resolved = 0;
	let failed: number[] = [];
	if (resolve) {
		const target = force ? selector : intersect(selector, { type: "NotPanoIds" });
		// A pin searches official coverage only: the closest pano can be a photosphere.
		const result = await runProviders(
			[
				{
					provider: {
						...panoResolveProvider,
						procedure: { ...panoResolveProvider.procedure, select: target },
					},
					config: { sources: [PanoType.Official], ...(capture ? { capture } : {}) },
					force: force || capture !== null,
				},
			],
			selector,
			runOpts,
		);
		resolved = result.panoResolve?.succeeded ?? 0;
		failed = result.panoResolve?.failed ?? [];
	}
	if (runOpts.signal?.aborted) return { succeeded: 0, failed, resolved };
	const pinned = await applyFieldOp(
		intersect(selector, { type: "Filter", field: "panoId", test: { op: "has" } }),
		{ kind: "set", key: "loadAsPanoId", value: 1 },
		true,
	);
	return { succeeded: pinned.changed, failed: [...failed, ...pinned.failed], resolved };
}
