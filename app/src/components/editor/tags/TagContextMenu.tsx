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
import { openDialog } from "@/store/dialogBus";
import { isLeafTag, menuTargetTagIds, type TagTreeNode } from "./tagTreeModel";

type TagContextMenuProps = {
	node: TagTreeNode;
	/** Present on a tag row: move the selected locations to another name. */
	onRenameInSelection?: () => void;
	/** Tree mode only: place this tag at a second folder path. */
	onAddAlias?: () => void;
	/** Tree mode only: present on an alias leaf to remove it. */
	onRemoveAlias?: () => void;
	/** Tree mode only: present on folder rows to create a declared subfolder. */
	onNewSubfolder?: () => void;
	/** Present on a folder row with no tags under it. */
	onDeleteFolder?: () => void;
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
	onRenameInSelection,
	onAddAlias,
	onRemoveAlias,
	onNewSubfolder,
	onDeleteFolder,
}: TagContextMenuProps) {
	const tagId = node.tag?.id ?? null;
	const isFolder = !isLeafTag(node);
	const selectedTagIds = useMapState(getSelectedTagIds);
	const targets = useMemo(() => menuTargetTagIds(node, selectedTagIds), [node, selectedTagIds]);
	const subtreeSize = new Set(node.subtreeTagIds).size;
	const multi = targets.length > subtreeSize;
	const [counts, setCounts] = useState({ total: 0, own: 0, inSel: 0, ownInSel: 0 });

	useEffect(() => {
		const carriers = any(...targets.map(tagSelector));
		const own = tagId == null ? null : tagSelector(tagId);
		const hasSelection = getActiveSelections().length > 0;
		const inSelection = (s: Selector | null) =>
			s && hasSelection ? countIn(all(s, currentSelection())) : Promise.resolve(0);
		void Promise.all([
			countIn(carriers),
			own ? countIn(own) : Promise.resolve(0),
			inSelection(carriers),
			inSelection(own),
		]).then(([total, own, inSel, ownInSel]) => setCounts({ total, own, inSel, ownInSel }));
	}, [tagId, targets]);

	return (
		<>
			{targets.length > 0 && (
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
									{
										one: "Remove from all ({n} location)",
										other: "Remove from all ({n} locations)",
									},
									{ n: counts.total },
								)}
					</MenuItem>
					{!multi && tagId != null && subtreeSize > 1 && (
						<MenuItem tone="destructive" onClick={() => void deleteTags([tagId])}>
							{t(
								{
									one: "Remove this tag only ({n} location)",
									other: "Remove this tag only ({n} locations)",
								},
								{ n: counts.own },
							)}
						</MenuItem>
					)}
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
					{(multi || isFolder) && (
						<MenuItem
							onClick={() =>
								openDialog("recolor-tags", { tagIds: targets, root: multi ? null : node.fullPath })
							}
						>
							{t(
								{ one: "Recolor {n} tag...", other: "Recolor {n} tags..." },
								{ n: targets.length },
							)}
						</MenuItem>
					)}
				</>
			)}
			{!multi && (
				<>
					{onRenameInSelection && (
						<MenuItem disabled={counts.ownInSel === 0} onClick={onRenameInSelection}>
							{t(
								{
									one: "Rename in selection ({n} location)",
									other: "Rename in selection ({n} locations)",
								},
								{ n: counts.ownInSel },
							)}
						</MenuItem>
					)}
					{isFolder && (
						<MenuItem onClick={() => openDialog("rename-folder", node.fullPath)}>
							{t("Rename folder...")}
						</MenuItem>
					)}
					{onAddAlias && <MenuItem onClick={onAddAlias}>{t("Add alias...")}</MenuItem>}
					{onNewSubfolder && <MenuItem onClick={onNewSubfolder}>{t("New subfolder...")}</MenuItem>}
					{onRemoveAlias && (
						<MenuItem tone="destructive" onClick={onRemoveAlias}>
							{t("Remove alias")}
						</MenuItem>
					)}
					{onDeleteFolder && (
						<MenuItem tone="destructive" onClick={onDeleteFolder}>
							{t("Delete folder")}
						</MenuItem>
					)}
				</>
			)}
		</>
	);
}
