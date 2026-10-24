import { useEffect, useMemo, useState } from "react";
import { Store } from "@/store/store";
import { Query } from "@/store/query";
import { Tag } from "@/store/tag";
import { SelectionList } from "@/store/selectionList";
import { Edit } from "@/store/edit";
import type { Selection } from "@/bindings.gen";
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
		selections: SelectionList.active().filter((s) => !skip.has(tagIdOf(s.selector) ?? -1)),
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
	const selectedTagIds = Store.use(SelectionList.tagIds);
	const targets = useMemo(() => menuTargetTagIds(node, selectedTagIds), [node, selectedTagIds]);
	const nodeTargets = useMemo(() => [...new Set(node.subtreeTagIds)], [node]);
	const multi = targets.length > nodeTargets.length;
	const own = Store.use(() => (tagId == null ? 0 : (Tag.counts()[tagId] ?? 0)));
	const [counts, setCounts] = useState({ targets: 0, inSel: 0, nodeInSel: 0 });
	const total = multi ? counts.targets : (node.count ?? 0);

	useEffect(() => {
		const carriers = any(...targets.map(tagSelector));
		const scope = selectionWithout(targets);
		const nodeScope = selectionWithout(nodeTargets);
		void Query.read(
			[
				multi ? carriers : any(),
				scope.selections.length > 0 ? all(carriers, scope) : any(),
				multi && nodeTargets.length > 0 && nodeScope.selections.length > 0
					? all(any(...nodeTargets.map(tagSelector)), nodeScope)
					: any(),
			],
			{ kind: "count" },
		).then(([targets, inSel, nodeInSel]) => setCounts({ targets, inSel, nodeInSel }));
	}, [targets, nodeTargets, multi]);

	return (
		<>
			{targets.length > 0 && (
				<>
					<MenuItem tone="destructive" onClick={() => void Tag.remove(targets)}>
						{multi
							? t(
									{
										one: "Remove {tags} tags from all ({n} location)",
										other: "Remove {tags} tags from all ({n} locations)",
									},
									{ n: total, tags: targets.length },
								)
							: t(
									{
										one: "Remove from all ({n} location)",
										other: "Remove from all ({n} locations)",
									},
									{ n: total },
								)}
					</MenuItem>
					{!multi && tagId != null && nodeTargets.length > 1 && (
						<MenuItem tone="destructive" onClick={() => void Tag.remove([tagId])}>
							{t(
								{
									one: "Remove this tag only ({n} location)",
									other: "Remove this tag only ({n} locations)",
								},
								{ n: own },
							)}
						</MenuItem>
					)}
					<MenuItem
						tone="destructive"
						disabled={counts.inSel === 0}
						onClick={() =>
							void Edit.work(selectionWithout(targets), {
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
								void Edit.work(selectionWithout(nodeTargets), {
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
							disabled={total === 0}
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
								{ n: total, tags: targets.length },
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
