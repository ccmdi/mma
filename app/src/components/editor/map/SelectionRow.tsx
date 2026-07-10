import { useState, useEffect, useCallback, useRef } from "react";
import {
	useCurrentMap,
	useGhostedSelections,
	useSelectionCounts,
	selectInverse,
	setPolygonName,
	setSelectionColors,
	addTagToLocations,
	createTags,
	fetchLocationsByIds,
	reorderSelection,
	composeSelections,
	decomposeChild,
	removeChildFromSelection,
	toggleGhostSelection,
	isolateSelection,
	updateFilterSelection,
	pruneDuplicates,
	getVisibleTags,
} from "@/store/useMapStore";
import { toast } from "@/lib/util/toast";
import { stepFilterWindow } from "@/lib/data/fieldOps";
import { cmd } from "@/lib/commands";
import { RgbColorPicker } from "react-colorful";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import type { RGB } from "@/lib/util/color";
import type { Selection } from "@/bindings.gen";
import { selectionDisplayName } from "@/store/selections";
import {
	FilterForm,
	filterPropsToSeed,
	useExtraFieldKeys,
} from "@/components/editor/map/FilterBuilder";
import { beginReview } from "@/lib/review/review";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import {
	mdiClose,
	mdiChevronLeft,
	mdiChevronRight,
	mdiDotsVertical,
	mdiGhost,
	mdiGhostOutline,
} from "@mdi/js";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { fmt } from "@/lib/util/format";
import { rgbCss } from "@/lib/util/color";
import { getMapHost } from "@/lib/map/mapState";
import { boundsOfCoords, type MapHost } from "@/lib/map/host";

async function fitSelectionBounds(host: MapHost, selection: Selection) {
	if (selection.props.type === "Polygon") {
		const coords = selection.props.polygon.coordinates.flat();
		const bounds = boundsOfCoords(coords.map(([lng, lat]) => ({ lat, lng })));
		if (bounds) host.fitBounds(bounds, 100);
		return;
	}
	const ids = await cmd.storeResolveSelection(selection.props);
	if (ids.length === 0) return;
	const locs = await fetchLocationsByIds(ids);
	const bounds = boundsOfCoords(locs);
	if (bounds) host.fitBounds(bounds, 100);
}

function uniqueTagName(base: string, existing: Set<string>): string {
	if (!existing.has(base)) return base;
	for (let i = 1; ; i++) {
		const candidate = `${base} (${i})`;
		if (!existing.has(candidate)) return candidate;
	}
}

function pruneDistance(selection: Selection): number | null {
	if (selection.props.type === "Duplicates") return selection.props.distance;
	if (selection.props.type === "Intersection") {
		for (const child of selection.props.selections) {
			if (child.props.type === "Duplicates") return child.props.distance;
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

export function SelectionRow({
	selection,
	depth = 0,
	parentKey,
	onRemove,
	inheritedGhost = false,
}: {
	selection: Selection;
	depth?: number;
	parentKey?: string | null;
	onRemove?: () => void;
	inheritedGhost?: boolean;
}) {
	const map = useCurrentMap();
	const ghostedKeys = useGhostedSelections();
	const count = useSelectionCounts()[selection.key] ?? 0;
	const isTopLevel = depth === 0;
	const ghosted = inheritedGhost || (isTopLevel && ghostedKeys.has(selection.key));
	const [view, setView] = useState<"contextmenu" | "color">("contextmenu");
	const [dropZone, setDropZone] = useState<"before" | "on" | "after" | null>(null);
	const [editingFilter, setEditingFilter] = useState(false);
	const [savingTag, setSavingTag] = useState(false);
	const [tagName, setTagName] = useState("");
	const rowRef = useRef<HTMLDivElement>(null);
	const drag = useDragState();
	const isDragging = drag?.key === selection.key;
	const isDropTarget = drag != null && drag.key !== selection.key;
	const handleColorChange = useDebouncedCallback(
		useCallback(
			(c: RGB) => {
				setSelectionColors([{ key: selection.key, color: [c.r, c.g, c.b] }]);
			},
			[selection.key],
		),
		60,
		{ flush: true },
	);

	const fieldEntries = useExtraFieldKeys();

	if (!map) return null;
	const inner = selection.props.type === "Invert" ? selection.props.selections[0] : selection;
	const stepFilter = (() => {
		const p = selection.props;
		if (p.type !== "Filter") return null;
		const ft = fieldEntries.find((f) => f.key === p.field)?.def.type;
		const wallClock = p.tzLocal ?? false;
		if (stepFilterWindow(ft, p.op, p.value, p.value2, 1, wallClock) == null) return null;
		return (dir: 1 | -1) => {
			const next = stepFilterWindow(ft, p.op, p.value, p.value2, dir, wallClock);
			if (next) {
				updateFilterSelection(selection.key, {
					type: "Filter",
					field: p.field,
					op: p.op,
					tzLocal: p.tzLocal,
					value: next.value,
					value2: next.value2,
				});
			}
		};
	})();
	const showChildren = inner.props.type === "Intersection" || inner.props.type === "Union";
	const isPoly = selection.props.type === "Polygon";
	const colorBlockCss =
		inner.props.type === "Tag"
			? (map.meta.tags[inner.props.tagId]?.color ?? rgbCss(selection.color))
			: rgbCss(selection.color);

	const handleRename = () => {
		if (selection.props.type !== "Polygon") return;
		const current = selection.props.polygon.properties?.name ?? "";
		const next = window.prompt("Polygon name", current);
		if (next != null) setPolygonName(selection.key, next);
	};

	const handleSaveAsTag = async () => {
		const name = tagName.trim();
		if (!name) return;
		const ids = await cmd.storeResolveSelection(selection.props);
		if (ids.length === 0) return;
		const [tag] = await createTags([name]);
		await addTagToLocations(tag.id, ids);
		setSavingTag(false);
		setTagName("");
	};

	const handleDownloadGeoJSON = () => {
		if (selection.props.type !== "Polygon") return;
		const poly = selection.props.polygon;
		const name = poly.properties?.name ?? "polygon";
		const fc = {
			type: "Feature",
			properties: poly.properties ?? {},
			geometry: { type: "Polygon", coordinates: poly.coordinates },
		};
		const blob = new Blob([JSON.stringify(fc)], { type: "application/geo+json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${name}.geojson`;
		a.click();
		URL.revokeObjectURL(url);
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

		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keyup", onKeyUp);
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

		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKeyUp);
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
						if (host && map) fitSelectionBounds(host, selection);
					}}
				>
					<span className="color-block" style={{ backgroundColor: colorBlockCss }} />{" "}
					{selectionDisplayName(selection)}
				</span>
				{isDropTarget && dropZone === "on" && (
					<span className="selection-row__drop-hint">{drag?.altKey ? "OR" : "AND"}</span>
				)}
				<span className="selection-row__size">{fmt.format(count)}</span>
				<span className="selection-row__actions">
					{stepFilter && (
						<>
							<button
								className="icon-button"
								type="button"
								aria-label="Previous period"
								onClick={() => stepFilter(-1)}
							>
								<Icon path={mdiChevronLeft} size={18} />
							</button>
							<button
								className="icon-button"
								type="button"
								aria-label="Next period"
								onClick={() => stepFilter(1)}
							>
								<Icon path={mdiChevronRight} size={18} />
							</button>
						</>
					)}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							<button className="icon-button" type="button" aria-label="Selection options">
								<Icon path={mdiDotsVertical} />
							</button>
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								className="context-menu"
								align="end"
								onCloseAutoFocus={() => setView("contextmenu")}
							>
								{view === "color" ? (
									<div style={{ padding: "0.5rem", width: "14rem" }}>
										<RgbColorPicker
											color={{
												r: selection.color[0],
												g: selection.color[1],
												b: selection.color[2],
											}}
											onChange={handleColorChange}
										/>
									</div>
								) : (
									<>
										<DropdownMenu.Item
											className="context-menu__item"
											onSelect={() => selectInverse([selection.key])}
										>
											Invert selection
										</DropdownMenu.Item>
										{selection.props.type === "Filter" && (
											<DropdownMenu.Item
												className="context-menu__item"
												onSelect={() => setEditingFilter(true)}
											>
												Edit filter
											</DropdownMenu.Item>
										)}
										<DropdownMenu.Item
											className="context-menu__item"
											disabled={count === 0}
											onSelect={async () => {
												const ids = await cmd.storeResolveSelection(selection.props);
												beginReview(ids, selection);
											}}
										>
											Review selection
										</DropdownMenu.Item>
										{selection.props.type !== "Tag" && (
											<DropdownMenu.Item
												className="context-menu__item"
												disabled={count === 0}
												onSelect={() => {
													const names = new Set(getVisibleTags().map((t) => t.name));
													setTagName(uniqueTagName(selectionDisplayName(selection), names));
													setSavingTag(true);
												}}
											>
												Save as tag
											</DropdownMenu.Item>
										)}
										{pruneDistance(selection) != null && (
											<DropdownMenu.Item
												className="context-menu__item"
												disabled={count === 0}
												onSelect={async () => {
													const n = await pruneDuplicates(
														selection.props,
														pruneDistance(selection)!,
													);
													toast(`Pruned ${fmt.format(n)} duplicate${n === 1 ? "" : "s"}`);
												}}
											>
												Prune duplicates
											</DropdownMenu.Item>
										)}
										{selection.props.type !== "Tag" && (
											<DropdownMenu.Item
												className="context-menu__item"
												onSelect={(e) => {
													e.preventDefault();
													setView("color");
												}}
											>
												Change color
											</DropdownMenu.Item>
										)}
										{isPoly && (
											<>
												<DropdownMenu.Separator
													style={{ height: 1, background: "#0000001a", margin: "4px 0" }}
												/>
												<DropdownMenu.Item
													className="context-menu__item"
													onSelect={handleDownloadGeoJSON}
												>
													Download GeoJSON
												</DropdownMenu.Item>
												<DropdownMenu.Item className="context-menu__item" onSelect={handleRename}>
													Rename
												</DropdownMenu.Item>
											</>
										)}
										{onRemove && (
											<>
												<DropdownMenu.Separator
													style={{ height: 1, background: "#0000001a", margin: "4px 0" }}
												/>
												<DropdownMenu.Item className="context-menu__item" onSelect={onRemove}>
													Deselect
												</DropdownMenu.Item>
											</>
										)}
									</>
								)}
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
					{isTopLevel && (
						<button
							className="icon-button"
							type="button"
							aria-label={ghosted ? "Un-ghost selection" : "Ghost selection"}
							title="Ghost selection (Alt-click to isolate)"
							onClick={(e) =>
								e.altKey ? isolateSelection(selection.key) : toggleGhostSelection(selection.key)
							}
						>
							<Icon path={ghosted ? mdiGhost : mdiGhostOutline} />
						</button>
					)}
					{onRemove && (
						<button className="icon-button" type="button" onClick={onRemove} aria-label="Deselect">
							<Icon path={mdiClose} />
						</button>
					)}
				</span>
			</div>
			{editingFilter && selection.props.type === "Filter" && (
				<FilterForm
					initial={filterPropsToSeed(selection.props)}
					submitLabel="Update filter"
					onSubmit={(field, op, value, value2, tzLocal) =>
						updateFilterSelection(selection.key, {
							type: "Filter",
							field,
							op,
							value,
							value2,
							tzLocal,
						})
					}
					onClose={() => setEditingFilter(false)}
				/>
			)}
			<Dialog
				open={savingTag}
				onOpenChange={(v) => {
					setSavingTag(v);
					if (!v) setTagName("");
				}}
			>
				<DialogContent title="Save selection as tag">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleSaveAsTag();
						}}
						style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
					>
						<input
							className="input"
							value={tagName}
							onChange={(e) => setTagName(e.target.value)}
							onFocus={(e) => e.currentTarget.select()}
							placeholder="Tag name..."
							autoFocus
						/>
						<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
							<button
								className="button"
								type="button"
								onClick={() => {
									setSavingTag(false);
									setTagName("");
								}}
							>
								Cancel
							</button>
							<button className="button button--primary" type="submit" disabled={!tagName.trim()}>
								Create tag
							</button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
			{showChildren &&
				(
					inner.props as Extract<Selection["props"], { type: "Intersection" | "Union" }>
				).selections.map((child) => (
					<SelectionRow
						key={child.key}
						selection={child}
						depth={depth + 1}
						parentKey={selection.key}
						inheritedGhost={ghosted}
						onRemove={() => removeChildFromSelection(selection.key, child.key)}
					/>
				))}
		</>
	);
}
