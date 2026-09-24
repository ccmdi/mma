import { useState, useMemo, useRef, useCallback, useOptimistic, startTransition } from "react";
import type { Tag, TagPatch } from "@/types";
import { HslColorPicker } from "react-colorful";
import {
	deleteTags,
	renameTagsIn,
	getMapState,
	getVisibleTags,
	reorderTags,
	updateTags,
	useMapState,
	getTagCounts,
} from "@/store/useMapStore";
import { getSelectedTagIds } from "@/store/selectionActions";
import type { TagSortMode } from "@/types";
import type { Selector, Update, VirtualTag } from "@/bindings.gen";
import {
	Dialog,
	DialogActions,
	DialogContent,
	DialogForm,
	PromptDialog,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { Hint } from "@/components/primitives/Hint";
import { Field } from "@/components/primitives/Sidebar";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { ToolBlock } from "@/components/primitives/ToolBlock";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { fmt } from "@/lib/util/format";
import { hexToHsl, hslToHex, type HSL } from "@/lib/util/color";
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
} from "./tagTreeModel";
import { t } from "@/lib/i18n";
import { matches } from "@/lib/search";
import { useDialog } from "@/store/dialogBus";
import { isAtOrUnder, leafSegment } from "@/lib/data/tagPaths";
import { SearchInput } from "@/components/primitives/SearchInput";

/** `order` rides the optimistic overlay only; persisted order goes through `reorderTags`. */
type OptimisticTagPatch = TagPatch & { order?: number };

// Stable identities: an inline default would be a new object each render, which
// invalidates the tag tree's useMemo and re-renders every row.
const NO_VIRTUAL_TAGS = {};
const NO_ALIASES = {};

export function TagManager() {
	const map = useMapState((s) => s.map);
	const selectedTagIds = useMapState(getSelectedTagIds);
	const tagCounts = useMapState(() => getTagCounts());
	const tagViewMode = useSetting("tagViewMode");
	const [filterText, setFilterText] = useState("");
	const sortMode = useSetting("tagSortMode");
	const [virtualTags, setVirtualTags] = useMapSetting("virtualTags", NO_VIRTUAL_TAGS);
	const [aliases, setAliases] = useMapSetting("aliases", NO_ALIASES);
	const [addingAliasFor, setAddingAliasFor] = useState<{ id: number; name: string } | null>(null);
	const [editingTag, setEditingTag] = useState<Tag | null>(null);
	const [editingVirtualPath, setEditingVirtualPath] = useState<string | null>(null);
	// Parent path for a pending new declared folder ("" = root, null = dialog closed).
	const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
	const treeRef = useRef<TagTreeHandle>(null);
	const [renamingInSelection, setRenamingInSelection] = useState<{
		tagIds: number[];
		name: string;
		scope: Selector;
	} | null>(null);
	useDialog("rename-in-selection", setRenamingInSelection);
	const [recoloring, setRecoloring] = useState<{ tagIds: number[]; root: string | null } | null>(
		null,
	);
	useDialog("recolor-tags", setRecoloring);
	const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
	useDialog("rename-folder", setRenamingFolder);
	const [collapsed, setCollapsed] = useState(false);

	// memoOnRefs keys this on the tag view, so the array identity is stable across
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

	// Stamp `color` onto `tagIds`, and with a `root` onto every folder node at or under it too.
	const recolor = (tagIds: number[], root: string | null, color: string) => {
		commitTags(tagIds.map((id) => ({ id, patch: { color } })));
		if (root == null) return;
		const nextVT = { ...virtualTags };
		for (const t of tags) {
			const parts = t.name.split("/");
			for (let i = 1; i < parts.length; i++) {
				const folder = parts.slice(0, i).join("/");
				if (isAtOrUnder(folder, root)) nextVT[folder] = { color };
			}
		}
		setVirtualTags(nextVT);
	};
	// Move folder `oldPath` and everything under it to `newPath`; `folder` replaces its own entry.
	const renameFolder = (oldPath: string, newPath: string, folder?: VirtualTag) => {
		const {
			tagRenames,
			virtualTags: nextVT,
			aliases: nextAliases,
		} = cascadeRename(oldPath, newPath, tags, virtualTags, aliases);
		if (tagRenames.length)
			commitTags(tagRenames.map((r) => ({ id: r.id, patch: { name: r.name } })));
		if (folder) nextVT[newPath] = folder;
		setVirtualTags(nextVT);
		setAliases(nextAliases);
		treeRef.current?.remapExpanded(oldPath, newPath);
	};
	const siblingPath = (path: string, segment: string) => {
		const i = path.lastIndexOf("/");
		return i === -1 ? segment : `${path.slice(0, i)}/${segment}`;
	};
	const addAlias = useCallback((tag: { id: number; name: string }) => setAddingAliasFor(tag), []);
	const handleEditTreeTag = useCallback((node: TagTreeNode) => {
		if (node.tag) setEditingTag(node.tag);
	}, []);
	const removeAlias = useCallback(
		(aliasPath: string) => {
			const next = { ...(getMapState().map?.settings.aliases ?? {}) };
			delete next[aliasPath];
			setAliases(next);
		},
		[setAliases],
	);
	// Deletes the declared subtree (only reachable when no tags live under `path`).
	const deleteFolder = useCallback(
		(path: string) => {
			const vt = getMapState().map?.settings.virtualTags ?? {};
			const next: Record<string, VirtualTag> = {};
			for (const [k, v] of Object.entries(vt)) {
				if (!isAtOrUnder(k, path)) next[k] = v;
			}
			setVirtualTags(next);
		},
		[setVirtualTags],
	);

	// Collapsed-state pill preview only; the open list is rendered by TagTreeView.
	const sortedTags = useMemo(() => {
		const filtered = filterText ? tags.filter((t) => matches(filterText, t.name)) : tags;
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
						<SearchInput
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
					onAddAlias={addAlias}
					onRemoveAlias={removeAlias}
					onReorder={commitReorder}
					onMoveInto={commitMoveInto}
					onNewFolder={setNewFolderParent}
					onDeleteFolder={deleteFolder}
					filterText={filterText}
				/>
			</ToolBlock>

			{editingTag && (
				<EditTagDialog
					open
					tag={editingTag}
					commit={commitTags}
					aliases={aliases}
					setAliases={setAliases}
					onOpenChange={(open) => !open && setEditingTag(null)}
				/>
			)}

			{editingVirtualPath != null && (
				<VirtualTagDialog
					open
					path={editingVirtualPath}
					color={virtualTags[editingVirtualPath]?.color ?? null}
					onOpenChange={(open) => !open && setEditingVirtualPath(null)}
					onSave={(color, newSegment) => {
						renameFolder(editingVirtualPath, siblingPath(editingVirtualPath, newSegment), {
							color,
						});
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

			{renamingInSelection && (
				<RenameInSelectionDialog
					open
					{...renamingInSelection}
					onOpenChange={(open) => !open && setRenamingInSelection(null)}
				/>
			)}

			{recoloring && (
				<RecolorTagsDialog
					open
					color={tags.find((t) => t.id === recoloring.tagIds[0])?.color ?? "#888888"}
					count={recoloring.tagIds.length}
					onSave={(color) => {
						recolor(recoloring.tagIds, recoloring.root, color);
						setRecoloring(null);
					}}
					onOpenChange={(open) => !open && setRecoloring(null)}
				/>
			)}

			{renamingFolder != null && (
				<RenameFolderDialog
					open
					path={renamingFolder}
					onSave={(segment) => {
						renameFolder(renamingFolder, siblingPath(renamingFolder, segment));
						setRenamingFolder(null);
					}}
					onOpenChange={(open) => !open && setRenamingFolder(null)}
				/>
			)}

			{newFolderParent != null && (
				<NewFolderDialog
					open
					parentPath={newFolderParent}
					tags={tags}
					virtualTags={virtualTags}
					aliases={aliases}
					onOpenChange={(open) => !open && setNewFolderParent(null)}
					onSave={(path) => {
						setVirtualTags({ ...virtualTags, [path]: {} });
						setNewFolderParent(null);
					}}
				/>
			)}

			{addingAliasFor && (
				<AddAliasDialog
					open
					tag={addingAliasFor}
					tags={tags}
					virtualTags={virtualTags}
					aliases={aliases}
					onOpenChange={(open) => !open && setAddingAliasFor(null)}
					onSave={(aliasPath, folder) => {
						// Declared, so the folder outlives the alias like one made with New folder.
						if (folder && !virtualTags[folder]) setVirtualTags({ ...virtualTags, [folder]: {} });
						setAliases({ ...aliases, [aliasPath]: addingAliasFor.id });
						setAddingAliasFor(null);
					}}
				/>
			)}
		</>
	);
}

function RenameInSelectionDialog({
	open,
	onOpenChange,
	tagIds,
	name: initialName,
	scope,
}: DialogProps & { tagIds: number[]; name: string; scope: Selector }) {
	const [name, setName] = useState(initialName);

	const handleSubmit = () => {
		const trimmed = name.trim();
		if (trimmed) void renameTagsIn(tagIds, trimmed, scope);
		onOpenChange(false);
	};

	return (
		<PromptDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t("Rename in selection")}
			value={name}
			onChange={setName}
			submitLabel={t("Rename")}
			onSubmit={handleSubmit}
		/>
	);
}

function EditTagDialog({
	open,
	onOpenChange,
	tag,
	commit,
	aliases,
	setAliases,
}: DialogProps & {
	tag: { id: number; name: string; color: string };
	/** Routes tag updates through the optimistic overlay. */
	commit: (updates: Update<TagPatch>[]) => void;
	aliases: Record<string, number>;
	setAliases: (v: Record<string, number>) => void;
}) {
	const close = () => onOpenChange(false);
	const [name, setName] = useState(tag.name);
	const [hsl, setHsl] = useState(() => hexToHsl(tag.color));
	const hexValue = hslToHex(hsl);
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
		commit([{ id: tag.id, patch: { name: newName, color: hexValue } }]);
		if (newName !== tag.name) {
			const synced = syncAliasSegments(aliases, [{ id: tag.id, oldName: tag.name, newName }]);
			if (synced) setAliases(synced);
		}
		const cur = bindings ?? [];
		if ((getTagBindingKey(cur, tag.id) ?? "") !== hotkey) {
			setBindings(withTagKeyBinding(cur, tag.id, hotkey));
		}
		close();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Edit tag")}>
				<DialogForm onSubmit={handleSave}>
					<div>
						{t("Rename:")}{" "}
						<TextInput
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
						/>
					</div>
					<TagColorFields hsl={hsl} onChange={setHsl} />
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
					<DialogActions
						destructive={{
							label: t("Delete"),
							onClick: () => {
								void deleteTags([tag.id]);
								close();
							},
							"data-qa": "tag-delete",
						}}
						primary={{ label: t("Save"), "data-qa": "tag-save" }}
					/>
				</DialogForm>
			</DialogContent>
		</Dialog>
	);
}

function TagColorFields({ hsl, onChange }: { hsl: HSL; onChange: (hsl: HSL) => void }) {
	return (
		<div className="edit-tag-modal__color">
			<span>{t("Color:")}</span>
			<TextInput
				className="hex-color"
				type="text"
				value={hslToHex(hsl)}
				onChange={(e) => {
					const v = e.target.value;
					if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(hexToHsl(v));
				}}
			/>
			<HslColorPicker
				className="edit-tag-modal__color-picker"
				style={{ width: "100%" }}
				color={hsl}
				onChange={onChange}
			/>
		</div>
	);
}

function RenameFolderDialog({
	open,
	onOpenChange,
	path,
	onSave,
}: DialogProps & { path: string; onSave: (segment: string) => void }) {
	const segment = leafSegment(path);
	const [name, setName] = useState(segment);

	return (
		<PromptDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t('Rename folder "{name}"', { name: segment })}
			value={name}
			onChange={setName}
			submitLabel={t("Rename")}
			onSubmit={() => onSave(name.trim() || segment)}
		/>
	);
}

function RecolorTagsDialog({
	open,
	onOpenChange,
	color,
	count,
	onSave,
}: DialogProps & { color: string; count: number; onSave: (color: string) => void }) {
	const [hsl, setHsl] = useState(() => hexToHsl(color));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t({ one: "Recolor {n} tag", other: "Recolor {n} tags" }, { n: count })}>
				<DialogForm onSubmit={() => onSave(hslToHex(hsl))}>
					<TagColorFields hsl={hsl} onChange={setHsl} />
					<DialogActions cancel primary={{ label: t("Save") }} />
				</DialogForm>
			</DialogContent>
		</Dialog>
	);
}

/** Color editor for a virtual tag-tree node (a folder path with no underlying tag).
 *  Persists to `MapSettings.virtualTags`; Reset clears the override back to inherited. */
function VirtualTagDialog({
	open,
	onOpenChange,
	path,
	color,
	onSave,
	onReset,
}: DialogProps & {
	path: string;
	color: string | null;
	onSave: (color: string, newSegment: string) => void;
	onReset: () => void;
}) {
	const [hsl, setHsl] = useState(() => hexToHsl(color ?? "#888888"));
	const hexValue = hslToHex(hsl);
	const segment = leafSegment(path);
	const [name, setName] = useState(segment);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t('Edit folder "{name}"', { name: segment })}>
				<DialogForm onSubmit={() => onSave(hexValue, name.trim() || segment)}>
					<div>
						{t("Rename:")}{" "}
						<TextInput
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
						/>
					</div>
					<TagColorFields hsl={hsl} onChange={setHsl} />
					<DialogActions
						destructive={{ label: t("Reset"), onClick: onReset, disabled: color == null }}
						primary={{ label: t("Save") }}
					/>
				</DialogForm>
			</DialogContent>
		</Dialog>
	);
}

/** Create a declared empty folder: a `MapSettings.virtualTags` entry whose path no tag
 *  passes through. buildTagTree seeds a folder node for it, so it persists until deleted.
 *  Slashes in the name create the whole chain at once. */
function NewFolderDialog({
	open,
	onOpenChange,
	parentPath,
	tags,
	virtualTags,
	aliases,
	onSave,
}: DialogProps & {
	parentPath: string;
	tags: Tag[];
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
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
		<PromptDialog
			open={open}
			onOpenChange={onOpenChange}
			title={parentPath ? t('New folder in "{parent}"', { parent: parentPath }) : t("New folder")}
			value={name}
			onChange={setName}
			placeholder={t("Folder name")}
			error={collision ? t('"{path}" already exists in the tree', { path }) : null}
			canSubmit={!!path && !collision}
			submitLabel={t("Create")}
			onSubmit={() => onSave(path)}
		/>
	);
}

/** Place an existing tag at a second tree location. The alias keeps the tag's leaf name;
 *  the user picks the target folder. Persists to `MapSettings.aliases` (path -> tag id). */
function AddAliasDialog({
	open,
	onOpenChange,
	tag,
	tags,
	virtualTags,
	aliases,
	onSave,
}: DialogProps & {
	tag: { id: number; name: string };
	tags: Tag[];
	virtualTags: Record<string, VirtualTag>;
	aliases: Record<string, number>;
	onSave: (aliasPath: string, folder: string) => void;
}) {
	const [folder, setFolder] = useState("");
	const segment = leafSegment(tag.name);

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
		return [...set]
			.filter((p) => matches(folder, p))
			.sort()
			.slice(0, 50);
	}, [tags, virtualTags, aliases, folder]);

	const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
	const aliasPath = trimmed ? `${trimmed}/${segment}` : segment;
	const collision = occupied.has(aliasPath);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t('Alias "{name}"', { name: segment })} size="sm">
				<DialogForm onSubmit={() => !collision && onSave(aliasPath, trimmed)}>
					<Field
						label={t("Target folder")}
						hint={
							collision ? (
								<Hint tone="error">
									{t('"{path}" already exists in the tree', { path: aliasPath })}
								</Hint>
							) : (
								<>
									{t("Appears as")} <strong>{aliasPath}</strong>
								</>
							)
						}
					>
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
					</Field>
					<DialogActions cancel primary={{ label: t("Add alias"), disabled: collision }} />
				</DialogForm>
			</DialogContent>
		</Dialog>
	);
}
