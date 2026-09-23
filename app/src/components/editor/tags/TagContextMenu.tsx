import { useEffect, useMemo, useState } from "react";
import type { Selection } from "@/bindings.gen";
import { query, deleteTags, getActiveSelections, setTags, useMapState } from "@/store/useMapStore";
import { getSelectedTagIds } from "@/store/selectionActions";
import { all, any, tagIdOf, tagSelector } from "@/store/selections";
import { MenuItem, MenuPopup } from "@/components/primitives/Menu";
import { t } from "@/lib/i18n";
import { openDialog } from "@/store/dialogBus";
import { isLeafTag, menuTargetTagIds, type TagTreeNode } from "./tagTreeModel";

type TagContextMenuProps = {
	node: TagTreeNode;
	/** Tree mode only: place this tag at a second folder path. */
	onAddAlias?: () => void;
	/** Tree mode only: present on an alias leaf to remove it. */
	onRemoveAlias?: () => void;
	/** Tree mode only: present on folder rows to create a declared subfolder. */
	onNewSubfolder?: () => void;
	/** Present on a folder row with no tags under it. */
	onDeleteFolder?: () => void;
};

/** The live selection without the selections that pick one of `tagIds` by tag: a tag's own
 *  selection never counts as "the selection" when editing that tag within it. */
function selectionWithout(tagIds: readonly number[]): { type: "Union"; selections: Selection[] } {
	const skip = new Set(tagIds);
	return {
		type: "Union",
		selections: getActiveSelections().filter((s) => !skip.has(tagIdOf(s.selector) ?? -1)),
	};
}

export function TagContextMenu(props: TagContextMenuProps) {
	return (
		<MenuPopup>
			<TagContextMenuItems {...props} />
		</MenuPopup>
	);
}

function TagContextMenuItems({
	node,
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
	const [counts, setCounts] = useState({ total: 0, own: 0, inSel: 0 });

	useEffect(() => {
		const carriers = any(...targets.map(tagSelector));
		const scope = selectionWithout(targets);
		void Promise.all([
			query(carriers).count(),
			tagId == null ? 0 : query(tagSelector(tagId)).count(),
			scope.selections.length > 0 ? query(all(carriers, scope)).count() : 0,
		]).then(([total, own, inSel]) => setCounts({ total, own, inSel }));
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
						onClick={() => void setTags([], targets, selectionWithout(targets))}
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
					<MenuItem
						disabled={counts.inSel === 0}
						onClick={() =>
							openDialog("rename-in-selection", {
								tagIds: targets,
								name: node.tag?.name ?? node.fullPath,
								scope: selectionWithout(targets),
							})
						}
					>
						{multi
							? t(
									{
										one: "Rename {tags} tags in selection ({n} location)",
										other: "Rename {tags} tags in selection ({n} locations)",
									},
									{ n: counts.inSel, tags: targets.length },
								)
							: t(
									{
										one: "Rename in selection ({n} location)",
										other: "Rename in selection ({n} locations)",
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
