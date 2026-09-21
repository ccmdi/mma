import { useEffect, useMemo, useState } from "react";
import type { Selector } from "@/bindings.gen";
import {
	countIn,
	currentSelection,
	deleteTags,
	getActiveSelections,
	getMapState,
	setTags,
	useMapState,
} from "@/store/useMapStore";
import { getSelectedTagIds } from "@/store/selectionActions";
import { all, any, tagSelector } from "@/store/selections";
import { MenuItem, MenuPopup } from "@/components/primitives/Menu";
import { t } from "@/lib/i18n";
import { menuTargetTagIds, type TagTreeNode } from "./tagTreeModel";

type TagContextMenuProps = {
	node: TagTreeNode;
	onRename: () => void;
	/** Tree mode only: place this tag at a second folder path. */
	onAddAlias?: () => void;
	/** Tree mode only: present on an alias leaf to remove it. */
	onRemoveAlias?: () => void;
	/** Tree mode only: present on folder rows to create a declared subfolder. */
	onNewSubfolder?: () => void;
};

export function TagContextMenu(props: TagContextMenuProps) {
	return (
		<MenuPopup>
			<TagContextMenuItems {...props} />
		</MenuPopup>
	);
}

function TagContextMenuItems({
	node,
	onRename,
	onAddAlias,
	onRemoveAlias,
	onNewSubfolder,
}: TagContextMenuProps) {
	const tagId = node.tag!.id;
	const selectedTagIds = useMapState(getSelectedTagIds);
	const targets = useMemo(() => menuTargetTagIds(node, selectedTagIds), [node, selectedTagIds]);
	const multi = targets.length > new Set(node.subtreeTagIds).size;
	const [counts, setCounts] = useState({ total: 0, inSel: 0, ownInSel: 0 });

	useEffect(() => {
		const carriers = any(...targets.map(tagSelector));
		const hasSelection = getActiveSelections().length > 0;
		const inSelection = (s: Selector) =>
			hasSelection ? countIn(all(s, currentSelection())) : Promise.resolve(0);
		void Promise.all([
			countIn(carriers),
			inSelection(carriers),
			inSelection(tagSelector(tagId)),
		]).then(([total, inSel, ownInSel]) => setCounts({ total, inSel, ownInSel }));
	}, [tagId, targets]);

	return (
		<>
			<MenuItem tone="destructive" onClick={() => void deleteTags(targets)}>
				{multi
					? t(
							{
								one: "Remove {tags} tags from all ({n} location)",
								other: "Remove {tags} tags from all ({n} locations)",
							},
							{ n: counts.total, tags: targets.length },
						)
					: t(
							{ one: "Remove from all ({n} location)", other: "Remove from all ({n} locations)" },
							{ n: counts.total },
						)}
			</MenuItem>
			<MenuItem
				tone="destructive"
				disabled={counts.inSel === 0}
				onClick={() =>
					void setTags([], targets, {
						type: "Locations",
						locations: [...getMapState().selectedLocationIds],
						name: null,
					})
				}
			>
				{multi
					? t(
							{
								one: "Remove {tags} tags from selection ({n} location)",
								other: "Remove {tags} tags from selection ({n} locations)",
							},
							{ n: counts.inSel, tags: targets.length },
						)
					: t(
							{
								one: "Remove from selection ({n} location)",
								other: "Remove from selection ({n} locations)",
							},
							{ n: counts.inSel },
						)}
			</MenuItem>
			{!multi && (
				<>
					<MenuItem disabled={counts.ownInSel === 0} onClick={onRename}>
						{t(
							{
								one: "Rename in selection ({n} location)",
								other: "Rename in selection ({n} locations)",
							},
							{ n: counts.ownInSel },
						)}
					</MenuItem>
					{onAddAlias && <MenuItem onClick={onAddAlias}>{t("Add alias...")}</MenuItem>}
					{onNewSubfolder && <MenuItem onClick={onNewSubfolder}>{t("New subfolder...")}</MenuItem>}
					{onRemoveAlias && (
						<MenuItem tone="destructive" onClick={onRemoveAlias}>
							{t("Remove alias")}
						</MenuItem>
					)}
				</>
			)}
		</>
	);
}
