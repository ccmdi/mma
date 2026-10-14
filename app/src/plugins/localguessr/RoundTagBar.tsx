import { useEffect, useState } from "react";
import { Store } from "@/store/store";
import { Query } from "@/store/query";
import { Tag } from "@/store/tag";
import { Location } from "@/store/location";
import { Edit } from "@/store/edit";
import { FullscreenTagBar } from "@/components/editor/location/FullscreenTagBar";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";

/**
 * The editor's tag bar, wired to the round's location. Unlike the editor it edits a
 * location that already exists, so each change writes straight through rather than
 * staging until save.
 */
export function RoundTagBar({ locationId }: { locationId: number }) {
	const tags = Store.use(Tag.visible);
	const [names, setNames] = useState<string[]>([]);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const [loc] = await Query.read(
				{ type: "Locations", locations: [locationId], name: null },
				{ kind: "locations" },
			);
			if (!cancelled) setNames(Tag.names(loc?.tags ?? []));
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
					await Edit.values(
						"tags",
						next.map((name) => ({ add: { id: 0, name } })),
					)
				).mutation;
				await Location.update([{ id: locationId, tags }]);
			} catch (e) {
				toast(e instanceof Error ? e.message : t("Could not update tags"));
			}
		})();
	};

	return <FullscreenTagBar pendingTags={names} onChangeTags={change} tags={tags} />;
}
