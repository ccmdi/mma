import {
	useState,
	useMemo,
	useEffect,
	useRef,
	useCallback,
	useOptimistic,
	startTransition,
} from "react";
import { HslColorPicker } from "react-colorful";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import {
	useMapState,
	getMapState,
	getSelectedTagIds,
	updateTags,
	reorderTags,
	deleteTags,
	removeTagFromAllLocations,
	getVisibleTags,
	removeTagFromLocations,
	scopeIds,
} from "@/store/useMapStore";
import type { TagSortMode } from "@/types";
import type { Tag, TagPatch, Update, VirtualTag } from "@/bindings.gen";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { ToolBlock } from "@/components/primitives/ToolBlock";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { Checkbox } from "@/components/primitives/Checkbox";
import { fmt } from "@/lib/util/format";
import { hexToHsl, hslToHex } from "@/lib/util/color";
import { TagPill } from "@/components/primitives/TagPill";
import { useSetting, setSetting } from "@/store/settings";
import { sortTagsByMode } from "@/lib/util/util";
import { useMapSetting } from "@/store/useMapSetting";
import { HotkeyInput } from "@/components/primitives/HotkeyInput";
import { getConflicts } from "@/lib/util/hotkeys";
import { getTagBindingKey, withTagKeyBinding } from "@/lib/map/mapKeyBindings";
import { TagTreeView, type TagTreeHandle } from "./TagTree";
import {
	cascadeRename,
	collectOccupiedPaths,
	syncAliasSegments,
	type TagTreeNode,
	type TagMoveResult,
} from "./tagTreeRange";
import { t } from "@/lib/i18n";

/** `order` rides the optimistic overlay only; persisted order goes through `reorderTags`. */
type OptimisticTagPatch = TagPatch & { order?: number };

// Stable identities: an inline default would be a new object each render, which
// invalidates the tag tree's useMemo and re-renders every row.
const NO_VIRTUAL_TAGS = {};
const NO_ALIASES = {};

export function TagManager() {
	const map = useMapState((s) => s.map);
	const selectedTagIds = useMapState(getSelectedTagIds);
	const tagCounts = useMapState((s) => s.tagCounts);
	const tagViewMode = useSetting("tagViewMode");
	const [filterText, setFilterText] = useState("");
	const sortMode = useSetting("tagSortMode");
	const [virtualTags, setVirtualTags] = useMapSetting("virtualTags", NO_VIRTUAL_TAGS);
	const [aliases, setAliases] = useMapSetting("aliases", NO_ALIASES);
	const [addingAliasFor, setAddingAliasFor] = useState<{ id: number; name: string } | null>(null);
	// The edited node carries descendant context so the dialog can offer a cascade rename
	// (descendantCount is 0 for every leaf, including all of flat mode).
	const [editingTreeTag, setEditingTreeTag] = useState<{
		tag: Tag;
		descendantCount: number;
	} | null>(null);
	const [editingVirtualPath, setEditingVirtualPath] = useState<string | null>(null);
	// Parent path for a pending new declared folder ("" = root, null = dialog closed).
	const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
	const treeRef = useRef<TagTreeHandle>(null);
	const [renamingTag, setRenamingTag] = useState<{ id: number; name: string } | null>(null);
	const [collapsed, setCollapsed] = useState(false);

	// memoOnRefs keys this on `state.tags`, so the array identity is stable across
	// selection toggles (which never touch tags) and fresh on any tag mutation.
	const storeTags = useMapState(getVisibleTags);

	// Optimistic overlay: `commitTags`/`commitReorder` apply pending name/color/order patches
	// over the store tags for the lifetime of the mutation; React drops them once the transition
	// settles (by which point the store reflects the change), so a rename/recolor/drag-reorder
	// renders in the same frame as the virtualTags/expansion updates
	const [tags, addOptimisticTags] = useOptimistic(
		storeTags,
		(cur: Tag[], updates: Update<OptimisticTagPatch>[]) =>
			cur.map((t) => {
				const u = updates.find((x) => x.id === t.id);
				if (!u) return t;
				return {
					...t,
					...(u.patch.name != null ? { name: u.patch.name } : {}),
					...(u.patch.color != null ? { color: u.patch.color } : {}),
					...(u.patch.order != null ? { order: u.patch.order } : {}),
				};
			}),
	);
	const commitTags = useCallback(
		(updates: Update<TagPatch>[]) => {
			startTransition(async () => {
				addOptimisticTags(updates);
				await updateTags(updates);
			});
		},
		[addOptimisticTags],
	);
	const commitReorder = useCallback(
		(orderedIds: number[]) => {
			startTransition(async () => {
				addOptimisticTags(orderedIds.map((id, i) => ({ id, patch: { order: i } })));
				await reorderTags(orderedIds);
			});
		},
		[addOptimisticTags],
	);
	const commitMoveInto = useCallback(
		(move: TagMoveResult) => {
			startTransition(async () => {
				// One merged patch per id -- the optimistic reducer applies the first match only.
				const patchById = new Map<number, OptimisticTagPatch>();
				move.orderedIds.forEach((id, i) => patchById.set(id, { order: i }));
				for (const r of move.tagRenames)
					patchById.set(r.id, { ...patchById.get(r.id), name: r.name });
				addOptimisticTags([...patchById].map(([id, patch]) => ({ id, patch })));
				if (move.tagRenames.length)
					await updateTags(move.tagRenames.map((r) => ({ id: r.id, patch: { name: r.name } })));
				await reorderTags(move.orderedIds);
			});
			setVirtualTags(move.virtualTags);
			setAliases(move.aliases);
			for (const [oldPath, newPath] of move.pathRemaps)
				treeRef.current?.remapExpanded(oldPath, newPath);
		},
		[addOptimisticTags, setVirtualTags, setAliases],
	);

	// Stamp `color` onto every tag AND folder node at or under `root` (overrides existing
	// colors, so it works even when descendants already have their own).
	const applyColorToSubtree = (root: string, color: string) => {
		const tagUpdates: Update<TagPatch>[] = [];
		const folders = new Set<string>();
		for (const t of tags) {
			if (t.name !== root && !t.name.startsWith(`${root}/`)) continue;
			tagUpdates.push({ id: t.id, patch: { color } });
			const parts = t.name.split("/");
			let p = "";
			for (let i = 0; i < parts.length - 1; i++) {
				p = p ? `${p}/${parts[i]}` : parts[i];
				if (p === root || p.startsWith(`${root}/`)) folders.add(p);
			}
		}
		commitTags(tagUpdates);
		const nextVT = { ...virtualTags };
		for (const f of folders) nextVT[f] = { color };
		setVirtualTags(nextVT);
	};
	const addAlias = useCallback((tag: { id: number; name: string }) => setAddingAliasFor(tag), []);
	const handleEditTreeTag = useCallback((node: TagTreeNode) => {
		if (node.tag)
			setEditingTreeTag({ tag: node.tag, descendantCount: node.descendantTagIds.length - 1 });
	}, []);
	const removeAlias = useCallback(
		(aliasPath: string) => {
			const next = { ...(getMapState().map?.meta.settings.aliases ?? {}) };
			delete next[aliasPath];
			setAliases(next);
		},
		[setAliases],
	);
	// Deletes the declared subtree (only reachable when no tags live under `path`).
	const deleteFolder = useCallback(
		(path: string) => {
			const vt = getMapState().map?.meta.settings.virtualTags ?? {};
			const next: Record<string, VirtualTag> = {};
			for (const [k, v] of Object.entries(vt)) {
				if (k !== path && !k.startsWith(`${path}/`)) next[k] = v;
			}
			setVirtualTags(next);
		},
		[setVirtualTags],
	);

	// Collapsed-state pill preview only; the open list is rendered by TagTreeView.
	const sortedTags = useMemo(() => {
		let filtered = tags;
		if (filterText) {
			const lower = filterText.toLowerCase();
			filtered = tags.filter((t) => t.name.toLowerCase().includes(lower));
		}
		return sortTagsByMode(filtered, sortMode, tagCounts);
	}, [tags, filterText, sortMode, tagCounts]);

	if (!map) return null;

	return (
		<>
			<ToolBlock
				className="tag-manager"
				title={t("Tags")}
				isCollapsed={collapsed}
				onCollapse={setCollapsed}
				collapsedAddons={
					<ul className="tag-list is-collapsed">
						{sortedTags.slice(0, 20).map((tag) => (
							<TagPill
								as="li"
								key={tag.id}
								small
								color={tag.color}
								label={`${tag.name} (${fmt.format(tagCounts[tag.id] ?? 0)})`}
							/>
						))}
					</ul>
				}
				addons={
					<>
						<TextInput
							placeholder={t("Filter tags...")}
							value={filterText}
							onChange={(e) => setFilterText(e.target.value)}
						/>
						<span className="tag-manager__spacer"></span>
						{tagViewMode === "tree" && (
							<Button onClick={() => setNewFolderParent("")}>{t("New folder")}</Button>
						)}
						<span className="button-group" role="radiogroup" aria-label={t("Sort tags")}>
							{(
								[
									["default", t("default")],
									["name", t("name")],
									["amount", t("amount")],
								] as [TagSortMode, string][]
							).map(([mode, label]) => (
								<Button
									key={mode}
									className="button-group__button"
									role="radio"
									aria-checked={sortMode === mode}
									onClick={() => setSetting("tagSortMode", mode)}
								>
									{label}
								</Button>
							))}
						</span>
					</>
				}
			>
				<TagTreeView
					ref={treeRef}
					split={tagViewMode === "tree"}
					tags={tags}
					selectedTagIds={selectedTagIds}
					tagCounts={tagCounts}
					sortMode={sortMode}
					virtualTags={virtualTags}
					aliases={aliases}
					onEditTag={handleEditTreeTag}
					onEditVirtual={setEditingVirtualPath}
					onRenameTag={setRenamingTag}
					onAddAlias={addAlias}
					onRemoveAlias={removeAlias}
					onReorder={commitReorder}
					onMoveInto={commitMoveInto}
					onNewFolder={setNewFolderParent}
					onDeleteFolder={deleteFolder}
					filterText={filterText}
				/>
			</ToolBlock>

			{editingTreeTag && (
				<EditTagDialog
					tag={editingTreeTag.tag}
					commit={commitTags}
					aliases={aliases}
					setAliases={setAliases}
					cascade={
						editingTreeTag.descendantCount > 0
							? {
									descendantCount: editingTreeTag.descendantCount,
									tags,
									virtualTags,
									setVirtualTags,
									onRenamed: (o, n) => treeRef.current?.remapExpanded(o, n),
									onApplyColor: (color) => applyColorToSubtree(editingTreeTag.tag.name, color),
								}
							: undefined
					}
					onClose={() => setEditingTreeTag(null)}
				/>
			)}

			{editingVirtualPath != null && (
				<VirtualTagDialog
					path={editingVirtualPath}
					color={virtualTags[editingVirtualPath]?.color ?? null}
					descendantCount={tags.filter((t) => t.name.startsWith(`${editingVirtualPath}/`)).length}
					onClose={() => setEditingVirtualPath(null)}
					onApplyColor={(color) => {
						applyColorToSubtree(editingVirtualPath, color);
						setEditingVirtualPath(null);
					}}
					onSave={(color, newSegment) => {
						const i = editingVirtualPath.lastIndexOf("/");
						const parent = i === -1 ? "" : editingVirtualPath.slice(0, i);
						const newPath = parent ? `${parent}/${newSegment}` : newSegment;
						if (newPath !== editingVirtualPath) {
							const {
								tagRenames,
								virtualTags: nextVT,
								aliases: nextAliases,
							} = cascadeRename(editingVirtualPath, newPath, tags, virtualTags, aliases);
							if (tagRenames.length)
								commitTags(tagRenames.map((r) => ({ id: r.id, patch: { name: r.name } })));
							nextVT[newPath] = { color };
							setVirtualTags(nextVT);
							setAliases(nextAliases);
							treeRef.current?.remapExpanded(editingVirtualPath, newPath);
						} else {
							setVirtualTags({ ...virtualTags, [editingVirtualPath]: { color } });
						}
						setEditingVirtualPath(null);
					}}
					onReset={() => {
						const next = { ...virtualTags };
						delete next[editingVirtualPath];
						setVirtualTags(next);
						setEditingVirtualPath(null);
					}}
				/>
			)}

			{renamingTag && (
				<RenameInSelectionDialog
					tag={renamingTag}
					commit={commitTags}
					aliases={aliases}
					setAliases={setAliases}
					onClose={() => setRenamingTag(null)}
				/>
			)}

			{newFolderParent != null && (
				<NewFolderDialog
					parentPath={newFolderParent}
					tags={tags}
					virtualTags={virtualTags}
					aliases={aliases}
					onClose={() => setNewFolderParent(null)}
					onSave={(path) => {
						setVirtualTags({ ...virtualTags, [path]: {} });
						setNewFolderParent(null);
					}}
				/>
			)}

			{addingAliasFor && (
				<AddAliasDialog
					tag={addingAliasFor}
					tags={tags}
					virtualTags={virtualTags}
					aliases={aliases}
					onClose={() => setAddingAliasFor(null)}
					onSave={(aliasPath) => {
						setAliases({ ...aliases, [aliasPath]: addingAliasFor.id });
						setAddingAliasFor(null);
					}}
				/>
			)}
		</>
	);
}

export function TagContextMenuContent({
	tagId,
	totalCount,
	onRename,
	onAddAlias,
	onRemoveAlias,
	onNewSubfolder,
}: {
	tagId: number;
	totalCount: number;
	onRename: () => void;
	/** Tree mode only: place this tag at a second folder path. */
	onAddAlias?: () => void;
	/** Tree mode only: present on an alias leaf to remove it. */
	onRemoveAlias?: () => void;
	/** Tree mode only: present on folder rows to create a declared subfolder. */
	onNewSubfolder?: () => void;
}) {
	const [selCount, setSelCount] = useState<number | null>(null);

	useEffect(() => {
		const selIds = getMapState().selectedLocationIds;
		if (selIds.size === 0) {
			setSelCount(0);
			return;
		}
		scopeIds({ kind: "props", props: { type: "Tag", tagId } }).then((tagLocIds) => {
			let count = 0;
			for (const id of tagLocIds) if (selIds.has(id)) count++;
			setSelCount(count);
		});
	}, [tagId]);

	const inSel = selCount ?? 0;

	return (
		<ContextMenu.Positioner className="menu-positioner">
			<ContextMenu.Popup className="context-menu">
				<ContextMenu.Item
					className="context-menu__item"
					onClick={() => removeTagFromAllLocations(tagId)}
				>
					{t(
						{ one: "Remove from all ({n} location)", other: "Remove from all ({n} locations)" },
						{ n: totalCount },
					)}
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					disabled={inSel === 0}
					onClick={() => removeTagFromLocations(tagId, [...getMapState().selectedLocationIds])}
				>
					{t(
						{
							one: "Remove from selection ({n} location)",
							other: "Remove from selection ({n} locations)",
						},
						{ n: inSel },
					)}
				</ContextMenu.Item>
				<ContextMenu.Item className="context-menu__item" disabled={inSel === 0} onClick={onRename}>
					{t(
						{
							one: "Rename in selection ({n} location)",
							other: "Rename in selection ({n} locations)",
						},
						{ n: inSel },
					)}
				</ContextMenu.Item>
				{onAddAlias && (
					<ContextMenu.Item className="context-menu__item" onClick={onAddAlias}>
						{t("Add alias...")}
					</ContextMenu.Item>
				)}
				{onNewSubfolder && (
					<ContextMenu.Item className="context-menu__item" onClick={onNewSubfolder}>
						{t("New subfolder...")}
					</ContextMenu.Item>
				)}
				{onRemoveAlias && (
					<ContextMenu.Item className="context-menu__item" onClick={onRemoveAlias}>
						{t("Remove alias")}
					</ContextMenu.Item>
				)}
			</ContextMenu.Popup>
		</ContextMenu.Positioner>
	);
}

function RenameInSelectionDialog({
	tag,
	onClose,
	commit,
	aliases,
	setAliases,
}: {
	tag: { id: number; name: string };
	onClose: () => void;
	commit: (updates: Update<TagPatch>[]) => void;
	aliases: Record<string, number>;
	setAliases: (v: Record<string, number>) => void;
}) {
	const [name, setName] = useState(tag.name);

	const handleSubmit = () => {
		const trimmed = name.trim();
		if (trimmed && trimmed !== tag.name) {
			commit([{ id: tag.id, patch: { name: trimmed } }]);
			const synced = syncAliasSegments(aliases, [
				{ id: tag.id, oldName: tag.name, newName: trimmed },
			]);
			if (synced) setAliases(synced);
		}
		onClose();
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title={t("Rename tag in selection")}>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleSubmit();
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
				>
					<TextInput type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
					<div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
						<Button onClick={onClose}>{t("Cancel")}</Button>
						<Button variant="primary" type="submit">
							{t("Rename")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function EditTagDialog({
	tag,
	onClose,
	commit,
	aliases,
	setAliases,
	cascade,
}: {
	tag: { id: number; name: string; color: string };
	onClose: () => void;
	/** Routes tag updates through the optimistic overlay. */
	commit: (updates: Update<TagPatch>[]) => void;
	aliases: Record<string, number>;
	setAliases: (v: Record<string, number>) => void;
	/** Present for a tree folder node with descendants: lets the rename cascade down. */
	cascade?: {
		descendantCount: number;
		tags: Tag[];
		virtualTags: Record<string, VirtualTag>;
		setVirtualTags: (v: Record<string, VirtualTag>) => void;
		onRenamed: (oldPrefix: string, newPrefix: string) => void;
		onApplyColor: (color: string) => void;
	};
}) {
	const [name, setName] = useState(tag.name);
	const [cascadeOn, setCascadeOn] = useState(false);
	const [hsl, setHsl] = useState(() => hexToHsl(tag.color));
	const hexValue = hslToHex(hsl.h, hsl.s, hsl.l);
	const [bindings, setBindings] = useMapSetting("keyBindings");
	const [hotkey, setHotkey] = useState(() => getTagBindingKey(bindings ?? [], tag.id) ?? "");

	// Informational only: per-map bindings preempt these while this map is open,
	// and assigning steals the key from whichever tag held it.
	const globalConflicts = hotkey ? getConflicts("", hotkey) : [];
	const holder = hotkey
		? (bindings ?? []).find(
				(b) => b.key === hotkey && !(b.action.type === "applyTag" && b.action.tagId === tag.id),
			)
		: undefined;
	const holderAction = holder?.action;
	const holderTag =
		holderAction?.type === "applyTag"
			? getVisibleTags().find((t) => t.id === holderAction.tagId)
			: undefined;

	const handleSave = () => {
		const newName = name.trim() || tag.name;
		if (cascade && cascadeOn && newName !== tag.name) {
			const {
				tagRenames,
				virtualTags: nextVT,
				aliases: nextAliases,
			} = cascadeRename(tag.name, newName, cascade.tags, cascade.virtualTags, aliases);
			commit(
				tagRenames.map((r) => ({
					id: r.id,
					patch: r.id === tag.id ? { name: r.name, color: hexValue } : { name: r.name },
				})),
			);
			cascade.setVirtualTags(nextVT);
			setAliases(nextAliases);
			cascade.onRenamed(tag.name, newName);
		} else {
			commit([{ id: tag.id, patch: { name: newName, color: hexValue } }]);
			if (newName !== tag.name) {
				const synced = syncAliasSegments(aliases, [{ id: tag.id, oldName: tag.name, newName }]);
				if (synced) setAliases(synced);
			}
		}
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
			<DialogContent title={t("Edit tag")}>
				<form
					className="edit-tag-modal"
					onSubmit={(e) => {
						e.preventDefault();
						handleSave();
					}}
				>
					<div className="edit-tag-modal__name">
						{t("Rename:")}{" "}
						<TextInput
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
						/>
						{cascade && (
							<label className="edit-tag-modal__cascade">
								<Checkbox checked={cascadeOn} onChange={(e) => setCascadeOn(e.target.checked)} />
								{t(
									{ one: "Rename {n} tag inside", other: "Rename {n} tags inside" },
									{ n: cascade.descendantCount },
								)}
							</label>
						)}
					</div>
					<div className="edit-tag-modal__color">
						<span>{t("Color:")}</span>
						<TextInput
							className="hex-color"
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
						{cascade && cascade.descendantCount > 0 && (
							<Button
								className="edit-tag-modal__apply-color"
								onClick={() => {
									cascade.onApplyColor(hexValue);
									onClose();
								}}
							>
								{t(
									{ one: "Apply to {n} tag inside", other: "Apply to {n} tags inside" },
									{ n: cascade.descendantCount },
								)}
							</Button>
						)}
					</div>
					<div className="edit-tag-modal__hotkey">
						<span>{t("Hotkey:")}</span>
						<HotkeyInput value={hotkey} onChange={setHotkey} />
						<Button disabled={!hotkey} onClick={() => setHotkey("")}>
							{t("Clear")}
						</Button>
						{(holderTag || globalConflicts.length > 0) && (
							<p className="edit-tag-modal__hotkey-note">
								{holderTag && <>{t('Takes the key from "{name}". ', { name: holderTag.name })}</>}
								{globalConflicts.length > 0 && (
									<>
										{t('Overrides "{label}" while this map is open.', {
											label: t(globalConflicts[0].label),
										})}
									</>
								)}
							</p>
						)}
					</div>
					<div className="edit-tag-modal__actions">
						<Button variant="destructive" onClick={handleDelete} data-qa="tag-delete">
							{t("Delete")}
						</Button>
						<Button variant="primary" type="submit" data-qa="tag-save">
							{t("Save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Color editor for a virtual tag-tree node (a folder path with no underlying tag).
 *  Persists to `MapSettings.virtualTags`; Reset clears the override back to inherited. */
function VirtualTagDialog({
	path,
	color,
	descendantCount,
	onClose,
	onSave,
	onApplyColor,
	onReset,
}: {
	path: string;
	color: string | null;
	descendantCount: number;
	onClose: () => void;
	onSave: (color: string, newSegment: string) => void;
	onApplyColor: (color: string) => void;
	onReset: () => void;
}) {
	const [hsl, setHsl] = useState(() => hexToHsl(color ?? "#888888"));
	const hexValue = hslToHex(hsl.h, hsl.s, hsl.l);
	const segment = path.split("/").pop() || path;
	const [name, setName] = useState(segment);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title={t('Edit folder "{name}"', { name: segment })}>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						onSave(hexValue, name.trim() || segment);
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.5rem", paddingTop: "2px" }}
				>
					<div className="edit-tag-modal__name">
						{t("Rename:")}{" "}
						<TextInput
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
						/>
					</div>
					<div className="edit-tag-modal__color">
						<span>{t("Color:")}</span>
						<TextInput
							className="hex-color"
							type="text"
							value={hexValue}
							onChange={(e) => {
								const v = e.target.value;
								if (/^#[0-9a-fA-F]{6}$/.test(v)) setHsl(hexToHsl(v));
							}}
						/>
						<HslColorPicker
							className="edit-tag-modal__color-picker"
							style={{ width: "100%" }}
							color={hsl}
							onChange={setHsl}
						/>
						{descendantCount > 0 && (
							<Button
								className="edit-tag-modal__apply-color"
								onClick={() => onApplyColor(hexValue)}
							>
								{t(
									{ one: "Apply to {n} tag inside", other: "Apply to {n} tags inside" },
									{ n: descendantCount },
								)}
							</Button>
						)}
					</div>
					<div className="edit-tag-modal__actions">
						<Button variant="destructive" onClick={onReset} disabled={color == null}>
							{t("Reset")}
						</Button>
						<Button variant="primary" type="submit">
							{t("Save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Create a declared empty folder: a `MapSettings.virtualTags` entry whose path no tag
 *  passes through. buildTagTree seeds a folder node for it, so it persists until deleted.
 *  Slashes in the name create the whole chain at once. */
function NewFolderDialog({
	parentPath,
	tags,
	virtualTags,
	aliases,
	onClose,
	onSave,
}: {
	parentPath: string;
	tags: Tag[];
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
	onClose: () => void;
	onSave: (path: string) => void;
}) {
	const [name, setName] = useState("");

	// A new folder must claim a free slot.
	const occupied = useMemo(
		() => collectOccupiedPaths(tags, aliases, virtualTags),
		[tags, aliases, virtualTags],
	);

	const segment = name
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
	const path = segment ? (parentPath ? `${parentPath}/${segment}` : segment) : "";
	const collision = !!path && occupied.has(path);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				title={parentPath ? t('New folder in "{parent}"', { parent: parentPath }) : t("New folder")}
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (path && !collision) onSave(path);
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem", paddingTop: "0.5rem" }}
				>
					<div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
						<TextInput
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("Folder name")}
							autoFocus
						/>
						<span
							style={{
								fontSize: "0.85em",
								minHeight: "1.25em",
								lineHeight: "1.25em",
								color: "var(--destructive)",
							}}
						>
							{collision ? t('"{path}" already exists in the tree', { path }) : ""}
						</span>
					</div>
					<div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
						<Button onClick={onClose}>{t("Cancel")}</Button>
						<Button variant="primary" type="submit" disabled={!path || collision}>
							{t("Create")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Place an existing tag at a second tree location. The alias keeps the tag's leaf name;
 *  the user picks the target folder. Persists to `MapSettings.aliases` (path -> tag id). */
function AddAliasDialog({
	tag,
	tags,
	virtualTags,
	aliases,
	onClose,
	onSave,
}: {
	tag: { id: number; name: string };
	tags: Tag[];
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
	onClose: () => void;
	onSave: (aliasPath: string) => void;
}) {
	const [folder, setFolder] = useState("");
	const segment = tag.name.split("/").pop() || tag.name;

	// The alias slot must be free.
	const occupied = useMemo(
		() => collectOccupiedPaths(tags, aliases, virtualTags),
		[tags, aliases, virtualTags],
	);

	// Folder paths the user can nest under: ancestors of tags + virtual/alias folder nodes.
	const folderSuggestions = useMemo(() => {
		const set = new Set<string>();
		const addAncestors = (path: string) => {
			const parts = path.split("/");
			let p = "";
			for (let i = 0; i < parts.length - 1; i++) {
				p = p ? `${p}/${parts[i]}` : parts[i];
				set.add(p);
			}
		};
		for (const t of tags) addAncestors(t.name);
		for (const k of Object.keys(virtualTags)) set.add(k);
		for (const k of Object.keys(aliases)) addAncestors(k);
		const lower = folder.toLowerCase();
		return [...set]
			.filter((p) => p.toLowerCase().includes(lower))
			.sort()
			.slice(0, 50);
	}, [tags, virtualTags, aliases, folder]);

	const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
	const aliasPath = trimmed ? `${trimmed}/${segment}` : segment;
	const collision = occupied.has(aliasPath);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title={t('Alias "{name}"', { name: segment })}>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!collision) onSave(aliasPath);
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
				>
					<div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
						<span style={{ fontSize: "0.85em", opacity: 0.7 }}>{t("Target folder")}</span>
						<SuggestInput
							value={folder}
							onChange={setFolder}
							suggestions={folderSuggestions}
							onPick={setFolder}
							renderItem={(p) => p}
							getKey={(p) => p}
							placeholder={t("e.g. Europe/France (blank = top level)")}
							portal
							autoFocus
							pickOnEnter={false}
						/>
						<span style={{ fontSize: "0.85em", opacity: 0.7 }}>
							{collision ? (
								<span style={{ color: "var(--destructive)" }}>
									{t('"{path}" already exists in the tree', { path: aliasPath })}
								</span>
							) : (
								<>
									{t("Appears as")} <strong>{aliasPath}</strong>
								</>
							)}
						</span>
					</div>
					<div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
						<Button onClick={onClose}>{t("Cancel")}</Button>
						<Button variant="primary" type="submit" disabled={collision}>
							{t("Add alias")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
