import { startTransition, useOptimistic } from "react";
import { useAsync, useSticky } from "@/lib/hooks/useAsync";
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
	const tagged = useAsync(async () => {
		const [loc] = await Query.read(
			{ type: "Locations", locations: [locationId], name: null },
			{ kind: "locations" },
		);
		return Tag.names(loc?.tags ?? []);
	}, [locationId]);
	const [names, showNames] = useOptimistic(useSticky(tagged, locationId).ok() ?? []);

	const change = (next: string[]) =>
		startTransition(async () => {
			showNames(next);
			try {
				const { keys: tags } = await Edit.values(
					"tags",
					next.map((name) => ({ add: { id: 0, name } })),
				);
				await Location.update([{ id: locationId, tags }]);
			} catch (e) {
				toast(e instanceof Error ? e.message : t("Could not update tags"));
			}
			await tagged.rerun();
		});

	return <FullscreenTagBar pendingTags={names} onChangeTags={change} tags={tags} />;
}
