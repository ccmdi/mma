import { startTransition, useOptimistic } from "react";
import { useAsync, useSticky } from "@/lib/hooks/useAsync";
import { Store } from "@/store/store";
import { Query } from "@/store/query";
import { Tag } from "@/store/tag";
import { Location } from "@/store/location";
import { pendingTagIds, type PendingTags } from "@/lib/data/tags";
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
		return { ids: loc?.tags ?? [], names: [] };
	}, [locationId]);
	const [pending, showPending] = useOptimistic<PendingTags>(
		useSticky(tagged, locationId).ok() ?? { ids: [], names: [] },
	);

	const change = (next: PendingTags) =>
		startTransition(async () => {
			showPending(next);
			try {
				await Location.update([{ id: locationId, tags: await pendingTagIds(next) }]);
			} catch (e) {
				toast(e instanceof Error ? e.message : t("Could not update tags"));
			}
			await tagged.rerun();
		});

	return <FullscreenTagBar pendingTags={pending} onChangeTags={change} tags={tags} />;
}
