import { useState, useMemo, useEffect, useCallback } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon } from "@/components/primitives/Icon";
import { mdiChevronDown, mdiChevronRight, mdiPencil } from "@mdi/js";
import { textColorFor } from "@/lib/util/color";
import { fmt } from "@/lib/util/format";
import {
	toggleTagSelections,
	removeTagFromAllLocations,
	getSelectedLocationIds,
    removeTagFromLocations,
} from "@/store/useMapStore";
import { cmd } from "@/lib/commands";
import type { Tag } from "@/types";

interface TagTreeNode {
	segment: string;
	fullPath: string;
	tag: Tag | null;
	inheritedColor: string;
	children: TagTreeNode[];
	descendantTagIds: number[];
}

function buildTagTree(tags: Tag[]): TagTreeNode[] {
	const root: TagTreeNode[] = [];

	const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));

	for (const tag of sorted) {
		const parts = tag.name.split("/");
		let level = root;
		let pathSoFar = "";

		for (let i = 0; i < parts.length; i++) {
			const segment = parts[i];
			pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
			const isLeaf = i === parts.length - 1;

			let existing = level.find((n) => n.segment === segment);
			if (!existing) {
				existing = {
					segment,
					fullPath: pathSoFar,
					tag: isLeaf ? tag : null,
					inheritedColor: "",
					children: [],
					descendantTagIds: [],
				};
				level.push(existing);
			} else if (isLeaf && !existing.tag) {
				existing.tag = tag;
			}

			level = existing.children;
		}
	}

	function propagateColor(nodes: TagTreeNode[], parentColor: string | null) {
		for (const node of nodes) {
			const ownColor = node.tag?.color ?? null;
			const effectiveColor = ownColor ?? parentColor ?? "#888888";
			node.inheritedColor = effectiveColor;
			propagateColor(node.children, effectiveColor);
		}
	}

	function collectDescendantIds(node: TagTreeNode): number[] {
		const ids: number[] = [];
		if (node.tag) ids.push(node.tag.id);
		for (const child of node.children) {
			ids.push(...collectDescendantIds(child));
		}
		node.descendantTagIds = ids;
		return ids;
	}

	propagateColor(root, null);
	for (const node of root) collectDescendantIds(node);

	return root;
}

function sumCounts(node: TagTreeNode, tagCounts: Record<number, number>): number {
	let total = node.tag ? (tagCounts[node.tag.id] ?? 0) : 0;
	for (const child of node.children) total += sumCounts(child, tagCounts);
	return total;
}

const EXPANDED_KEY = "tagTreeExpanded";

function loadExpanded(): Set<string> {
	try {
		const raw = localStorage.getItem(EXPANDED_KEY);
		if (raw) return new Set(JSON.parse(raw));
	} catch { /* ignored */ }
	return new Set();
}

function saveExpanded(set: Set<string>) {
	localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
}

interface TagTreeViewProps {
	tags: Tag[];
	selectedTagIds: Set<number>;
	tagCounts: Record<number, number>;
	onEditTag: (tagId: number) => void;
	onRenameTag: (tag: { id: number; name: string }) => void;
	filterText: string;
}

export function TagTreeView({
	tags,
	selectedTagIds,
	tagCounts,
	onEditTag,
	onRenameTag,
	filterText,
}: TagTreeViewProps) {
	const tree = useMemo(() => buildTagTree(tags), [tags]);
	const [expandedPaths, setExpandedPaths] = useState(loadExpanded);

	const toggleExpanded = useCallback((path: string) => {
		setExpandedPaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			saveExpanded(next);
			return next;
		});
	}, []);

	const filteredTree = useMemo(() => {
		if (!filterText) return tree;
		const lower = filterText.toLowerCase();

		function filterNodes(nodes: TagTreeNode[]): TagTreeNode[] {
			const result: TagTreeNode[] = [];
			for (const node of nodes) {
				const nameMatch = node.segment.toLowerCase().includes(lower);
				const filteredChildren = filterNodes(node.children);
				if (nameMatch || filteredChildren.length > 0) {
					result.push({ ...node, children: filteredChildren });
				}
			}
			return result;
		}

		return filterNodes(tree);
	}, [tree, filterText]);

	return (
		<ul className="tag-tree">
			{filteredTree.map((node) => (
				<TagTreeNodeRow
					key={node.fullPath}
					node={node}
					depth={0}
					selectedTagIds={selectedTagIds}
					tagCounts={tagCounts}
					onEditTag={onEditTag}
					onRenameTag={onRenameTag}
					forceExpanded={!!filterText}
					expandedPaths={expandedPaths}
					onToggleExpanded={toggleExpanded}
				/>
			))}
		</ul>
	);
}

function TagTreeNodeRow({
	node,
	depth,
	selectedTagIds,
	tagCounts,
	onEditTag,
	onRenameTag,
	forceExpanded,
	expandedPaths,
	onToggleExpanded,
}: {
	node: TagTreeNode;
	depth: number;
	selectedTagIds: Set<number>;
	tagCounts: Record<number, number>;
	onEditTag: (tagId: number) => void;
	onRenameTag: (tag: { id: number; name: string }) => void;
	forceExpanded: boolean;
	expandedPaths: Set<string>;
	onToggleExpanded: (path: string) => void;
}) {
	const hasChildren = node.children.length > 0;
	const isOpen = forceExpanded || expandedPaths.has(node.fullPath);

	const isSelected = node.tag ? selectedTagIds.has(node.tag.id) : false;
	const allChildrenSelected =
		hasChildren && node.descendantTagIds.every((id) => selectedTagIds.has(id));
	const someChildrenSelected =
		hasChildren &&
		!allChildrenSelected &&
		node.descendantTagIds.some((id) => selectedTagIds.has(id));

	const effectiveSelected = isSelected || allChildrenSelected;

	const bg = node.inheritedColor;
	const fg = textColorFor(bg);
	const count = sumCounts(node, tagCounts);

	const handleClick = () => {
		const ids = node.descendantTagIds.filter((id) =>
			effectiveSelected ? selectedTagIds.has(id) : !selectedTagIds.has(id),
		);
		toggleTagSelections(ids);
	};

	const handleChevronClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		onToggleExpanded(node.fullPath);
	};

	return (
		<li className="tag-tree__node">
			<ContextMenu.Root modal={false}>
				<ContextMenu.Trigger asChild>
					<div
						className={`tag-tree__row${effectiveSelected ? " is-selected" : ""}${someChildrenSelected ? " is-partial" : ""}`}
						style={{
							backgroundColor: bg,
							color: fg,
							marginLeft: `${depth * 1.25}rem`,
						}}
						onClick={handleClick}
					>
						{hasChildren ? (
							<button
								className="tag-tree__chevron"
								onClick={handleChevronClick}
								type="button"
								style={{ color: fg }}
							>
								<Icon path={isOpen ? mdiChevronDown : mdiChevronRight} size={18} />
							</button>
						) : (
							<span className="tag-tree__chevron-spacer" />
						)}
						<span className="tag-tree__label">{node.segment}</span>
						<small className="tag-tree__count">{fmt.format(count)}</small>
						<button
							className="button tag-tree__edit"
							onClick={(e) => {
								e.stopPropagation();
								if (node.tag) onEditTag(node.tag.id);
							}}
							type="button"
							style={{ color: fg, visibility: node.tag ? "visible" : "hidden" }}
						>
							<Icon path={mdiPencil} size={14} />
						</button>
					</div>
				</ContextMenu.Trigger>
				{node.tag && (
					<ContextMenu.Portal>
						<TreeContextMenu
							node={node}
							tagCounts={tagCounts}
							onRename={() =>
								onRenameTag({ id: node.tag!.id, name: node.tag!.name })
							}
						/>
					</ContextMenu.Portal>
				)}
			</ContextMenu.Root>
			{hasChildren && isOpen && (
				<ul className="tag-tree__children">
					{node.children.map((child) => (
						<TagTreeNodeRow
							key={child.fullPath}
							node={child}
							depth={depth + 1}
							selectedTagIds={selectedTagIds}
							tagCounts={tagCounts}
							onEditTag={onEditTag}
							onRenameTag={onRenameTag}
							forceExpanded={forceExpanded}
							expandedPaths={expandedPaths}
							onToggleExpanded={onToggleExpanded}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

function TreeContextMenu({
	node,
	tagCounts,
	onRename,
}: {
	node: TagTreeNode;
	tagCounts: Record<number, number>;
	onRename: () => void;
}) {
	const totalCount = sumCounts(node, tagCounts);
	const tagId = node.tag!.id;
	const [selCount, setSelCount] = useState<number | null>(null);

	useEffect(() => {
		const selIds = getSelectedLocationIds();
		if (selIds.size === 0) {
			setSelCount(0);
			return;
		}
		cmd.storeResolveSelection({ type: "Tag", tagId }).then((tagLocIds) => {
			let c = 0;
			for (const id of tagLocIds) if (selIds.has(id)) c++;
			setSelCount(c);
		});
	}, [tagId]);

	const inSel = selCount ?? 0;

	return (
		<ContextMenu.Content className="context-menu">
			<ContextMenu.Item
				className="context-menu__item"
				onSelect={() => removeTagFromAllLocations(tagId)}
			>
				Remove from all ({fmt.format(totalCount)} locations)
			</ContextMenu.Item>
			<ContextMenu.Item
				className="context-menu__item"
				disabled={inSel === 0}
				onSelect={() => removeTagFromLocations(tagId, [...getSelectedLocationIds()])}
			>
				Remove from selection ({fmt.format(inSel)} locations)
			</ContextMenu.Item>
			<ContextMenu.Item
				className="context-menu__item"
				disabled={inSel === 0}
				onSelect={onRename}
			>
				Rename in selection ({fmt.format(inSel)} locations)
			</ContextMenu.Item>
		</ContextMenu.Content>
	);
}
