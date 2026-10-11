import { memo, useState, useEffect, useRef } from "react";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { Tag } from "@/store/tag";
import { Query } from "@/store/query";
import { Edit } from "@/store/edit";
import { useItemDrag } from "@/lib/hooks/useItemDrag";
import {
	composeSelections,
	filterIsLocalTime,
	isolateGhost,
	moveSelection,
	removeSelectionAt,
	replaceSelection,
	selectionDisplayName,
	type SelectionPath,
	setPolygonName,
	setSelectionColor,
	tagIdOf,
	toggleGhost,
	toggleInvert,
} from "@/store/selections";
import { toast } from "@/lib/util/toast";
import { downloadBlob } from "@/lib/util/util";
import { polygonFeature } from "@/lib/util/geojson";
import { stepFilterWindow } from "@/lib/util/date";
import type { RGB, Selection } from "@/bindings.gen";
import {
	FilterForm,
	filterPropsToSeed,
	useExtraFieldKeys,
} from "@/components/editor/map/FilterBuilder";
import { beginReview } from "@/lib/review/review";
import { PromptDialog } from "@/components/primitives/Dialog";
import { RgbPicker } from "@/components/primitives/ColorPicker";
import {
	mdiClose,
	mdiChevronLeft,
	mdiChevronRight,
	mdiDotsVertical,
	mdiGhost,
	mdiGhostOutline,
} from "@mdi/js";
import { Menu } from "@base-ui-components/react/menu";
import { fmt } from "@/lib/util/format";
import { rgbCss } from "@/lib/util/color";
import { getMapHost } from "@/lib/map/mapState";
import type { MapHost } from "@/lib/map/host";
import { cmd } from "@/lib/commands";
import { t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";
import { MenuPopup, MenuItem, MenuSeparator } from "@/components/primitives/Menu";
import { Swatch } from "@/components/primitives/Swatch";

async function fitSelectionBounds(host: MapHost, currentSelection: Selection) {
	const box =
		currentSelection.selector.type === "Polygon"
			? await cmd.polygonBounds(currentSelection.selector.polygon)
			: await Query.read(currentSelection.selector, { kind: "bounds" });
	if (box) host.fitBounds({ west: box[0], south: box[1], east: box[2], north: box[3] }, 100);
}

function uniqueTagName(base: string, existing: Set<string>): string {
	if (!existing.has(base)) return base;
	for (let i = 1; ; i++) {
		const candidate = `${base} (${i})`;
		if (!existing.has(candidate)) return candidate;
	}
}

function pruneDistance(currentSelection: Selection): number | null {
	if (currentSelection.selector.type === "Duplicates") return currentSelection.selector.distance;
	if (currentSelection.selector.type === "Intersection") {
		for (const child of currentSelection.selector.selections) {
			if (child.selector.type === "Duplicates") return child.selector.distance;
		}
	}
	return null;
}

// --- Mouse-based drag system (HTML5 DnD is broken in Tauri webview) ---
interface DragState {
	path: SelectionPath;
	startY: number;
	altKey: boolean;
}

let activeDrag: DragState | null = null;
let dragListeners: (() => void)[] = [];
function notifyDragListeners() {
	dragListeners.forEach((fn) => fn());
}

function useDragState() {
	const [, setTick] = useState(0);
	useEffect(() => {
		const fn = () => setTick((t) => t + 1);
		dragListeners.push(fn);
		return () => {
			dragListeners = dragListeners.filter((l) => l !== fn);
		};
	}, []);
	return activeDrag;
}

/** An Invert wraps exactly one selection; its row renders the wrapped one. */
function innerOf(currentSelection: Selection): Selection {
	return currentSelection.selector.type === "Invert"
		? currentSelection.selector.selections[0]
		: currentSelection;
}

export const SelectionRow = memo(function SelectionRow({
	selection: currentSelection,
	path,
	depth = 0,
	ghosted,
}: {
	selection: Selection;
	path: SelectionPath;
	depth?: number;
	ghosted: boolean;
}) {
	const map = Store.use((s) => s.map);
	const colorBlockCss = rgbCss(currentSelection.color);
	const count = Store.use((s) => s.selectionCounts[currentSelection.key] ?? 0);
	const isTopLevel = depth === 0;
	const onRemove = () => void SelectionList.update(removeSelectionAt(path));
	const [view, setView] = useState<"contextmenu" | "color">("contextmenu");
	const [dropZone, setDropZone] = useState<"before" | "on" | "after" | null>(null);
	const [editingFilter, setEditingFilter] = useState(false);
	const [savingTag, setSavingTag] = useState(false);
	const [tagName, setTagName] = useState("");
	const [renaming, setRenaming] = useState(false);
	const [renameDraft, setRenameDraft] = useState("");
	const rowRef = useRef<HTMLDivElement>(null);
	const drag = useDragState();
	const isDragging = drag?.path.join() === path.join();
	const isDropTarget = drag != null && !isDragging;
	const handleColorChange = (color: RGB) =>
		void SelectionList.update(setSelectionColor(path, color));

	const fieldEntries = useExtraFieldKeys();

	const handleMouseDown = useItemDrag((e) => {
		if ((e.target as HTMLElement).closest("button, [role='menu']")) return null;
		const startY = e.clientY;
		const setAlt = (altKey: boolean) => {
			if (activeDrag) activeDrag = { ...activeDrag, altKey };
			notifyDragListeners();
		};
		return {
			onStart: (ev) => {
				activeDrag = { path, startY, altKey: ev.altKey };
				notifyDragListeners();
			},
			onMove: (ev) => setAlt(ev.altKey),
			onKey: (ev) => setAlt(ev.altKey),
			onEnd: () => {
				activeDrag = null;
				notifyDragListeners();
			},
		};
	});

	if (!map) return null;
	const inner = innerOf(currentSelection);
	const stepFilter = (() => {
		const p = currentSelection.selector;
		if (p.type !== "Filter") return null;
		const ft = fieldEntries.find((f) => f.key === p.field)?.def.type;
		const wallClock = filterIsLocalTime(p.test);
		if (stepFilterWindow(ft, p.test, 1, wallClock) == null) return null;
		return (dir: 1 | -1) => {
			const next = stepFilterWindow(ft, p.test, dir, wallClock);
			if (next) {
				void SelectionList.update(
					replaceSelection(path, { type: "Filter", field: p.field, test: next }),
				);
			}
		};
	})();
	const showChildren = inner.selector.type === "Intersection" || inner.selector.type === "Union";
	const isPoly = currentSelection.selector.type === "Polygon";

	const handleRename = () => {
		if (currentSelection.selector.type !== "Polygon") return;
		setRenameDraft(currentSelection.selector.polygon.properties?.name ?? "");
		setRenaming(true);
	};

	const submitRename = () => {
		void SelectionList.update(setPolygonName(path, renameDraft));
		setRenaming(false);
	};

	const handleSaveAsTag = async () => {
		const name = tagName.trim();
		if (!name || count === 0) return;
		const { keys: add } = (await Edit.values("tags", [{ set: { id: 0, name } }])).mutation;
		await Edit.work(currentSelection.selector, { kind: "listSet", key: "tags", add, remove: [] });
		setSavingTag(false);
		setTagName("");
	};

	const handleDownloadGeoJSON = () => {
		if (currentSelection.selector.type !== "Polygon") return;
		const poly = currentSelection.selector.polygon;
		const name = poly.properties?.name ?? "polygon";
		downloadBlob(
			new Blob([JSON.stringify(polygonFeature(poly))], { type: "application/geo+json" }),
			`${name}.geojson`,
		);
	};

	const handleMouseMove = (e: React.MouseEvent) => {
		if (!isDropTarget || !rowRef.current) return;
		const rect = rowRef.current.getBoundingClientRect();
		const y = (e.clientY - rect.top) / rect.height;
		const zone = y < 0.25 ? ("before" as const) : y > 0.75 ? ("after" as const) : ("on" as const);
		setDropZone(zone);
	};

	const handleMouseLeave = () => {
		if (isDropTarget) setDropZone(null);
	};

	const handleMouseUp = () => {
		if (!isDropTarget || !drag || !dropZone) return;
		if (dropZone === "on") {
			void SelectionList.update(
				composeSelections(drag.path, path, drag.altKey ? "Union" : "Intersection"),
			);
		} else {
			void SelectionList.update(moveSelection(drag.path, path, dropZone));
		}
		setDropZone(null);
	};

	return (
		<>
			<div
				ref={rowRef}
				className={`selection-row${isDragging ? " is-dragging" : ""}${ghosted ? " is-ghosted" : ""}`}
				data-drop={isDropTarget ? (dropZone ?? undefined) : undefined}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseLeave={handleMouseLeave}
				onMouseUp={handleMouseUp}
			>
				<span
					className="selection-row__label truncate"
					style={{ paddingLeft: `${depth * 2}rem` }}
					onClick={() => {
						if (drag) return;
						const host = getMapHost();
						if (host && map) void fitSelectionBounds(host, currentSelection);
					}}
				>
					<Swatch color={colorBlockCss} /> {selectionDisplayName(currentSelection)}
				</span>
				{isDropTarget && dropZone === "on" && (
					<span className="selection-row__drop-hint">{drag?.altKey ? t("OR") : t("AND")}</span>
				)}
				<span className="selection-row__size mono">{fmt.format(count)}</span>
				<span className="selection-row__actions">
					{stepFilter && (
						<>
							<IconButton
								icon={mdiChevronLeft}
								size={18}
								label={t("Previous period")}
								onClick={() => stepFilter(-1)}
							/>
							<IconButton
								icon={mdiChevronRight}
								size={18}
								label={t("Next period")}
								onClick={() => stepFilter(1)}
							/>
						</>
					)}
					<Menu.Root modal={false} onOpenChange={(open) => !open && setView("contextmenu")}>
						<Menu.Trigger
							render={<IconButton icon={mdiDotsVertical} label={t("Selection options")} />}
						/>
						<MenuPopup align="end">
							{view === "color" ? (
								<div style={{ padding: "0.5rem", width: "14rem" }}>
									<RgbPicker color={currentSelection.color} onChange={handleColorChange} />
								</div>
							) : (
								<>
									<MenuItem onClick={() => void SelectionList.update(toggleInvert(path))}>
										{t("Invert selection")}
									</MenuItem>
									{currentSelection.selector.type === "Filter" && (
										<MenuItem onClick={() => setEditingFilter(true)}>{t("Edit filter")}</MenuItem>
									)}
									<MenuItem
										disabled={count === 0}
										onClick={() =>
											void (async () => {
												const ids = await Query.read(currentSelection.selector, { kind: "ids" });
												void beginReview(ids, currentSelection);
											})()
										}
									>
										{t("Review selection")}
									</MenuItem>
									{tagIdOf(currentSelection.selector) == null && (
										<MenuItem
											disabled={count === 0}
											onClick={() => {
												const names = new Set(Tag.visible().map((t) => t.name));
												setTagName(uniqueTagName(selectionDisplayName(currentSelection), names));
												setSavingTag(true);
											}}
										>
											{t("Save as tag")}
										</MenuItem>
									)}
									{pruneDistance(currentSelection) != null && (
										<MenuItem
											disabled={count === 0}
											onClick={() =>
												void (async () => {
													const { changed: n } = await Edit.work(currentSelection.selector, {
														kind: "pruneDuplicates",
														distance: pruneDistance(currentSelection)!,
														score: Store.get().map?.settings.duplicateScore ?? null,
													});
													toast(
														t(
															{
																one: "Pruned {n} duplicate",
																other: "Pruned {n} duplicates",
															},
															{ n },
														),
													);
												})()
											}
										>
											{t("Prune duplicates")}
										</MenuItem>
									)}
									{tagIdOf(currentSelection.selector) == null && (
										<MenuItem closeOnClick={false} onClick={() => setView("color")}>
											{t("Change color")}
										</MenuItem>
									)}
									{isPoly && (
										<>
											<MenuSeparator />
											<MenuItem onClick={handleDownloadGeoJSON}>{t("Download GeoJSON")}</MenuItem>
											<MenuItem onClick={handleRename}>{t("Rename")}</MenuItem>
										</>
									)}
									<MenuSeparator />
									<MenuItem onClick={onRemove}>{t("Deselect")}</MenuItem>
								</>
							)}
						</MenuPopup>
					</Menu.Root>
					{isTopLevel && (
						<IconButton
							icon={ghosted ? mdiGhost : mdiGhostOutline}
							label={ghosted ? t("Un-ghost selection") : t("Ghost selection")}
							tooltip={t("Ghost selection (Alt-click to isolate)")}
							onClick={(e) =>
								void SelectionList.update(e.altKey ? isolateGhost(path[0]) : toggleGhost(path[0]))
							}
						/>
					)}
					<IconButton icon={mdiClose} label={t("Deselect")} onClick={onRemove} />
				</span>
			</div>
			{editingFilter && currentSelection.selector.type === "Filter" && (
				<FilterForm
					initial={filterPropsToSeed(currentSelection.selector)}
					submitLabel={t("Update filter")}
					onSubmit={(field, test) =>
						void SelectionList.update(replaceSelection(path, { type: "Filter", field, test }))
					}
					onClose={() => setEditingFilter(false)}
				/>
			)}
			<PromptDialog
				open={renaming}
				onOpenChange={setRenaming}
				title={t("Polygon name")}
				value={renameDraft}
				onChange={setRenameDraft}
				selectOnFocus
				canSubmit
				submitLabel={t("Rename")}
				onSubmit={submitRename}
			/>
			<PromptDialog
				open={savingTag}
				onOpenChange={(v) => {
					setSavingTag(v);
					if (!v) setTagName("");
				}}
				title={t("Save selection as tag")}
				value={tagName}
				onChange={setTagName}
				placeholder={t("Tag name...")}
				selectOnFocus
				submitLabel={t("Create tag")}
				onSubmit={() => void handleSaveAsTag()}
			/>
			{showChildren &&
				(
					inner.selector as Extract<Selection["selector"], { type: "Intersection" | "Union" }>
				).selections.map((child, i) => (
					<SelectionRow
						key={child.key}
						selection={child}
						path={currentSelection === inner ? [...path, i] : [...path, 0, i]}
						depth={depth + 1}
						ghosted={ghosted}
					/>
				))}
		</>
	);
});
