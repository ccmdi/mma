import type { Selector } from "@/bindings.gen";
import { buildSelection } from "@/store/selections";
import {
	noWork,
	procedureEntry,
	runProviders,
	type BatchOutcome,
	type RunOpts,
} from "@/lib/data/procedures";
import { panoResolveProvider } from "@/lib/sv/enrich";
import { GET_METADATA_INFLIGHT } from "@/lib/sv/constants";
import { registerProvider, type Provider } from "@/lib/data/fieldDefs";
import { msg } from "@/lib/i18n";

export interface PinPanoConfig {
	useLatest?: boolean;
}

/** Pin to pano ID: set the LoadAsPanoId flag so the location always loads the same
 *  panorama. With `useLatest`, move it to the newest official pano in the timeline
 *  first. The pano id itself comes from `panoResolve`, which runs before it. */
export const pinPanoProvider: Provider = {
	id: "pinPano",
	label: msg("Pin to pano ID"),
	requires: ["panoId"],
	procedure: {
		entry: procedureEntry("pinPano"),
		batch: { mode: "chunk", size: 1000 },
		retry: { attempts: 3, on: [429, 500, 503] },
		inflight: GET_METADATA_INFLIGHT,
	},
};

registerProvider(pinPanoProvider);

function unpinnedIn(selector: Selector): Selector {
	return {
		type: "Intersection",
		selections: [buildSelection(selector), buildSelection({ type: "NotPanoIds" })],
	};
}

/** Pin each location in the selector to a resolved panorama (sets `panoId`), so it always
 *  loads the same pano. */
export async function bulkPinToPano(
	selector: Selector,
	opts: RunOpts & { useLatest?: boolean } = {},
): Promise<BatchOutcome> {
	const { useLatest, force = false, ...runOpts } = opts;
	const target = force ? undefined : unpinnedIn(selector);
	// Pinning resolves the panorama, it does not merely fill a missing one: a row that
	// already carries a stale pano id is re-resolved to what is at its coordinates now,
	// which is what the operation means.
	const resolve = await runProviders(
		[
			{
				provider: {
					...panoResolveProvider,
					procedure: { ...panoResolveProvider.procedure, select: target },
				},
				force: true,
			},
		],
		selector,
		{ ...runOpts, force },
	);
	// Its own run, after the resolve verdicts are in: a row whose re-resolve failed keeps
	// what it had and is not pinned -- a stale, possibly dead pano must not gain the flag.
	const unresolved = resolve.panoResolve?.failed ?? [];
	const base = target ?? selector;
	const pinTarget: Selector =
		unresolved.length === 0
			? base
			: {
					type: "Intersection",
					selections: [
						base,
						{
							type: "Invert",
							selections: [
								buildSelection({ type: "Locations", locations: unresolved, name: null }),
							],
						} as Selector,
					].map(buildSelection),
				};
	const result = await runProviders(
		[
			{
				provider: {
					...pinPanoProvider,
					// Without force the engine only ever sees rows that need pinning, so what
					// it reports is the count of locations actually pinned.
					procedure: { ...pinPanoProvider.procedure, select: pinTarget },
				},
				config: { useLatest: !!useLatest } satisfies PinPanoConfig,
			},
		],
		selector,
		{ ...runOpts, force },
	);
	const pinned = result.pinPano ?? noWork();
	return { succeeded: pinned.succeeded, failed: [...unresolved, ...pinned.failed] };
}
