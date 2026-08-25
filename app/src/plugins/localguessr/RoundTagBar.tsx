import { useEffect, useState } from "react";
import { FullscreenTagBar } from "@/components/editor/location/FullscreenTagBar";
import {
	createTags,
	fetchLocations,
	getVisibleTags,
	tagIdsToNames,
	updateLocations,
	useMapState,
} from "@/store/useMapStore";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";

/**
 * The editor's tag bar, wired to the round's location. Unlike the editor it edits a
 * location that already exists, so each change writes straight through rather than
 * staging until save.
 */
export function RoundTagBar({ locationId }: { locationId: number }) {
	const tags = useMapState(getVisibleTags);
	const [names, setNames] = useState<string[]>([]);

	useEffect(() => {
		let cancelled = false;
		void fetchLocations({ type: "Locations", locations: [locationId], name: null }).then((locs) => {
			if (!cancelled) setNames(tagIdsToNames(locs[0]?.tags ?? []));
		});
		return () => {
			cancelled = true;
		};
	}, [locationId]);

	const change = (next: string[]) => {
		setNames(next);
		void (async () => {
			try {
				const resolved = next.length > 0 ? await createTags(next) : [];
				await updateLocations([{ id: locationId, patch: { tags: resolved.map((x) => x.id) } }]);
			} catch (e) {
				toast(e instanceof Error ? e.message : t("Could not update tags"));
			}
		})();
	};

	return <FullscreenTagBar pendingTags={names} onChangeTags={change} tags={tags} />;
}
