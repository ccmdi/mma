import { useState, useMemo, useEffect, useRef, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { cmd } from "@/lib/commands";
import { HslColorPicker } from "react-colorful";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
	useCurrentMap,
	useSelectedTagIds,
	useTagCounts,
	toggleTagSelections,
	updateTags,
	deleteTags,
	reorderTags,
	removeTagFromAllLocations,
	getSelectedLocationIds,
	getVisibleTags,
    removeTagFromLocations,
} from "@/store/useMapStore";
import type { TagSortMode } from "@/types";
import type { Tag } from "@/bindings.gen";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { mdiPencil } from "@mdi/js";
import { ToolBlock } from "@/components/primitives/ToolBlock";
import { fmt } from "@/lib/util/format";
import { textColorFor, hexToHsl, hslToHex } from "@/lib/util/color";
import { useSetting, setSetting } from "@/store/settings";
import { sortTagsByMode } from "@/lib/util/util";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { useMapSetting } from "@/components/editor/map/useMapSetting";
import { HotkeyInput } from "@/components/primitives/HotkeyInput";
import { getConflicts } from "@/lib/util/hotkeys";
import { getTagBindingKey, withTagKeyBinding } from "@/lib/map/mapKeyBindings";
import { TagTreeView } from "./TagTree";

export function TagManager() {
	const map = useCurrentMap();
	const selectedTagIds = useSelectedTagIds();
	const tagCounts = useTagCounts();
	const tagViewMode = useSetting("tagViewMode");
	const [filterText, setFilterText] = useState("");
	const sortMode = useSetting("tagSortMode");
	const [editingTagId, setEditingTagId] = useState<number | null>(null);
	const [renamingTag, setRenamingTag] = useState<{ id: number; name: string } | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [dragTagId, setDragTagId] = useState<number | null>(null);
	// Insertion index into the sorted list with the dragged tag removed.
	const [dropIdx, setDropIdx] = useState<number | null>(null);
	// Holds the dropped order until the store mutation lands, so the list
	// doesn't flash back to the old order for a frame after mouseup.
	const [pendingOrder, setPendingOrder] = useState<Tag[] | null>(null);

	// New array identity only when the map object changes (mutations), NOT on selection
	// toggles -- keeps sortedTags stable so memoized rows can skip re-rendering.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const tags = useMemo(() => getVisibleTags(), [map]);
	const lastShiftClickRef = useRef<number | null>(null);

	const sortedTags = useMemo(() => {
		let filtered = tags;
		if (filterText) {
			const lower = filterText.toLowerCase();
			filtered = tags.filter((t) => t.name.toLowerCase().includes(lower));
		}
		return sortTagsByMode(filtered, sortMode, tagCounts);
	}, [tags, filterText, sortMode, tagCounts]);

	// Live preview: render the list as it would look after the drop, with the
	// dragged tag occupying (invisibly) its prospective slot.
	const displayTags = useMemo(() => {
		if (pendingOrder) return pendingOrder;
		if (dragTagId == null || dropIdx == null) return sortedTags;
		const dragTag = sortedTags.find((t) => t.id === dragTagId);
		if (!dragTag) return sortedTags;
		const without = sortedTags.filter((t) => t.id !== dragTagId);
		without.splice(dropIdx, 0, dragTag);
		return without;
	}, [sortedTags, dragTagId, dropIdx, pendingOrder]);

	const dragTag = dragTagId != null ? (sortedTags.find((t) => t.id === dragTagId) ?? null) : null;

	// Refs mirror volatile state so the row handlers below can stay identity-stable
	// (memoized TagRows only re-render when their own props change).
	const sortedTagsRef = useRef(sortedTags);
	sortedTagsRef.current = sortedTags;
	const sortModeRef = useRef(sortMode);
	sortModeRef.current = sortMode;
	const filterTextRef = useRef(filterText);
	filterTextRef.current = filterText;
	const dragTagIdRef = useRef<number | null>(null);
	const dropIdxRef = useRef<number | null>(null);
	const suppressClickRef = useRef(false);
	const previewRef = useRef<HTMLUListElement>(null);
	const dragPosRef = useRef({ x: 0, y: 0 });

	const setDrag = useCallback((v: number | null) => {
		dragTagIdRef.current = v;
		setDragTagId(v);
	}, []);
	const setDrop = useCallback((v: number | null) => {
		dropIdxRef.current = v;
		setDropIdx(v);
	}, []);

	const handleTagClick = useCallback((e: React.MouseEvent, tagId: number) => {
		if (dragTagIdRef.current != null || suppressClickRef.current) {
			suppressClickRef.current = false;
			return;
		}
		const sorted = sortedTagsRef.current;
		if (e.shiftKey && lastShiftClickRef.current != null) {
			const anchorIdx = sorted.findIndex((t) => t.id === lastShiftClickRef.current);
			const targetIdx = sorted.findIndex((t) => t.id === tagId);
			if (anchorIdx !== -1 && targetIdx !== -1) {
				const lo = Math.min(anchorIdx, targetIdx);
				const hi = Math.max(anchorIdx, targetIdx);
				const ids: number[] = [];
				for (let i = lo; i <= hi; i++) {
					if (i === anchorIdx) continue;
					ids.push(sorted[i].id);
				}
				toggleTagSelections(ids);
			}
		} else {
			toggleTagSelections([tagId]);
		}
		lastShiftClickRef.current = tagId;
	}, []);

	const handleTagMouseDown = useCallback(
		(e: React.MouseEvent, tagId: number) => {
			if (e.button !== 0 || sortModeRef.current !== "default" || filterTextRef.current) return;
			if ((e.target as HTMLElement).closest("button")) return;
			e.preventDefault();
			suppressClickRef.current = false;
			const startX = e.clientX;
			const startY = e.clientY;
			let started = false;

			const onMove = (me: MouseEvent) => {
				if (!started && (Math.abs(me.clientX - startX) > 4 || Math.abs(me.clientY - startY) > 4)) {
					started = true;
					document.body.style.userSelect = "none";
					setDrag(tagId);
					setDrop(sortedTagsRef.current.findIndex((t) => t.id === tagId));
				}
				if (started) {
					dragPosRef.current = { x: me.clientX, y: me.clientY };
					const el = previewRef.current;
					if (el) {
						el.style.left = `${me.clientX + 12}px`;
						el.style.top = `${me.clientY + 12}px`;
					}
				}
			};
			const onUp = () => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				if (!started) return;
				document.body.style.userSelect = "";
				suppressClickRef.current = true;
				const dragId = dragTagIdRef.current;
				const idx = dropIdxRef.current;
				if (dragId != null && idx != null) {
					const sorted = sortedTagsRef.current;
					const fromIdx = sorted.findIndex((t) => t.id === dragId);
					if (fromIdx !== -1 && idx !== fromIdx) {
						const ordered = sorted.filter((t) => t.id !== dragId);
						ordered.splice(idx, 0, sorted[fromIdx]);
						setPendingOrder(ordered);
						reorderTags(ordered.map((t) => t.id)).finally(() => setPendingOrder(null));
					}
				}
				setDrop(null);
				setDrag(null);
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		},
		[setDrag, setDrop],
	);

	const handleTagMouseMove = useCallback(
		(e: React.MouseEvent, tagId: number, el: HTMLElement) => {
			const dragId = dragTagIdRef.current;
			if (dragId == null || dragId === tagId) return;
			const rect = el.getBoundingClientRect();
			const after = (e.clientX - rect.left) / rect.width >= 0.5;
			// Index of the hovered tag within the list-without-dragged-tag.
			let idx = 0;
			for (const t of sortedTagsRef.current) {
				if (t.id === tagId) break;
				if (t.id !== dragId) idx++;
			}
			if (after) idx++;
			if (dropIdxRef.current !== idx) setDrop(idx);
		},
		[setDrop],
	);

	if (!map) return null;

	const editingTag = editingTagId ? map.meta.tags[editingTagId] : null;

	return (
		<>
			<ToolBlock
				className="tag-manager"
				title="Tags"
				isCollapsed={collapsed}
				onCollapse={setCollapsed}
				collapsedAddons={
					<ul className="tag-list is-collapsed">
						{sortedTags.slice(0, 20).map((tag) => (
							<li
								key={tag.id}
								className="tag"
								style={{ backgroundColor: tag.color, color: textColorFor(tag.color) }}
							>
								{tag.name} ({fmt.format(tagCounts[tag.id] ?? 0)})
							</li>
						))}
					</ul>
				}
				addons={
					<>
						<input
							className="input"
							placeholder="Filter tags..."
							value={filterText}
							onChange={(e) => setFilterText(e.target.value)}
						/>
						<span className="tag-manager__spacer"></span>
						<span className="tag-manager__sort button-group">
							Sort by{" "}
							{(["default", "name", "amount"] as TagSortMode[]).map((mode) => (
								<button
									key={mode}
									className="button button-group__button"
									aria-checked={sortMode === mode}
									onClick={() => setSetting("tagSortMode", mode)}
								>
									{mode}
								</button>
							))}
						</span>
					</>
				}
			>
				{tagViewMode === "tree" ? (
					<TagTreeView
						tags={tags}
						selectedTagIds={selectedTagIds}
						tagCounts={tagCounts}
						sortMode={sortMode}
						onEditTag={setEditingTagId}
						onRenameTag={setRenamingTag}
						filterText={filterText}
					/>
				) : (
					displayTags.length > 0 && (
						<ul className="tag-list">
							{displayTags.map((tag) => (
								<TagRow
									key={tag.id}
									tag={tag}
									count={tagCounts[tag.id] ?? 0}
									isSelected={selectedTagIds.has(tag.id)}
									isDragging={dragTagId === tag.id}
									sortMode={sortMode}
									onClick={handleTagClick}
									onMouseDown={handleTagMouseDown}
									onMouseMove={handleTagMouseMove}
									onEdit={setEditingTagId}
									onRename={setRenamingTag}
								/>
							))}
						</ul>
					)
				)}
			</ToolBlock>

			{dragTag &&
				createPortal(
					<ul
						className="tag-list tag-drag-preview"
						ref={previewRef}
						style={{ left: dragPosRef.current.x + 12, top: dragPosRef.current.y + 12 }}
					>
						<li
							className="tag has-button"
							style={{ backgroundColor: dragTag.color, color: textColorFor(dragTag.color) }}
						>
							<button className="button tag__button tag__button--edit" type="button" tabIndex={-1}>
								<Icon path={mdiPencil} />
							</button>
							<label className="tag__text">
								{dragTag.name}
								<small
									style={{ marginLeft: ".375rem", fontWeight: 600, verticalAlign: "middle" }}
								>
									{fmt.format(tagCounts[dragTag.id] ?? 0)}
								</small>
							</label>
						</li>
					</ul>,
					document.body,
				)}

			{editingTag && <EditTagDialog tag={editingTag} onClose={() => setEditingTagId(null)} />}

			{renamingTag && (
				<RenameInSelectionDialog tag={renamingTag} onClose={() => setRenamingTag(null)} />
			)}
		</>
	);
}

/** One tag row. Memoized so toggling a selection re-renders only the affected row --
 *  with thousands of tags, re-rendering every Radix ContextMenu wrapper per click is
 *  the difference between instant and a visible stall. All callbacks must be
 *  identity-stable (see the refs in TagManager). */
const TagRow = memo(function TagRow({
	tag,
	count,
	isSelected,
	isDragging,
	sortMode,
	onClick,
	onMouseDown,
	onMouseMove,
	onEdit,
	onRename,
}: {
	tag: Tag;
	count: number;
	isSelected: boolean;
	isDragging: boolean;
	sortMode: TagSortMode;
	onClick: (e: React.MouseEvent, tagId: number) => void;
	onMouseDown: (e: React.MouseEvent, tagId: number) => void;
	onMouseMove: (e: React.MouseEvent, tagId: number, el: HTMLElement) => void;
	onEdit: (tagId: number) => void;
	onRename: (tag: { id: number; name: string }) => void;
}) {
	const bg = tag.color;
	const fg = textColorFor(bg);
	return (
		<ContextMenu.Root modal={false}>
			<ContextMenu.Trigger asChild>
				<li
					className={`tag has-button${isSelected ? " is-selected" : ""}${isDragging ? " is-dragging" : ""}`}
					style={{
						backgroundColor: bg,
						color: fg,
						cursor: sortMode === "default" ? "grab" : "pointer",
					}}
					data-tag-id={tag.id}
					onClick={(e) => onClick(e, tag.id)}
					onMouseDown={(e) => onMouseDown(e, tag.id)}
					onMouseMove={(e) => onMouseMove(e, tag.id, e.currentTarget)}
				>
					<button
						className="button tag__button tag__button--edit"
						onClick={(e) => {
							e.stopPropagation();
							onEdit(tag.id);
						}}
						type="button"
					>
						<Icon path={mdiPencil} />
					</button>
					<label className="tag__text">
						{tag.name}
						<small
							style={{
								marginLeft: ".375rem",
								fontWeight: 600,
								verticalAlign: "middle",
							}}
						>
							{fmt.format(count)}
						</small>
					</label>
				</li>
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<TagContextMenuContent
					tagId={tag.id}
					totalCount={count}
					onRename={() => onRename({ id: tag.id, name: tag.name })}
				/>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
});

export function TagContextMenuContent({
	tagId,
	totalCount,
	onRename,
}: {
	tagId: number;
	totalCount: number;
	onRename: () => void;
}) {
	const [selCount, setSelCount] = useState<number | null>(null);

	useEffect(() => {
		const selIds = getSelectedLocationIds();
		if (selIds.size === 0) {
			setSelCount(0);
			return;
		}
		cmd.storeResolveSelection({ type: "Tag", tagId }).then(
			(tagLocIds) => {
				let count = 0;
				for (const id of tagLocIds) if (selIds.has(id)) count++;
				setSelCount(count);
			},
		);
	}, [tagId]);

	const inSel = selCount ?? 0;

	return (
		<ContextMenu.Content className="context-menu">
			<ContextMenu.Item className="context-menu__item" onSelect={() => removeTagFromAllLocations(tagId)}>
				Remove from all ({fmt.format(totalCount)} locations)
			</ContextMenu.Item>
			<ContextMenu.Item
				className="context-menu__item"
				disabled={inSel === 0}
				onSelect={() => removeTagFromLocations(tagId, [...getSelectedLocationIds()])}
			>
				Remove from selection ({fmt.format(inSel)} locations)
			</ContextMenu.Item>
			<ContextMenu.Item className="context-menu__item" disabled={inSel === 0} onSelect={onRename}>
				Rename in selection ({fmt.format(inSel)} locations)
			</ContextMenu.Item>
		</ContextMenu.Content>
	);
}

function RenameInSelectionDialog({
	tag,
	onClose,
}: {
	tag: { id: number; name: string };
	onClose: () => void;
}) {
	const [name, setName] = useState(tag.name);

	const handleSubmit = () => {
		const trimmed = name.trim();
		if (trimmed && trimmed !== tag.name) updateTags([{ id: tag.id, patch: { name: trimmed } }]);
		onClose();
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title="Rename tag in selection">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleSubmit();
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
				>
					<input
						className="input"
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						autoFocus
					/>
					<div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
						<button className="button" type="button" onClick={onClose}>
							Cancel
						</button>
						<button className="button button--primary" type="submit">
							Rename
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function EditTagDialog({
	tag,
	onClose,
}: {
	tag: { id: number; name: string; color: string };
	onClose: () => void;
}) {
	const [name, setName] = useState(tag.name);
	const [hsl, setHsl] = useState(() => hexToHsl(tag.color));
	const hexValue = hslToHex(hsl.h, hsl.s, hsl.l);
	const [bindings, setBindings] = useMapSetting("keyBindings");
	const [hotkey, setHotkey] = useState(() => getTagBindingKey(bindings ?? [], tag.id) ?? "");

	// Informational only: per-map bindings preempt these while this map is open,
	// and assigning steals the key from whichever tag held it.
	const globalConflicts = hotkey ? getConflicts("", hotkey) : [];
	const holder = hotkey
		? (bindings ?? []).find(
				(b) =>
					b.key === hotkey && !(b.action.type === "applyTag" && b.action.tagId === tag.id),
			)
		: undefined;
	const holderAction = holder?.action;
	const holderTag =
		holderAction?.type === "applyTag"
			? getVisibleTags().find((t) => t.id === holderAction.tagId)
			: undefined;

	const handleSave = () => {
		updateTags([{ id: tag.id, patch: { name: name.trim() || tag.name, color: hexValue } }]);
		const cur = bindings ?? [];
		if ((getTagBindingKey(cur, tag.id) ?? "") !== hotkey) {
			setBindings(withTagKeyBinding(cur, tag.id, hotkey));
		}
		onClose();
	};

	const handleDelete = () => {
		deleteTags([tag.id]);
		onClose();
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title="Edit tag">
				<form
					className="edit-tag-modal"
					onSubmit={(e) => {
						e.preventDefault();
						handleSave();
					}}
				>
					<div className="edit-tag-modal__name">
						Rename:{" "}
						<input
							className="input"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
						/>
					</div>
					<div className="edit-tag-modal__color">
						<span>Color:</span>
						<input
							className="input hex-color"
							type="text"
							value={hexValue}
							onChange={(e) => {
								const v = e.target.value;
								if (/^#[0-9a-fA-F]{6}$/.test(v)) {
									setHsl(hexToHsl(v));
								}
							}}
						/>
						<HslColorPicker
							className="edit-tag-modal__color-picker"
							style={{ width: "100%" }}
							color={hsl}
							onChange={setHsl}
						/>
					</div>
					<div className="edit-tag-modal__hotkey">
						<span>Hotkey:</span>
						<HotkeyInput value={hotkey} onChange={setHotkey} />
						<button
							type="button"
							className="button"
							disabled={!hotkey}
							onClick={() => setHotkey("")}
						>
							Clear
						</button>
						{(holderTag || globalConflicts.length > 0) && (
							<p className="edit-tag-modal__hotkey-note">
								{holderTag && <>Takes the key from "{holderTag.name}". </>}
								{globalConflicts.length > 0 && (
									<>Overrides "{globalConflicts[0].label}" while this map is open.</>
								)}
							</p>
						)}
					</div>
					<div className="edit-tag-modal__actions">
						<button
							className="button button--destructive"
							type="button"
							onClick={handleDelete}
							data-qa="tag-delete"
						>
							Delete
						</button>
						<button className="button button--primary" type="submit" data-qa="tag-save">
							Save
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
