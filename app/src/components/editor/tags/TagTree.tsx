import {
	memo,
	useState,
	useMemo,
	useCallback,
	useLayoutEffect,
	useRef,
	useImperativeHandle,
	createContext,
	useContext,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { Icon } from "@/components/primitives/Icon";
import { mdiChevronDown, mdiChevronRight, mdiPencil, mdiFolder } from "@mdi/js";
import { textColorFor, rgbToHex } from "@/lib/util/color";
import { fmt } from "@/lib/util/format";
import { toggleInSet } from "@/lib/util/util";
import { toggleTagSelections } from "@/store/useMapStore";
import { useStableHandler } from "@/lib/hooks/useStableHandler";
import { useSetting } from "@/store/settings";
import { TagContextMenuContent } from "./TagManager";
import {
	rangeToggleTagIds,
	reorderSiblingsFlatOrder,
	stepSiblingFlatOrder,
	collectDragBlock,
	canDropInto,
	moveIntoFolder,
	buildTagTree,
	sumCounts,
	isLeafTag,
	loadExpanded,
	saveExpanded,
	type TagTreeNode,
	type TagMoveResult,
} from "./tagTreeRange";
import type { TagSortMode } from "@/types";
import type { Tag, VirtualTag } from "@/bindings.gen";
import { t } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";

type DropTarget = { path: string; position: "before" | "after" | "into" };

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
	onRenameTag: (tag: { id: number; name: string }) => void;
	onAddAlias: (tag: { id: number; name: string }) => void;
	onRemoveAlias: (aliasPath: string) => void;
	onNewFolder: (parentPath: string) => void;
	onDeleteFolder: (path: string) => void;
	onRowClick: (node: TagTreeNode, shiftKey: boolean, altKey: boolean) => void;
	onToggleExpanded: (path: string) => void;
	drag: TreeDragHandlers;
}

const TagTreeCtx = createContext<TagTreeCallbacks>(null!);

export interface TagTreeHandle {
	/** Rewrite expanded-folder paths after a cascade rename so the renamed folder stays open. */
	remapExpanded: (oldPrefix: string, newPrefix: string) => void;
}

interface TagTreeViewProps {
	tags: Tag[];
	/** false = flat view: every tag name is a single leaf pill, no folders. */
	split: boolean;
	selectedTagIds: ReadonlySet<number>;
	tagCounts: Record<number, number>;
	sortMode: TagSortMode;
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
	onEditTag: (node: TagTreeNode) => void;
	onEditVirtual: (fullPath: string) => void;
	onRenameTag: (tag: { id: number; name: string }) => void;
	onAddAlias: (tag: { id: number; name: string }) => void;
	onRemoveAlias: (aliasPath: string) => void;
	/** Commit a drag reorder (full DFS tag-id order). Must render the new order
	 *  optimistically -- the drop handler clears its drag state synchronously. */
	onReorder: (orderedIds: number[]) => void;
	/** Commit a drag-into-folder move (renames + settings rewrites + order rebase).
	 *  Same optimistic contract as onReorder. */
	onMoveInto: (move: TagMoveResult) => void;
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
	tagCounts,
	sortMode,
	virtualTags,
	aliases,
	onEditTag,
	onEditVirtual,
	onRenameTag,
	onAddAlias,
	onRemoveAlias,
	onReorder,
	onMoveInto,
	onNewFolder,
	onDeleteFolder,
	filterText,
	ref,
}: TagTreeViewProps & { ref?: React.Ref<TagTreeHandle> }) {
	const folderColorMode = useSetting("tagFolderColorMode");
	const folderColorRgb = useSetting("tagFolderColor");
	const tree = useMemo(
		() =>
			buildTagTree(tags, sortMode, tagCounts, virtualTags, aliases, split, {
				mode: folderColorMode,
				color: rgbToHex(folderColorRgb),
			}),
		[tags, sortMode, tagCounts, virtualTags, aliases, split, folderColorMode, folderColorRgb],
	);
	const [expandedPaths, setExpandedPaths] = useState(loadExpanded);

	const toggleExpanded = useCallback((path: string) => {
		setExpandedPaths((prev) => {
			const next = toggleInSet(prev, path);
			saveExpanded(next);
			return next;
		});
	}, []);

	useImperativeHandle(
		ref,
		() => ({
			remapExpanded(oldPrefix, newPrefix) {
				if (oldPrefix === newPrefix) return;
				setExpandedPaths((prev) => {
					const next = new Set<string>();
					for (const p of prev) {
						if (p === oldPrefix) next.add(newPrefix);
						else if (p.startsWith(`${oldPrefix}/`)) next.add(newPrefix + p.slice(oldPrefix.length));
						else next.add(p);
					}
					saveExpanded(next);
					return next;
				});
			},
		}),
		[],
	);

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

	// --- In-level drag reorder (only in "default" sort, not while filtering) ---
	// Plain drag moves the grabbed node; ctrl+drag also carries its selected siblings.
	const [dragPaths, setDragPaths] = useState<ReadonlySet<string> | null>(null);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	const dragEnabled = sortMode === "default" && !filterText;
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

	const handleDragMouseDown = useStableHandler((e: React.MouseEvent, node: TagTreeNode) => {
		draggedRef.current = false; // fresh interaction; a drag that ends off-row won't fire a click to clear it
		if (!dragEnabled || e.button !== 0 || node.isAlias) return; // alias leaves aren't reorderable
		if ((e.target as HTMLElement).closest("button")) return;
		e.preventDefault(); // don't start a text selection
		(e.currentTarget as HTMLElement).focus(); // ...which also suppresses the click's own focus
		const startX = e.clientX;
		const startY = e.clientY;
		// Grab offset within the pill, so the pickup point stays under the cursor (not the top-left corner).
		const rect = e.currentTarget.getBoundingClientRect();
		const grabX = e.clientX - rect.left;
		const grabY = e.clientY - rect.top;
		let started = false;
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
		const ac = new AbortController();
		const onMove = (me: MouseEvent) => {
			if (!started && (Math.abs(me.clientX - startX) > 4 || Math.abs(me.clientY - startY) > 4)) {
				started = true;
				draggedRef.current = true;
				dragNodeRef.current = node;
				document.body.style.userSelect = "none";
				document.body.classList.add("mm-tag-dragging");
				dragPosRef.current = { x: me.clientX - grabX, y: me.clientY - grabY };
				if (isLeafTag(node)) {
					setDragLeaf({
						color: node.tag!.color,
						label: node.segment,
						count: tagCounts[node.tag!.id] ?? 0,
						extra: 0,
					});
				}
			}
			if (started) {
				syncBlock(me);
				dragPosRef.current = { x: me.clientX - grabX, y: me.clientY - grabY };
				const el = previewRef.current;
				if (el) {
					el.style.left = `${dragPosRef.current.x - 4}px`;
					el.style.top = `${dragPosRef.current.y - 4}px`;
				}
			}
		};
		const onUp = () => {
			ac.abort();
			document.body.style.userSelect = "";
			document.body.classList.remove("mm-tag-dragging");
			const dropT = dropTargetRef.current;
			const clear = () => {
				dragNodeRef.current = null;
				dragBlockRef.current = null;
				dropTargetRef.current = null;
				setDragPaths(null);
				setDropTarget(null);
				setDragLeaf(null);
			};
			// onReorder/onMoveInto render optimistically, so clearing in the same
			// batch settles the drop instantly with no flash back to the old slot.
			if (started && dropT) {
				if (dropT.position === "into") {
					const move = moveIntoFolder(
						treeRef.current,
						[...block],
						dropT.path,
						tags,
						virtualTags,
						aliases,
					);
					if (move) onMoveInto(move);
				} else {
					const order = reorderSiblingsFlatOrder(
						treeRef.current,
						[...block],
						dropT.path,
						dropT.position,
						node.parentPath,
					);
					if (order) onReorder(order);
				}
			}
			clear();
		};
		window.addEventListener("mousemove", onMove, { signal: ac.signal });
		window.addEventListener("mouseup", onUp, { signal: ac.signal });
	});

	const handleDragMouseMove = useStableHandler(
		(e: React.MouseEvent, node: TagTreeNode, el: HTMLElement, horizontal = false) => {
			const src = dragNodeRef.current;
			if (!src || node.isAlias) return; // don't drop onto an alias
			const block = dragBlockRef.current;
			if (block?.has(node.fullPath)) return; // block members travel with the drag
			// In-level, same-kind (pills among pills, rows among rows): live reorder.
			// Empty folders sit outside the persisted tag order, so they neither reorder
			// nor serve as before/after targets — for them only "into" applies.
			if (
				src.parentPath === node.parentPath &&
				isLeafTag(src) === isLeafTag(node) &&
				src.descendantTagIds.length > 0 &&
				node.descendantTagIds.length > 0
			) {
				const rect = el.getBoundingClientRect();
				const position = horizontal
					? e.clientX - rect.left < rect.width / 2
						? "before"
						: "after"
					: e.clientY - rect.top < rect.height / 2
						? "before"
						: "after";
				if (
					dropTargetRef.current?.path !== node.fullPath ||
					dropTargetRef.current.position !== position
				) {
					applyDropTarget({ path: node.fullPath, position });
				}
				return;
			}
			// Anything else over a folder row is an "into" move target (drag into folder).
			if (isLeafTag(node) || !block) return;
			if (!canDropInto(treeRef.current, [...block], node.fullPath)) {
				// An invalid folder (the origin parent, own subtree, collision) disarms a
				// pending into-move, so drifting back home and releasing is a clean no-op.
				if (dropTargetRef.current?.position === "into") applyDropTarget(null);
				return;
			}
			if (
				dropTargetRef.current?.path !== node.fullPath ||
				dropTargetRef.current.position !== "into"
			) {
				applyDropTarget({ path: node.fullPath, position: "into" });
			}
		},
	);

	// Alt+Arrow is the keyboard route through the same reorder the drag commits.
	const handleDragKeyDown = useStableHandler((e: React.KeyboardEvent, node: TagTreeNode) => {
		if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
		if (!dragEnabled || node.isAlias) return;
		const order = stepSiblingFlatOrder(
			treeRef.current,
			node.fullPath,
			node.parentPath,
			e.key === "ArrowUp" ? -1 : 1,
		);
		if (!order) return;
		e.preventDefault();
		e.stopPropagation();
		onReorder(order);
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

			if (shiftKey && anchorIdx != null && targetIdx != null && anchorIdx !== targetIdx) {
				const ids = rangeToggleTagIds(visibleRows, anchorIdx, targetIdx);
				if (ids.length > 0) toggleTagSelections(ids);
			} else if (altKey && node.tag) {
				// Solo: toggle only this node's own tag, ignoring descendants.
				toggleTagSelections([node.tag.id]);
			} else {
				// Single-node select/deselect of all its descendant tags.
				const allChildrenSelected =
					node.children.length > 0 && node.descendantTagIds.every((id) => selectedTagIds.has(id));
				const isSelected = node.tag ? selectedTagIds.has(node.tag.id) : false;
				const effectiveSelected = isSelected || allChildrenSelected;
				const ids = node.descendantTagIds.filter((id) =>
					effectiveSelected ? selectedTagIds.has(id) : !selectedTagIds.has(id),
				);
				if (ids.length > 0) toggleTagSelections(ids);
			}
			anchorPathRef.current = node.fullPath;
		},
	);

	const treeCallbacks = useMemo<TagTreeCallbacks>(
		() => ({
			onEditTag,
			onEditVirtual,
			onRenameTag,
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
			onRenameTag,
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
	const displayRootRows = spliceDisplayOrder(rootRows, dragPaths, dropTarget);
	const rootRowsRef = useRef<HTMLUListElement>(null);
	useSwapAnimation(rootRowsRef, displayRootRows, dragPaths);

	return (
		<TagTreeCtx.Provider value={treeCallbacks}>
			<TagLeafGroup
				nodes={rootPills}
				depth={0}
				selectedTagIds={selectedTagIds}
				tagCounts={tagCounts}
				dragPaths={dragPaths}
				dropTarget={dropTarget}
			/>
			{rootRows.length > 0 && (
				<ul className="tag-tree" ref={rootRowsRef}>
					{displayRootRows.map((node) => (
						<TagTreeNodeRow
							key={node.fullPath}
							node={node}
							depth={0}
							selectedTagIds={selectedTagIds}
							tagCounts={tagCounts}
							forceExpanded={forceExpanded}
							expandedPaths={expandedPaths}
							dragPaths={dragPaths}
							dropTarget={dropTarget}
						/>
					))}
				</ul>
			)}
			{dragPaths && dragNodeRef.current && dragNodeRef.current.parentPath !== "" && (
				<div
					className={`tag-tree__root-drop${dropTarget?.position === "into" && dropTarget.path === "" ? " is-drop-into" : ""}`}
					onMouseMove={() => {
						const block = dragBlockRef.current;
						if (!block || !canDropInto(treeRef.current, [...block], "")) return;
						if (dropTargetRef.current?.path !== "" || dropTargetRef.current.position !== "into")
							applyDropTarget({ path: "", position: "into" });
					}}
				>
					{t("Move to top level")}
				</div>
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
								<span className="tag-drag-preview__count">+{dragLeaf.extra}</span>
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
	tagCounts,
	forceExpanded,
	expandedPaths,
	dragPaths,
	dropTarget,
}: {
	node: TagTreeNode;
	depth: number;
	selectedTagIds: ReadonlySet<number>;
	tagCounts: Record<number, number>;
	forceExpanded: boolean;
	expandedPaths: Set<string>;
	dragPaths: ReadonlySet<string> | null;
	dropTarget: DropTarget | null;
}) {
	const {
		onEditTag,
		onEditVirtual,
		onRenameTag,
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
	const displayChildRows = spliceDisplayOrder(childRows, dragPaths, dropTarget);
	const childRowsRef = useRef<HTMLUListElement>(null);
	useSwapAnimation(childRowsRef, displayChildRows, dragPaths);

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

	const handleChevronClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		onToggleExpanded(node.fullPath);
	};

	return (
		<li className="tag-tree__node">
			<ContextMenu.Root>
				<ContextMenu.Trigger
					render={
						<div
							className={`tag-tree__row${effectiveSelected ? " is-selected" : ""}${someChildrenSelected ? " is-partial" : ""}${dragPaths?.has(node.fullPath) ? " is-dragging" : ""}${dropTarget?.position === "into" && dropTarget.path === node.fullPath ? " is-drop-into" : ""}`}
							style={{
								backgroundColor: bg,
								color: fg,
								marginLeft: `${depth * 1.25}rem`,
								cursor: "pointer",
							}}
							onClick={(e) => onRowClick(node, e.shiftKey, e.altKey)}
							tabIndex={0}
							onMouseDown={(e) => drag.onMouseDown(e, node)}
							onMouseMove={(e) => drag.onMouseMove(e, node, e.currentTarget)}
							onKeyDown={(e) => drag.onKeyDown(e, node)}
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
							{!node.tag && (
								<Icon
									path={mdiFolder}
									size={13}
									style={{ color: fg, opacity: 0.5, flexShrink: 0 }}
								/>
							)}
							<small className="tag-tree__count mono">{fmt.format(count)}</small>
							<Button
								className="tag-tree__edit"
								onClick={(e) => {
									e.stopPropagation();
									if (node.tag) onEditTag(node);
									else onEditVirtual(node.fullPath);
								}}
								style={{ color: fg }}
							>
								<Icon path={mdiPencil} size={14} />
							</Button>
						</div>
					}
				/>
				{node.tag ? (
					<ContextMenu.Portal>
						<TagContextMenuContent
							tagId={node.tag!.id}
							totalCount={sumCounts(node, tagCounts)}
							onRename={() => onRenameTag({ id: node.tag!.id, name: node.tag!.name })}
							onAddAlias={() => onAddAlias({ id: node.tag!.id, name: node.tag!.name })}
							onNewSubfolder={() => onNewFolder(node.fullPath)}
						/>
					</ContextMenu.Portal>
				) : (
					<ContextMenu.Portal>
						<ContextMenu.Positioner className="menu-positioner">
							<ContextMenu.Popup className="context-menu">
								<ContextMenu.Item
									className="context-menu__item"
									onClick={() => onNewFolder(node.fullPath)}
								>
									{t("New subfolder...")}
								</ContextMenu.Item>
								{node.descendantTagIds.length === 0 && (
									<ContextMenu.Item
										className="context-menu__item"
										onClick={() => onDeleteFolder(node.fullPath)}
									>
										{t("Delete folder")}
									</ContextMenu.Item>
								)}
							</ContextMenu.Popup>
						</ContextMenu.Positioner>
					</ContextMenu.Portal>
				)}
			</ContextMenu.Root>
			{hasChildren && isOpen && (
				<>
					<TagLeafGroup
						nodes={childPills}
						depth={depth + 1}
						selectedTagIds={selectedTagIds}
						tagCounts={tagCounts}
						dragPaths={dragPaths}
						dropTarget={dropTarget}
					/>
					{childRows.length > 0 && (
						<ul className="tag-tree__children" ref={childRowsRef}>
							{displayChildRows.map((child) => (
								<TagTreeNodeRow
									key={child.fullPath}
									node={child}
									depth={depth + 1}
									selectedTagIds={selectedTagIds}
									tagCounts={tagCounts}
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

/** Live drag order: the dragged block is spliced to its prospective slot so the list
 *  visibly reorders while dragging (pills open a gap via the hidden `is-dragging` pills;
 *  folder rows move whole subtrees). Returns `nodes` unchanged when the drag/drop isn't
 *  within this sibling group. */
function spliceDisplayOrder(
	nodes: TagTreeNode[],
	dragPaths: ReadonlySet<string> | null,
	dropTarget: DropTarget | null,
): TagTreeNode[] {
	if (!dragPaths || !dropTarget || dropTarget.position === "into") return nodes;
	const block: TagTreeNode[] = [];
	const without: TagTreeNode[] = [];
	for (const n of nodes) (dragPaths.has(n.fullPath) ? block : without).push(n);
	if (block.length === 0) return nodes;
	let insertAt = without.findIndex((n) => n.fullPath === dropTarget.path);
	if (insertAt === -1) return nodes;
	if (dropTarget.position === "after") insertAt++;
	without.splice(insertAt, 0, ...block);
	return without;
}

/** FLIP: while a drag reorders a sibling list, nodes glide to their new slot instead of
 *  teleporting. Children are matched to `display` by index (the ul renders exactly that
 *  order). The dragged node glides too — visible folder rows move with the cursor; the
 *  dragged pill is hidden anyway. */
function useSwapAnimation(
	ulRef: React.RefObject<HTMLUListElement | null>,
	display: TagTreeNode[],
	dragPaths: ReadonlySet<string> | null,
) {
	const animate = useSetting("animateTagReorder");
	const prevRects = useRef(new Map<string, DOMRect>());
	useLayoutEffect(() => {
		const ul = ulRef.current;
		const rects = new Map<string, DOMRect>();
		if (ul && animate) {
			display.forEach((node, i) => {
				const el = ul.children[i] as HTMLElement | undefined;
				if (!el) return;
				el.getAnimations().forEach((a) => a.cancel());
				rects.set(node.fullPath, el.getBoundingClientRect());
			});
			if (dragPaths) {
				display.forEach((node, i) => {
					const prev = prevRects.current.get(node.fullPath);
					const next = rects.get(node.fullPath);
					if (!prev || !next) return;
					const dx = prev.left - next.left;
					const dy = prev.top - next.top;
					if (dx || dy) {
						(ul.children[i] as HTMLElement).animate(
							[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
							{ duration: 150, easing: "ease" },
						);
					}
				});
			}
		}
		prevRects.current = rects;
	});
}

/** A group of terminal tags rendered as flat pills, indented to sit under their parent
 *  folder row (depth 0 for root leaves and the whole flat view). */
const TagLeafGroup = memo(function TagLeafGroup({
	nodes,
	depth,
	selectedTagIds,
	tagCounts,
	dragPaths,
	dropTarget,
}: {
	nodes: TagTreeNode[];
	depth: number;
	selectedTagIds: ReadonlySet<number>;
	tagCounts: Record<number, number>;
	dragPaths: ReadonlySet<string> | null;
	dropTarget: DropTarget | null;
}) {
	const display = spliceDisplayOrder(nodes, dragPaths, dropTarget);
	const ulRef = useRef<HTMLUListElement>(null);
	useSwapAnimation(ulRef, display, dragPaths);
	if (nodes.length === 0) return null;
	return (
		<ul
			ref={ulRef}
			className="tag-list tag-tree__leaves"
			style={depth > 0 ? { marginLeft: `${depth * 1.25}rem` } : undefined}
		>
			{display.map((node) => (
				<TagTreeLeaf
					key={node.fullPath}
					node={node}
					count={tagCounts[node.tag!.id] ?? 0}
					isSelected={selectedTagIds.has(node.tag!.id)}
					isDragging={dragPaths?.has(node.fullPath) ?? false}
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
}: {
	node: TagTreeNode;
	count: number;
	isSelected: boolean;
	isDragging: boolean;
}) {
	const { onEditTag, onRenameTag, onAddAlias, onRemoveAlias, onRowClick, drag } =
		useContext(TagTreeCtx);
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
						)}
						style={{ cursor: "pointer" }}
						data-tag-id={tag.id}
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
			<ContextMenu.Portal>
				<TagContextMenuContent
					tagId={tag.id}
					totalCount={count}
					onRename={() => onRenameTag({ id: tag.id, name: tag.name })}
					onAddAlias={node.isAlias ? undefined : () => onAddAlias({ id: tag.id, name: tag.name })}
					onRemoveAlias={node.isAlias ? () => onRemoveAlias(node.fullPath) : undefined}
				/>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
});
