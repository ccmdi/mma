import { useEffect, useState } from "react";
import { FullscreenTagBar } from "@/components/editor/location/FullscreenTagBar";
import {
	read,
	getVisibleTags,
	tagIdsToNames,
	updateLocations,
	useMapState,
} from "@/store/useMapStore";
import * as edit from "@/store/edit";
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
		void (async () => {
			const [loc] = await read(
				{ type: "Locations", locations: [locationId], name: null },
				{ kind: "locations" },
			);
			if (!cancelled) setNames(tagIdsToNames(loc?.tags ?? []));
		})();
		return () => {
			cancelled = true;
		};
	}, [locationId]);

	const change = (next: string[]) => {
		setNames(next);
		void (async () => {
			try {
				const { keys: tags } = (
					await edit.values(
						"tags",
						next.map((name) => ({ set: { id: 0, name } })),
					)
				).mutation;
				await updateLocations([{ id: locationId, tags }]);
			} catch (e) {
				toast(e instanceof Error ? e.message : t("Could not update tags"));
			}
		})();
	};

	return <FullscreenTagBar pendingTags={names} onChangeTags={change} tags={tags} />;
}
