import { useEffect, useMemo, useState } from "react";
import type { Selection } from "@/bindings.gen";
import { read, deleteTags, getActiveSelections, useMapState } from "@/store/useMapStore";
import * as edit from "@/store/edit";
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
	const nodeTargets = useMemo(() => [...new Set(node.subtreeTagIds)], [node]);
	const multi = targets.length > nodeTargets.length;
	const [counts, setCounts] = useState({ total: 0, own: 0, inSel: 0, nodeInSel: 0 });

	useEffect(() => {
		const carriers = any(...targets.map(tagSelector));
		const scope = selectionWithout(targets);
		const nodeScope = selectionWithout(nodeTargets);
		void Promise.all([
			read(carriers, { kind: "count" }, "count").then((r) => r.count),
			tagId == null ? 0 : read(tagSelector(tagId), { kind: "count" }, "count").then((r) => r.count),
			scope.selections.length > 0
				? read(all(carriers, scope), { kind: "count" }, "count").then((r) => r.count)
				: 0,
			multi && nodeTargets.length > 0 && nodeScope.selections.length > 0
				? read(
						all(any(...nodeTargets.map(tagSelector)), nodeScope),
						{ kind: "count" },
						"count",
					).then((r) => r.count)
				: 0,
		]).then(([total, own, inSel, nodeInSel]) => setCounts({ total, own, inSel, nodeInSel }));
	}, [tagId, targets, nodeTargets, multi]);

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
					{!multi && tagId != null && nodeTargets.length > 1 && (
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
							void edit.work(selectionWithout(targets), {
								kind: "listSet",
								key: "tags",
								add: [],
								remove: targets,
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
					{multi && nodeTargets.length > 0 && (
						<MenuItem
							tone="destructive"
							disabled={counts.nodeInSel === 0}
							onClick={() =>
								void edit.work(selectionWithout(nodeTargets), {
									kind: "listSet",
									key: "tags",
									add: [],
									remove: nodeTargets,
								})
							}
						>
							{nodeTargets.length > 1
								? t(
										{
											one: "Remove only these {tags} tags from selection ({n} location)",
											other: "Remove only these {tags} tags from selection ({n} locations)",
										},
										{ n: counts.nodeInSel, tags: nodeTargets.length },
									)
								: t(
										{
											one: "Remove only this tag from selection ({n} location)",
											other: "Remove only this tag from selection ({n} locations)",
										},
										{ n: counts.nodeInSel },
									)}
						</MenuItem>
					)}
					{multi && (
						<MenuItem
							disabled={counts.total === 0}
							onClick={() =>
								openDialog("rename-tags", {
									tagIds: targets,
									name: node.tag?.name ?? node.fullPath,
									scope: null,
								})
							}
						>
							{t(
								{
									one: "Rename {tags} tags in all ({n} location)",
									other: "Rename {tags} tags in all ({n} locations)",
								},
								{ n: counts.total, tags: targets.length },
							)}
						</MenuItem>
					)}
					<MenuItem
						disabled={counts.inSel === 0}
						onClick={() =>
							openDialog("rename-tags", {
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
