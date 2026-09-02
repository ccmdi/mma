import { memo, useState, useEffect, useCallback, useRef } from "react";
import {
	composeSelections,
	createTags,
	decomposeChild,
	fetchBounds,
	getVisibleTags,
	isolateSelection,
	pruneDuplicates,
	removeChildFromSelection,
	removeSelections,
	reorderSelection,
	resolveIds,
	selectInverse,
	setPolygonName,
	setSelectionColors,
	toggleGhostSelection,
	updateFilterSelection,
	useMapState,
} from "@/store/useMapStore";
import { toast } from "@/lib/util/toast";
import { downloadBlob } from "@/lib/util/util";
import { stepFilterWindow } from "@/lib/util/date";
import type { RGB } from "@/lib/util/color";
import type { Selection } from "@/bindings.gen";
import { filterIsLocalTime, selectionDisplayName } from "@/store/selections";
import {
	FilterForm,
	filterPropsToSeed,
	useExtraFieldKeys,
} from "@/components/editor/map/FilterBuilder";
import { beginReview } from "@/lib/review/review";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
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
import { boundsOfCoords, type MapHost } from "@/lib/map/host";
import { t } from "@/lib/i18n";

async function fitSelectionBounds(host: MapHost, selection: Selection) {
	if (selection.selector.type === "Polygon") {
		const coords = selection.selector.polygon.coordinates.flat();
		const bounds = boundsOfCoords(coords.map(([lng, lat]) => ({ lat, lng })));
		if (bounds) host.fitBounds(bounds, 100);
		return;
	}
	const box = await fetchBounds(selection.selector);
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
		? () => removeChildFromSelection(parentKey, selection.key)
		: () => removeSelections([selection.key]);
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
			setSelectionColors([{ key: selection.key, color }]);
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
		void setPolygonName(selection.key, renameDraft);
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
			composeSelections(
				drag.key,
				selection.key,
				drag.altKey ? "Union" : "Intersection",
				drag.parentKey,
				parentKey ?? null,
			);
		} else {
			if (drag.parentKey) decomposeChild(drag.parentKey, drag.key);
			reorderSelection(drag.key, selection.key, dropZone);
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
					<span className="color-block" style={{ backgroundColor: colorBlockCss }} />{" "}
					{selectionDisplayName(selection)}
				</span>
				{isDropTarget && dropZone === "on" && (
					<span className="selection-row__drop-hint">{drag?.altKey ? t("OR") : t("AND")}</span>
				)}
				<span className="selection-row__size mono">{fmt.format(count)}</span>
				<span className="selection-row__actions">
					{stepFilter && (
						<>
							<button
								className="icon-button"
								type="button"
								aria-label={t("Previous period")}
								onClick={() => stepFilter(-1)}
							>
								<Icon path={mdiChevronLeft} size={18} />
							</button>
							<button
								className="icon-button"
								type="button"
								aria-label={t("Next period")}
								onClick={() => stepFilter(1)}
							>
								<Icon path={mdiChevronRight} size={18} />
							</button>
						</>
					)}
					<Menu.Root modal={false} onOpenChange={(open) => !open && setView("contextmenu")}>
						<Menu.Trigger
							render={
								<button className="icon-button" type="button" aria-label={t("Selection options")}>
									<Icon path={mdiDotsVertical} />
								</button>
							}
						/>
						<Menu.Portal>
							<Menu.Positioner className="menu-positioner" align="end">
								<Menu.Popup className="context-menu">
									{view === "color" ? (
										<div style={{ padding: "0.5rem", width: "14rem" }}>
											<RgbPicker color={selection.color} onChange={handleColorChange} />
										</div>
									) : (
										<>
											<Menu.Item
												className="context-menu__item"
												onClick={() => void selectInverse([selection.key])}
											>
												{t("Invert selection")}
											</Menu.Item>
											{selection.selector.type === "Filter" && (
												<Menu.Item
													className="context-menu__item"
													onClick={() => setEditingFilter(true)}
												>
													{t("Edit filter")}
												</Menu.Item>
											)}
											<Menu.Item
												className="context-menu__item"
												disabled={count === 0}
												onClick={() =>
													void (async () => {
														const ids = await resolveIds(selection.selector);
														void beginReview(ids, selection);
													})()
												}
											>
												{t("Review selection")}
											</Menu.Item>
											{selection.selector.type !== "Tag" && (
												<Menu.Item
													className="context-menu__item"
													disabled={count === 0}
													onClick={() => {
														const names = new Set(getVisibleTags().map((t) => t.name));
														setTagName(uniqueTagName(selectionDisplayName(selection), names));
														setSavingTag(true);
													}}
												>
													{t("Save as tag")}
												</Menu.Item>
											)}
											{pruneDistance(selection) != null && (
												<Menu.Item
													className="context-menu__item"
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
												</Menu.Item>
											)}
											{selection.selector.type !== "Tag" && (
												<Menu.Item
													className="context-menu__item"
													closeOnClick={false}
													onClick={() => setView("color")}
												>
													{t("Change color")}
												</Menu.Item>
											)}
											{isPoly && (
												<>
													<Menu.Separator className="context-menu__separator" />
													<Menu.Item className="context-menu__item" onClick={handleDownloadGeoJSON}>
														{t("Download GeoJSON")}
													</Menu.Item>
													<Menu.Item className="context-menu__item" onClick={handleRename}>
														{t("Rename")}
													</Menu.Item>
												</>
											)}
											<Menu.Separator className="context-menu__separator" />
											<Menu.Item className="context-menu__item" onClick={onRemove}>
												{t("Deselect")}
											</Menu.Item>
										</>
									)}
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
					{isTopLevel && (
						<button
							className="icon-button"
							type="button"
							aria-label={ghosted ? t("Un-ghost selection") : t("Ghost selection")}
							title={t("Ghost selection (Alt-click to isolate)")}
							onClick={(e) =>
								void (e.altKey
									? isolateSelection(selection.key)
									: toggleGhostSelection(selection.key))
							}
						>
							<Icon path={ghosted ? mdiGhost : mdiGhostOutline} />
						</button>
					)}
					<button
						className="icon-button"
						type="button"
						onClick={onRemove}
						aria-label={t("Deselect")}
					>
						<Icon path={mdiClose} />
					</button>
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
			<Dialog open={renaming} onOpenChange={setRenaming}>
				<DialogContent title={t("Polygon name")}>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							submitRename();
						}}
						style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
					>
						<TextInput
							value={renameDraft}
							onChange={(e) => setRenameDraft(e.target.value)}
							onFocus={(e) => e.currentTarget.select()}
							autoFocus
						/>
						<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
							<Button onClick={() => setRenaming(false)}>{t("Cancel")}</Button>
							<Button variant="primary" type="submit">
								{t("Rename")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
			<Dialog
				open={savingTag}
				onOpenChange={(v) => {
					setSavingTag(v);
					if (!v) setTagName("");
				}}
			>
				<DialogContent title={t("Save selection as tag")}>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void handleSaveAsTag();
						}}
						style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
					>
						<TextInput
							value={tagName}
							onChange={(e) => setTagName(e.target.value)}
							onFocus={(e) => e.currentTarget.select()}
							placeholder={t("Tag name...")}
							autoFocus
						/>
						<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
							<Button
								onClick={() => {
									setSavingTag(false);
									setTagName("");
								}}
							>
								{t("Cancel")}
							</Button>
							<Button variant="primary" type="submit" disabled={!tagName.trim()}>
								{t("Create tag")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
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
