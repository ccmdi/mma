import {
	memo,
	useState,
	useMemo,
	useCallback,
	useRef,
	useImperativeHandle,
	createContext,
	useContext,
} from "react";
import { Edit } from "@/store/edit";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { Icon } from "@/components/primitives/Icon";
import { Pill } from "@/components/primitives/Pill";
import { mdiChevronDown, mdiChevronRight, mdiPencil, mdiFolder } from "@mdi/js";
import { textColorFor } from "@/lib/util/color";
import { fmt } from "@/lib/util/format";
import { tagSelector, toggleSelection } from "@/store/selections";
import { useStableHandler } from "@/lib/hooks/useStableHandler";
import { useItemDrag } from "@/lib/hooks/useItemDrag";
import { TagContextMenu } from "./TagContextMenu";
import { rebasePath } from "@/lib/data/tagPaths";
import {
	rangeToggleTagIds,
	stepDrop,
	collectDragBlock,
	isEffectivelySelected,
	moveBlock,
	hoverDrop,
	useTagTree,
	type TagTreeSource,
	isLeafTag,
	loadExpanded,
	saveExpanded,
	resolveExpandedPaths,
	type TagTreeNode,
	type TagMoveResult,
	type TagTreeExpansionIntent,
	type DropTarget,
} from "./tagTreeModel";
import { t } from "@/lib/i18n";
import { matches } from "@/lib/search";
import { IconButton } from "@/components/primitives/IconButton";

/** Identity-stable gesture handlers -- volatile drag state travels as separate
 *  dragPaths/dropTarget props so memoized rows aren't invalidated by this object. */
interface TreeDragHandlers {
	onMouseDown: (e: React.MouseEvent, node: TagTreeNode) => void;
	onMouseMove: (
		e: React.MouseEvent,
		node: TagTreeNode,
		el: HTMLElement,
		horizontal?: boolean,
	) => void;
	onKeyDown: (e: React.KeyboardEvent, node: TagTreeNode) => void;
}

interface TagTreeCallbacks {
	onEditTag: (node: TagTreeNode) => void;
	onEditVirtual: (fullPath: string) => void;
	onAddAlias: (tag: { id: number; name: string }) => void;
	onRemoveAlias: (aliasPath: string) => void;
	onNewFolder: (parentPath: string) => void;
	onDeleteFolder: (path: string) => void;
	onRowClick: (node: TagTreeNode, shiftKey: boolean, altKey: boolean) => void;
	onToggleExpanded: (intent: TagTreeExpansionIntent) => void;
	drag: TreeDragHandlers;
}

const TagTreeCtx = createContext<TagTreeCallbacks>(null!);

export interface TagTreeHandle {
	/** Rewrite expanded-folder paths after a cascade rename so the renamed folder stays open. */
	remapExpanded: (oldPrefix: string, newPrefix: string) => void;
}

interface TagTreeViewProps extends TagTreeSource {
	selectedTagIds: ReadonlySet<number>;
	onEditTag: (node: TagTreeNode) => void;
	onEditVirtual: (fullPath: string) => void;
	onAddAlias: (tag: { id: number; name: string }) => void;
	onRemoveAlias: (aliasPath: string) => void;
	/** Commit a move (renames + settings rewrites + order rebase). Must render it
	 *  optimistically -- the drop handler clears its drag state synchronously. */
	onMove: (move: TagMoveResult) => void;
	/** Open the new-folder dialog under `parentPath` ("" = root). */
	onNewFolder: (parentPath: string) => void;
	/** Delete a declared folder subtree (only offered when it holds no tags). */
	onDeleteFolder: (path: string) => void;
	filterText: string;
}

// Plain function component on purpose: in React 19.2 `useEffectEvent` closures never
// update inside memo()/forwardRef()-wrapped components (frozen at mount values).
export function TagTreeView({
	tags,
	split,
	selectedTagIds,
	sortMode,
	virtualTags,
	aliases,
	onEditTag,
	onEditVirtual,
	onAddAlias,
	onRemoveAlias,
	onMove,
	onNewFolder,
	onDeleteFolder,
	filterText,
	ref,
}: TagTreeViewProps & { ref?: React.Ref<TagTreeHandle> }) {
	const tree = useTagTree({ tags, split, sortMode, virtualTags, aliases });
	const [expandedPaths, setExpandedPaths] = useState(loadExpanded);

	const toggleExpanded = useCallback(
		(intent: TagTreeExpansionIntent) => {
			setExpandedPaths((prev) => {
				const next = resolveExpandedPaths(tree, prev, intent);
				saveExpanded(next);
				return next;
			});
		},
		[tree],
	);

	useImperativeHandle(
		ref,
		() => ({
			remapExpanded(oldPrefix, newPrefix) {
				if (oldPrefix === newPrefix) return;
				setExpandedPaths((prev) => {
					const next = new Set([...prev].map((p) => rebasePath(p, oldPrefix, newPrefix) ?? p));
					saveExpanded(next);
					return next;
				});
			},
		}),
		[],
	);

	const filteredTree = useMemo(() => {
		if (!filterText) return tree;

		function filterNodes(nodes: TagTreeNode[]): TagTreeNode[] {
			const result: TagTreeNode[] = [];
			for (const node of nodes) {
				const nameMatch = matches(filterText, node.segment);
				const filteredChildren = filterNodes(node.children);
				if (nameMatch || filteredChildren.length > 0) {
					result.push({ ...node, children: filteredChildren });
				}
			}
			return result;
		}

		return filterNodes(tree);
	}, [tree, filterText]);

	const forceExpanded = !!filterText;

	// Flattened render order of currently-visible rows — the basis for shift-click ranges.
	// Must match the render split exactly: leaf pills first, then branch rows (recursed).
	const visibleRows = useMemo(() => {
		const rows: TagTreeNode[] = [];
		const walk = (nodes: TagTreeNode[]) => {
			for (const node of nodes) if (isLeafTag(node)) rows.push(node);
			for (const node of nodes) {
				if (isLeafTag(node)) continue;
				rows.push(node);
				const isOpen = forceExpanded || expandedPaths.has(node.fullPath);
				if (node.children.length > 0 && isOpen) walk(node.children);
			}
		};
		walk(filteredTree);
		return rows;
	}, [filteredTree, expandedPaths, forceExpanded]);

	const rowIndex = useMemo(
		() => new Map(visibleRows.map((n, i) => [n.fullPath, i])),
		[visibleRows],
	);

	const anchorPathRef = useRef<string | null>(null);

	// --- Drag: move into a folder, and reorder within a level ---
	// Plain drag moves the grabbed node; ctrl+drag also carries its selected siblings.
	const [dragPaths, setDragPaths] = useState<ReadonlySet<string> | null>(null);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	// A filtered tree hides the neighbours a drop reads its position from, so no drag at all.
	const dragEnabled = !filterText;
	// Only "default" has an order a drag can rewrite; every other sort derives one, so
	// dropping between two siblings would be a no-op. Moving into a folder still works.
	const reorderEnabled = sortMode === "default";
	const draggedRef = useRef(false);
	const dragNodeRef = useRef<TagTreeNode | null>(null);
	const dragBlockRef = useRef<Set<string> | null>(null);
	const previewRef = useRef<HTMLUListElement>(null);
	const dragPosRef = useRef({ x: 0, y: 0 });
	// Mirror dropTarget into a ref + always-current tree so the window mouseup can commit
	// the reorder wherever the release lands (live-insertion can leave the cursor over the
	// hidden gap, where a per-element onMouseUp would never fire).
	const dropTargetRef = useRef<DropTarget | null>(null);
	const treeRef = useRef(tree);
	treeRef.current = tree;
	// Set while dragging a leaf pill — drives the floating "picked up" preview.
	const [dragLeaf, setDragLeaf] = useState<{
		color: string;
		label: string;
		count: number;
		extra: number;
	} | null>(null);

	const applyDropTarget = (v: DropTarget | null) => {
		dropTargetRef.current = v;
		setDropTarget(v);
	};

	const startDrag = useItemDrag((e, node: TagTreeNode) => {
		if (!dragEnabled || node.isAlias) return null; // alias leaves aren't reorderable
		if ((e.target as HTMLElement).closest("button")) return null;
		(e.currentTarget as HTMLElement).focus(); // the drag suppresses the click's own focus
		// Grab offset within the pill, so the pickup point stays under the cursor (not the top-left corner).
		const rect = e.currentTarget.getBoundingClientRect();
		const grabX = e.clientX - rect.left;
		const grabY = e.clientY - rect.top;
		let block = new Set([node.fullPath]);
		let multi: boolean | null = null;
		// Ctrl is read live during the drag, so pressing/releasing it mid-gesture
		// grows/shrinks the carried block.
		const syncBlock = (me: MouseEvent) => {
			const m = me.ctrlKey || me.metaKey;
			if (m === multi) return;
			multi = m;
			block = new Set(
				m ? collectDragBlock(treeRef.current, node, selectedTagIds) : [node.fullPath],
			);
			dragBlockRef.current = block;
			setDragPaths(block);
			setDragLeaf((prev) => (prev ? { ...prev, extra: block.size - 1 } : prev));
		};
		return {
			onStart: () => {
				draggedRef.current = true;
				dragNodeRef.current = node;
				document.body.classList.add("mm-tag-dragging");
				if (isLeafTag(node)) {
					setDragLeaf({
						color: node.tag!.color,
						label: node.segment,
						count: node.count ?? 0,
						extra: 0,
					});
				}
			},
			onMove: (me) => {
				syncBlock(me);
				dragPosRef.current = { x: me.clientX - grabX, y: me.clientY - grabY };
				const el = previewRef.current;
				if (el) {
					el.style.left = `${dragPosRef.current.x - 4}px`;
					el.style.top = `${dragPosRef.current.y - 4}px`;
				}
				const over = (me.target as Element).closest?.("[data-tree-path]");
				if (!over && dropTargetRef.current) applyDropTarget(null);
			},
			// onMove renders optimistically, so clearing in the same batch settles the
			// drop instantly with no flash back to the old slot.
			onDrop: () => {
				const dropT = dropTargetRef.current;
				const move =
					dropT && moveBlock(treeRef.current, [...block], dropT, tags, virtualTags, aliases);
				if (move) onMove(move);
			},
			onEnd: () => {
				document.body.classList.remove("mm-tag-dragging");
				dragNodeRef.current = null;
				dragBlockRef.current = null;
				dropTargetRef.current = null;
				setDragPaths(null);
				setDropTarget(null);
				setDragLeaf(null);
			},
		};
	});

	const handleDragMouseDown = useStableHandler((e: React.MouseEvent, node: TagTreeNode) => {
		draggedRef.current = false; // fresh interaction; a drag that ends off-row won't fire a click to clear it
		startDrag(e, node);
	});

	const handleDragMouseMove = useStableHandler(
		(e: React.MouseEvent, node: TagTreeNode, el: HTMLElement, horizontal = false) => {
			const src = dragNodeRef.current;
			const block = dragBlockRef.current;
			if (!src || !block) return;
			const rect = el.getBoundingClientRect();
			const at = horizontal
				? (e.clientX - rect.left) / rect.width
				: (e.clientY - rect.top) / rect.height;
			const next = hoverDrop(treeRef.current, block, src, node, at, reorderEnabled);
			const cur = dropTargetRef.current;
			if (cur?.path !== next?.path || cur?.position !== next?.position) applyDropTarget(next);
		},
	);

	// Alt+Arrow is the keyboard route through the same reorder the drag commits.
	const handleDragKeyDown = useStableHandler((e: React.KeyboardEvent, node: TagTreeNode) => {
		if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
		if (!dragEnabled || !reorderEnabled || node.isAlias) return;
		const drop = stepDrop(treeRef.current, node, e.key === "ArrowUp" ? -1 : 1);
		const move =
			drop && moveBlock(treeRef.current, [node.fullPath], drop, tags, virtualTags, aliases);
		if (!move) return;
		e.preventDefault();
		e.stopPropagation();
		onMove(move);
	});

	const drag: TreeDragHandlers = useMemo(
		() => ({
			onMouseDown: handleDragMouseDown,
			onMouseMove: handleDragMouseMove,
			onKeyDown: handleDragKeyDown,
		}),
		[handleDragMouseDown, handleDragMouseMove, handleDragKeyDown],
	);

	const handleRowClick = useStableHandler(
		(node: TagTreeNode, shiftKey: boolean, altKey: boolean) => {
			if (draggedRef.current) {
				draggedRef.current = false;
				return; // suppress the click that ends a drag
			}
			const targetIdx = rowIndex.get(node.fullPath);
			const anchorIdx =
				anchorPathRef.current != null ? rowIndex.get(anchorPathRef.current) : undefined;

			let ids: number[];
			if (shiftKey && anchorIdx != null && targetIdx != null && anchorIdx !== targetIdx) {
				ids = rangeToggleTagIds(visibleRows, anchorIdx, targetIdx);
			} else if (altKey && node.tag) {
				// Solo: toggle only this node's own tag, ignoring descendants.
				ids = [node.tag.id];
			} else {
				// Single-node select/deselect of its whole subtree.
				const effectiveSelected = isEffectivelySelected(node, selectedTagIds);
				ids = node.subtreeTagIds.filter((id) =>
					effectiveSelected ? selectedTagIds.has(id) : !selectedTagIds.has(id),
				);
			}
			void Edit.selections(toggleSelection(...ids.map(tagSelector)));
			anchorPathRef.current = node.fullPath;
		},
	);

	const treeCallbacks = useMemo<TagTreeCallbacks>(
		() => ({
			onEditTag,
			onEditVirtual,
			onAddAlias,
			onRemoveAlias,
			onNewFolder,
			onDeleteFolder,
			onRowClick: handleRowClick,
			onToggleExpanded: toggleExpanded,
			drag,
		}),
		[
			onEditTag,
			onEditVirtual,
			onAddAlias,
			onRemoveAlias,
			onNewFolder,
			onDeleteFolder,
			handleRowClick,
			toggleExpanded,
			drag,
		],
	);

	const rootPills = filteredTree.filter(isLeafTag);
	const rootRows = filteredTree.filter((n) => !isLeafTag(n));

	return (
		<TagTreeCtx.Provider value={treeCallbacks}>
			<TagLeafGroup
				nodes={rootPills}
				depth={0}
				selectedTagIds={selectedTagIds}
				dragPaths={dragPaths}
				dropTarget={dropTarget}
			/>
			{rootRows.length > 0 && (
				<ul className="tag-tree">
					{rootRows.map((node) => (
						<TagTreeNodeRow
							key={node.fullPath}
							node={node}
							depth={0}
							selectedTagIds={selectedTagIds}
							forceExpanded={forceExpanded}
							expandedPaths={expandedPaths}
							dragPaths={dragPaths}
							dropTarget={dropTarget}
						/>
					))}
				</ul>
			)}
			{dragLeaf &&
				createPortal(
					<ul
						className="tag-list tag-drag-preview"
						ref={previewRef}
						style={{ left: dragPosRef.current.x - 4, top: dragPosRef.current.y - 4 }}
					>
						<TagPill
							as="li"
							color={dragLeaf.color}
							label={dragLeaf.label}
							count={dragLeaf.count}
							button={<TagPillButton variant="edit" tabIndex={-1} />}
						>
							{dragLeaf.extra > 0 && (
								<Pill tone="action" className="tag-drag-preview__count">
									+{dragLeaf.extra}
								</Pill>
							)}
						</TagPill>
					</ul>,
					document.body,
				)}
		</TagTreeCtx.Provider>
	);
}

const TagTreeNodeRow = memo(function TagTreeNodeRow({
	node,
	depth,
	selectedTagIds,
	forceExpanded,
	expandedPaths,
	dragPaths,
	dropTarget,
}: {
	node: TagTreeNode;
	depth: number;
	selectedTagIds: ReadonlySet<number>;
	forceExpanded: boolean;
	expandedPaths: Set<string>;
	dragPaths: ReadonlySet<string> | null;
	dropTarget: DropTarget | null;
}) {
	const {
		onEditTag,
		onEditVirtual,
		onAddAlias,
		onNewFolder,
		onDeleteFolder,
		onRowClick,
		onToggleExpanded,
		drag,
	} = useContext(TagTreeCtx);
	const hasChildren = node.children.length > 0;
	const isOpen = forceExpanded || expandedPaths.has(node.fullPath);
	const childPills = hasChildren ? node.children.filter(isLeafTag) : [];
	const childRows = hasChildren ? node.children.filter((n) => !isLeafTag(n)) : [];

	const effectiveSelected = isEffectivelySelected(node, selectedTagIds);
	const someChildrenSelected =
		hasChildren &&
		node.subtreeTagIds.some((id) => selectedTagIds.has(id)) &&
		!node.subtreeTagIds.every((id) => selectedTagIds.has(id));

	const bg = node.inheritedColor;
	const fg = textColorFor(bg);

	const handleChevronClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		let intent: TagTreeExpansionIntent = { kind: "toggle", path: node.fullPath };
		if (e.altKey) {
			intent = { kind: "isolate", path: node.fullPath, parentPath: node.parentPath };
		} else if (e.ctrlKey || e.metaKey) {
			intent = { kind: "toggle-subtree", path: node.fullPath };
		}
		onToggleExpanded(intent);
	};

	return (
		<li className="tag-tree__node">
			<ContextMenu.Root>
				<ContextMenu.Trigger
					render={
						<div
							className={`tag-tree__row${effectiveSelected ? " is-selected" : ""}${someChildrenSelected ? " is-partial" : ""}${dragPaths?.has(node.fullPath) ? " is-dragging" : ""}${dropTarget?.path === node.fullPath ? ` is-drop-${dropTarget.position}` : ""}`}
							style={{
								backgroundColor: bg,
								color: fg,
								marginLeft: `${depth * 1.25}rem`,
								cursor: "pointer",
							}}
							onClick={(e) => onRowClick(node, e.shiftKey, e.altKey)}
							tabIndex={0}
							onMouseDown={(e) => drag.onMouseDown(e, node)}
							data-tree-path={node.fullPath}
							onMouseMove={(e) => drag.onMouseMove(e, node, e.currentTarget)}
							onKeyDown={(e) => drag.onKeyDown(e, node)}
						>
							{hasChildren ? (
								<IconButton
									className="tag-tree__chevron"
									icon={isOpen ? mdiChevronDown : mdiChevronRight}
									size={18}
									label={t("Toggle folder")}
									tooltip={false}
									onClick={handleChevronClick}
								/>
							) : (
								<span className="tag-tree__chevron-spacer" />
							)}
							<span className="tag-tree__label truncate">{node.segment}</span>
							{!node.tag && (
								<Icon
									path={mdiFolder}
									size={13}
									style={{ color: fg, opacity: 0.5, flexShrink: 0 }}
								/>
							)}
							{node.count !== null && (
								<small className="tag-tree__count mono">{fmt.format(node.count)}</small>
							)}
							<IconButton
								className="icon-button--inline"
								icon={mdiPencil}
								size={14}
								label={node.tag ? t("Edit tag") : t('Edit folder "{name}"', { name: node.segment })}
								tooltip={false}
								reveal
								onClick={(e) => {
									e.stopPropagation();
									if (node.tag) onEditTag(node);
									else onEditVirtual(node.fullPath);
								}}
							/>
						</div>
					}
				/>
				<TagContextMenu
					node={node}
					onAddAlias={
						node.tag ? () => onAddAlias({ id: node.tag!.id, name: node.tag!.name }) : undefined
					}
					onNewSubfolder={() => onNewFolder(node.fullPath)}
					onDeleteFolder={
						node.subtreeTagIds.length === 0 ? () => onDeleteFolder(node.fullPath) : undefined
					}
				/>
			</ContextMenu.Root>
			{hasChildren && isOpen && (
				<>
					<TagLeafGroup
						nodes={childPills}
						depth={depth + 1}
						selectedTagIds={selectedTagIds}
						dragPaths={dragPaths}
						dropTarget={dropTarget}
					/>
					{childRows.length > 0 && (
						<ul className="tag-tree__children">
							{childRows.map((child) => (
								<TagTreeNodeRow
									key={child.fullPath}
									node={child}
									depth={depth + 1}
									selectedTagIds={selectedTagIds}
									forceExpanded={forceExpanded}
									expandedPaths={expandedPaths}
									dragPaths={dragPaths}
									dropTarget={dropTarget}
								/>
							))}
						</ul>
					)}
				</>
			)}
		</li>
	);
});

/** A group of terminal tags rendered as flat pills, indented to sit under their parent
 *  folder row (depth 0 for root leaves and the whole flat view). */
const TagLeafGroup = memo(function TagLeafGroup({
	nodes,
	depth,
	selectedTagIds,
	dragPaths,
	dropTarget,
}: {
	nodes: TagTreeNode[];
	depth: number;
	selectedTagIds: ReadonlySet<number>;
	dragPaths: ReadonlySet<string> | null;
	dropTarget: DropTarget | null;
}) {
	if (nodes.length === 0) return null;
	return (
		<ul
			className="tag-list tag-tree__leaves"
			style={depth > 0 ? { marginLeft: `${depth * 1.25}rem` } : undefined}
		>
			{nodes.map((node) => (
				<TagTreeLeaf
					key={node.fullPath}
					node={node}
					count={node.count ?? 0}
					isSelected={selectedTagIds.has(node.tag!.id)}
					isDragging={dragPaths?.has(node.fullPath) ?? false}
					dropSide={dropTarget?.path === node.fullPath ? dropTarget.position : null}
				/>
			))}
		</ul>
	);
});

const TagTreeLeaf = memo(function TagTreeLeaf({
	node,
	count,
	isSelected,
	isDragging,
	dropSide,
}: {
	node: TagTreeNode;
	count: number;
	isSelected: boolean;
	isDragging: boolean;
	dropSide: DropTarget["position"] | null;
}) {
	const { onEditTag, onAddAlias, onRemoveAlias, onRowClick, drag } = useContext(TagTreeCtx);
	const tag = node.tag!;

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					<TagPill
						as="li"
						color={tag.color}
						label={node.segment}
						count={count}
						className={clsx(
							isSelected && "is-selected",
							node.isAlias && "is-alias",
							isDragging && "is-dragging",
							dropSide && `is-drop-${dropSide}`,
						)}
						style={{ cursor: "pointer" }}
						data-tag-id={tag.id}
						data-tree-path={node.fullPath}
						onClick={(e: React.MouseEvent) => onRowClick(node, e.shiftKey, e.altKey)}
						tabIndex={0}
						onMouseDown={(e: React.MouseEvent) => drag.onMouseDown(e, node)}
						onMouseMove={(e: React.MouseEvent<HTMLElement>) =>
							drag.onMouseMove(e, node, e.currentTarget, true)
						}
						onKeyDown={(e: React.KeyboardEvent) => drag.onKeyDown(e, node)}
						button={
							<TagPillButton
								variant="edit"
								onClick={(e) => {
									e.stopPropagation();
									onEditTag(node);
								}}
							/>
						}
					/>
				}
			/>
			<TagContextMenu
				node={node}
				onAddAlias={node.isAlias ? undefined : () => onAddAlias({ id: tag.id, name: tag.name })}
				onRemoveAlias={node.isAlias ? () => onRemoveAlias(node.fullPath) : undefined}
			/>
		</ContextMenu.Root>
	);
});
