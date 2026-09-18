import { memo, useState, useEffect, useCallback, useRef } from "react";
import {
	applySelectionUpdate,
	createTags,
	fetchBounds,
	getVisibleTags,
	pruneDuplicates,
	resolveIds,
	useMapState,
} from "@/store/useMapStore";
import { updateFilterSelection } from "@/store/selectionActions";
import {
	batch,
	composeSelections,
	decomposeChild,
	filterIsLocalTime,
	isolateGhost,
	invertSelections,
	removeFromComposite,
	removeSelection,
	reorderSelections,
	selectionDisplayName,
	setPolygonName,
	setSelectionColors,
	toggleGhost,
} from "@/store/selections";
import { toast } from "@/lib/util/toast";
import { downloadBlob } from "@/lib/util/util";
import { stepFilterWindow } from "@/lib/util/date";
import type { RGB } from "@/lib/util/color";
import type { Selection } from "@/bindings.gen";
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

async function fitSelectionBounds(host: MapHost, selection: Selection) {
	const box =
		selection.selector.type === "Polygon"
			? await cmd.polygonBounds(selection.selector.polygon)
			: await fetchBounds(selection.selector);
	if (box) host.fitBounds({ west: box[0], south: box[1], east: box[2], north: box[3] }, 100);
}

function uniqueTagName(base: string, existing: Set<string>): string {
	if (!existing.has(base)) return base;
	for (let i = 1; ; i++) {
		const candidate = `${base} (${i})`;
		if (!existing.has(candidate)) return candidate;
	}
}

function pruneDistance(selection: Selection): number | null {
	if (selection.selector.type === "Duplicates") return selection.selector.distance;
	if (selection.selector.type === "Intersection") {
		for (const child of selection.selector.selections) {
			if (child.selector.type === "Duplicates") return child.selector.distance;
		}
	}
	return null;
}

// --- Mouse-based drag system (HTML5 DnD is broken in Tauri webview) ---
interface DragState {
	key: string;
	parentKey: string | null;
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
function innerOf(selection: Selection): Selection {
	return selection.selector.type === "Invert" ? selection.selector.selections[0] : selection;
}

export const SelectionRow = memo(function SelectionRow({
	selection,
	depth = 0,
	parentKey,
	inheritedGhost = false,
}: {
	selection: Selection;
	depth?: number;
	parentKey?: string | null;
	inheritedGhost?: boolean;
}) {
	const map = useMapState((s) => s.map);
	const tagColor = useMapState((s) => {
		const i = innerOf(selection);
		return i.selector.type === "Tag" ? s.tags[i.selector.tagId]?.color : undefined;
	});
	const count = useMapState((s) => s.selectionCounts[selection.key] ?? 0);
	const isTopLevel = depth === 0;
	const ghosted = useMapState(
		(s) => inheritedGhost || (depth === 0 && s.ghostedSelections.has(selection.key)),
	);
	const onRemove = parentKey
		? () => void applySelectionUpdate(removeFromComposite(parentKey, selection.key))
		: () => void applySelectionUpdate(batch(removeSelection)([selection.key]));
	const [view, setView] = useState<"contextmenu" | "color">("contextmenu");
	const [dropZone, setDropZone] = useState<"before" | "on" | "after" | null>(null);
	const [editingFilter, setEditingFilter] = useState(false);
	const [savingTag, setSavingTag] = useState(false);
	const [tagName, setTagName] = useState("");
	const [renaming, setRenaming] = useState(false);
	const [renameDraft, setRenameDraft] = useState("");
	const rowRef = useRef<HTMLDivElement>(null);
	const drag = useDragState();
	const isDragging = drag?.key === selection.key;
	const isDropTarget = drag != null && drag.key !== selection.key;
	const handleColorChange = useCallback(
		(color: RGB) => {
			void applySelectionUpdate(setSelectionColors([{ ...selection, color }]));
		},
		[selection.key],
	);

	const fieldEntries = useExtraFieldKeys();

	if (!map) return null;
	const inner = innerOf(selection);
	const stepFilter = (() => {
		const p = selection.selector;
		if (p.type !== "Filter") return null;
		const ft = fieldEntries.find((f) => f.key === p.field)?.def.type;
		const wallClock = filterIsLocalTime(p.test);
		if (stepFilterWindow(ft, p.test, 1, wallClock) == null) return null;
		return (dir: 1 | -1) => {
			const next = stepFilterWindow(ft, p.test, dir, wallClock);
			if (next) {
				void updateFilterSelection(selection.key, { type: "Filter", field: p.field, test: next });
			}
		};
	})();
	const showChildren = inner.selector.type === "Intersection" || inner.selector.type === "Union";
	const isPoly = selection.selector.type === "Polygon";
	const colorBlockCss =
		inner.selector.type === "Tag" ? (tagColor ?? rgbCss(selection.color)) : rgbCss(selection.color);

	const handleRename = () => {
		if (selection.selector.type !== "Polygon") return;
		setRenameDraft(selection.selector.polygon.properties?.name ?? "");
		setRenaming(true);
	};

	const submitRename = () => {
		void applySelectionUpdate(setPolygonName(selection.key, renameDraft));
		setRenaming(false);
	};

	const handleSaveAsTag = async () => {
		const name = tagName.trim();
		if (!name || count === 0) return;
		await createTags([name], selection.selector);
		setSavingTag(false);
		setTagName("");
	};

	const handleDownloadGeoJSON = () => {
		if (selection.selector.type !== "Polygon") return;
		const poly = selection.selector.polygon;
		const name = poly.properties?.name ?? "polygon";
		const fc = {
			type: "Feature",
			properties: poly.properties ?? {},
			geometry: { type: "Polygon", coordinates: poly.coordinates },
		};
		downloadBlob(
			new Blob([JSON.stringify(fc)], { type: "application/geo+json" }),
			`${name}.geojson`,
		);
	};

	const handleMouseDown = (e: React.MouseEvent) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button, [role='menu']")) return;
		e.preventDefault();
		const startY = e.clientY;
		const key = selection.key;
		const pk = parentKey ?? null;
		let started = false;

		const onMove = (me: MouseEvent) => {
			if (!started && Math.abs(me.clientY - startY) > 4) {
				started = true;
				activeDrag = { key, parentKey: pk, startY, altKey: me.altKey };
				notifyDragListeners();
			}
			if (started && activeDrag) {
				activeDrag = { ...activeDrag, altKey: me.altKey };
				notifyDragListeners();
			}
		};

		const ac = new AbortController();
		const onUp = () => {
			ac.abort();
			if (started) {
				activeDrag = null;
				notifyDragListeners();
			}
		};

		const onKey = (ke: KeyboardEvent) => {
			if (ke.key === "Escape") {
				activeDrag = null;
				notifyDragListeners();
				onUp();
				return;
			}
			if (activeDrag) {
				activeDrag = { ...activeDrag, altKey: ke.altKey };
				notifyDragListeners();
			}
		};
		const onKeyUp = (ke: KeyboardEvent) => {
			if (activeDrag) {
				activeDrag = { ...activeDrag, altKey: ke.altKey };
				notifyDragListeners();
			}
		};

		const { signal } = ac;
		window.addEventListener("mousemove", onMove, { signal });
		window.addEventListener("mouseup", onUp, { signal });
		window.addEventListener("keydown", onKey, { signal });
		window.addEventListener("keyup", onKeyUp, { signal });
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
			void applySelectionUpdate(
				composeSelections(
					drag.key,
					selection.key,
					drag.altKey ? "Union" : "Intersection",
					drag.parentKey,
					parentKey ?? null,
				),
			);
		} else {
			if (drag.parentKey) void applySelectionUpdate(decomposeChild(drag.parentKey, drag.key));
			void applySelectionUpdate(reorderSelections(drag.key, selection.key, dropZone));
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
					className="selection-row__label"
					style={{ paddingLeft: `${depth * 2}rem` }}
					onClick={() => {
						if (drag) return;
						const host = getMapHost();
						if (host && map) void fitSelectionBounds(host, selection);
					}}
				>
					<Swatch color={colorBlockCss} /> {selectionDisplayName(selection)}
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
									<RgbPicker color={selection.color} onChange={handleColorChange} />
								</div>
							) : (
								<>
									<MenuItem
										onClick={() => void applySelectionUpdate(invertSelections([selection.key]))}
									>
										{t("Invert selection")}
									</MenuItem>
									{selection.selector.type === "Filter" && (
										<MenuItem onClick={() => setEditingFilter(true)}>{t("Edit filter")}</MenuItem>
									)}
									<MenuItem
										disabled={count === 0}
										onClick={() =>
											void (async () => {
												const ids = await resolveIds(selection.selector);
												void beginReview(ids, selection);
											})()
										}
									>
										{t("Review selection")}
									</MenuItem>
									{selection.selector.type !== "Tag" && (
										<MenuItem
											disabled={count === 0}
											onClick={() => {
												const names = new Set(getVisibleTags().map((t) => t.name));
												setTagName(uniqueTagName(selectionDisplayName(selection), names));
												setSavingTag(true);
											}}
										>
											{t("Save as tag")}
										</MenuItem>
									)}
									{pruneDistance(selection) != null && (
										<MenuItem
											disabled={count === 0}
											onClick={() =>
												void (async () => {
													const n = await pruneDuplicates(
														selection.selector,
														pruneDistance(selection)!,
													);
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
									{selection.selector.type !== "Tag" && (
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
								void applySelectionUpdate(
									e.altKey ? isolateGhost(selection.key) : toggleGhost(selection.key),
								)
							}
						/>
					)}
					<IconButton icon={mdiClose} label={t("Deselect")} onClick={onRemove} />
				</span>
			</div>
			{editingFilter && selection.selector.type === "Filter" && (
				<FilterForm
					initial={filterPropsToSeed(selection.selector)}
					submitLabel={t("Update filter")}
					onSubmit={(field, test) =>
						void updateFilterSelection(selection.key, { type: "Filter", field, test })
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
				).selections.map((child) => (
					<SelectionRow
						key={child.key}
						selection={child}
						depth={depth + 1}
						parentKey={selection.key}
						inheritedGhost={ghosted}
					/>
				))}
		</>
	);
});
