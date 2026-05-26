import { useState, useMemo, useEffect, useRef } from "react";
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
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { mdiPencil } from "@mdi/js";
import { ToolBlock } from "@/components/primitives/ToolBlock";
import { fmt } from "@/lib/util/format";
import { textColorFor, hexToHsl, hslToHex } from "@/lib/util/color";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { useSetting } from "@/store/settings.add";
import { TagTreeView } from "./TagTree.add";

export function TagManager() {
	const map = useCurrentMap();
	const selectedTagIds = useSelectedTagIds();
	const tagCounts = useTagCounts();
	const tagViewMode = useSetting("tagViewMode");
	const [filterText, setFilterText] = useState("");
	const [sortMode, setTagSortMode] = useLocalStorage<TagSortMode>("tagTagSortMode", "default");
	const [editingTagId, setEditingTagId] = useState<number | null>(null);
	const [renamingTag, setRenamingTag] = useState<{ id: number; name: string } | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [dragTagId, setDragTagId] = useState<number | null>(null);
	const [dropTarget, setDropTarget] = useState<{ id: number; position: "before" | "after" } | null>(
		null,
	);

	const tags = getVisibleTags();
	const lastShiftClickRef = useRef<number | null>(null);

	const sortedTags = useMemo(() => {
		let filtered = tags;
		if (filterText) {
			const lower = filterText.toLowerCase();
			filtered = tags.filter((t) => t.name.toLowerCase().includes(lower));
		}
		if (sortMode === "name") return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
		if (sortMode === "amount")
			return [...filtered].sort((a, b) => (tagCounts[b.id] ?? 0) - (tagCounts[a.id] ?? 0));
		return [...filtered].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}, [tags, filterText, sortMode, tagCounts]);

	if (!map) return null;

	const handleTagMouseDown = (e: React.MouseEvent, tagId: number) => {
		if (e.button !== 0 || sortMode !== "default") return;
		if ((e.target as HTMLElement).closest("button")) return;
		e.preventDefault();
		const startX = e.clientX;
		const startY = e.clientY;
		let started = false;

		const onMove = (me: MouseEvent) => {
			if (!started && (Math.abs(me.clientX - startX) > 4 || Math.abs(me.clientY - startY) > 4)) {
				started = true;
				setDragTagId(tagId);
			}
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			if (started) setDragTagId(null);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const handleTagMouseMove = (e: React.MouseEvent, tagId: number, el: HTMLElement) => {
		if (!dragTagId || dragTagId === tagId) return;
		const rect = el.getBoundingClientRect();
		const pos =
			(e.clientX - rect.left) / rect.width < 0.5 ? ("before" as const) : ("after" as const);
		setDropTarget({ id: tagId, position: pos });
	};

	const handleTagMouseUp = (tagId: number) => {
		if (!dragTagId || dragTagId === tagId || !dropTarget) return;
		const ids = sortedTags.map((t) => t.id);
		const fromIdx = ids.indexOf(dragTagId);
		if (fromIdx === -1) return;
		const without = ids.filter((_, i) => i !== fromIdx);
		let toIdx = without.indexOf(dropTarget.id);
		if (toIdx === -1) return;
		if (dropTarget.position === "after") toIdx++;
		without.splice(toIdx, 0, dragTagId);
		reorderTags(without);
		setDropTarget(null);
		setDragTagId(null);
	};

	const handleTagMouseLeave = () => {
		if (dragTagId) setDropTarget(null);
	};

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
									onClick={() => setTagSortMode(mode)}
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
						onEditTag={setEditingTagId}
						onRenameTag={setRenamingTag}
						filterText={filterText}
					/>
				) : (
					sortedTags.length > 0 && (
						<ul className="tag-list">
							{sortedTags.map((tag) => {
								const bg = tag.color;
								const fg = textColorFor(bg);
								const isSelected = selectedTagIds.has(tag.id);
								const isDragging = dragTagId === tag.id;
								const drop = dropTarget?.id === tag.id ? dropTarget.position : null;
								return (
									<ContextMenu.Root key={tag.id} modal={false}>
										<ContextMenu.Trigger asChild>
											<li
												className={`tag has-button${isSelected ? " is-selected" : ""}${isDragging ? " is-dragging" : ""}`}
												style={{
													backgroundColor: bg,
													color: fg,
													cursor: sortMode === "default" ? "grab" : "pointer",
												}}
												data-tag-id={tag.id}
												data-drop={dragTagId && !isDragging ? (drop ?? undefined) : undefined}
												onClick={(e) => {
													if (dragTagId) return;
													if (e.shiftKey && lastShiftClickRef.current != null) {
														const anchorIdx = sortedTags.findIndex((t) => t.id === lastShiftClickRef.current);
														const targetIdx = sortedTags.findIndex((t) => t.id === tag.id);
														if (anchorIdx !== -1 && targetIdx !== -1) {
															const lo = Math.min(anchorIdx, targetIdx);
															const hi = Math.max(anchorIdx, targetIdx);
															const ids: number[] = [];
															for (let i = lo; i <= hi; i++) {
																if (i === anchorIdx) continue;
																ids.push(sortedTags[i].id);
															}
															toggleTagSelections(ids);
														}
													} else {
														toggleTagSelections([tag.id]);
													}
													lastShiftClickRef.current = tag.id;
												}}
												onMouseDown={(e) => handleTagMouseDown(e, tag.id)}
												onMouseMove={(e) => handleTagMouseMove(e, tag.id, e.currentTarget)}
												onMouseUp={() => handleTagMouseUp(tag.id)}
												onMouseLeave={handleTagMouseLeave}
											>
												<button
													className="button tag__button tag__button--edit"
													onClick={(e) => {
														e.stopPropagation();
														setEditingTagId(tag.id);
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
														{fmt.format(tagCounts[tag.id] ?? 0)}
													</small>
												</label>
											</li>
										</ContextMenu.Trigger>
										<ContextMenu.Portal>
											<TagContextMenuContent
												tagId={tag.id}
												totalCount={tagCounts[tag.id] ?? 0}
												onRename={() => setRenamingTag({ id: tag.id, name: tag.name })}
											/>
										</ContextMenu.Portal>
									</ContextMenu.Root>
								);
							})}
						</ul>
					)
				)}
			</ToolBlock>

			{editingTag && <EditTagDialog tag={editingTag} onClose={() => setEditingTagId(null)} />}

			{renamingTag && (
				<RenameInSelectionDialog tag={renamingTag} onClose={() => setRenamingTag(null)} />
			)}
		</>
	);
}

function TagContextMenuContent({
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

	const handleSave = () => {
		updateTags([{ id: tag.id, patch: { name: name.trim() || tag.name, color: hexValue } }]);
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
