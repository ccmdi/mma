import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DatePicker } from "@/components/primitives/DatePicker";
import {
	useCurrentMap,
	useSelectedLocationIds,
	useSelections,
	removeLocations,
	removeSelections,
	resetSelections,
	selectIntersection,
	selectUnion,
	selectInverse,
	selectUntagged,
	selectUnpanned,
	selectPanoIds,
	selectNotPanoIds,
	setPolygonName,
	setSelectionColors,
	addTagToLocations,
	createTags,
	selectDuplicates,
	selectFilter,
	reorderSelection,
	composeSelections,
	decomposeChild,
	removeChildFromSelection,
	updateTags,
	getVisibleTags,
	useKnownFieldKeys,
	toggleGhostSelection,
	useGhostedSelections,
	updateFilterSelection,
	pruneDuplicates,
} from "@/store/useMapStore";
import { toast } from "@/lib/util/toast";
import { getFieldDef } from "@/lib/data/fieldDefRegistry";
import { groupByField, projectionsForType, pickPeriodEnd, hasTimeOfDay, stepFilterWindow, dateParts, partsToEpoch } from "@/lib/data/fieldOps";
import { useSetting } from "@/store/settings";
import { cmd } from "@/lib/commands";

import { RgbColorPicker } from "react-colorful";
import type { Selection, FilterOp, ExtraFieldDef } from "@/bindings.gen";
import { selectionDisplayName, OP_LABELS } from "@/store/selections";
import { TagManager } from "@/components/editor/TagManager";
import { MergeDuplicatesModal } from "@/components/dialogs/MergeDuplicatesModal";
import { ReviewSessionsModal } from "@/components/dialogs/ReviewSessions";
import { beginReview } from "@/lib/review/review";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { ToolBlock } from "@/components/primitives/ToolBlock";
import { Icon } from "@/components/primitives/Icon";
import { mdiClose, mdiChevronLeft, mdiChevronRight, mdiDotsVertical, mdiArrowRight, mdiArrowLeft } from "@mdi/js";
import { PluginToolbar } from "@/plugins/PluginPanels";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { fmt } from "@/lib/util/format";
import { rgbCss, textColorFor } from "@/lib/util/color";
import { getGoogleMap as getGoogleMapInstance } from "@/lib/map/mapState";
import { loadGeoJSON } from "@/lib/util/loadGeoJSON";

async function fitSelectionBounds(map: google.maps.Map, selection: Selection) {
	if (selection.props.type === "Polygon") {
		const coords = selection.props.polygon.coordinates.flat();
		if (coords.length === 0) return;
		const bounds = new google.maps.LatLngBounds();
		for (const [lng, lat] of coords) bounds.extend({ lat, lng });
		map.fitBounds(bounds, 100);
		return;
	}
	if ((selection.count ?? 0) === 0) return;
	const ids = await cmd.storeResolveSelection(selection.props);
	const { fetchLocationsByIds } = await import("@/store/useMapStore");
	const locs = await fetchLocationsByIds(ids);
	const bounds = new google.maps.LatLngBounds();
	for (const loc of locs) bounds.extend({ lat: loc.lat, lng: loc.lng });
	map.fitBounds(bounds, 100);
}

function uniqueTagName(base: string, existing: Set<string>): string {
	if (!existing.has(base)) return base;
	for (let i = 1; ; i++) {
		const candidate = `${base} (${i})`;
		if (!existing.has(candidate)) return candidate;
	}
}

// Distance for "Prune duplicates": on a Duplicates selection directly, or an
// Intersection containing one (prune then runs on the intersection's resolved
// locations).
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

function ApplyFieldAsTagsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const [field, setField] = useState("");
	const [projectionId, setProjectionId] = useState("");
	const [width, setWidth] = useState("");
	const [tzLocal, setTzLocal] = useState(false);
	const keys = useKnownFieldKeys();
	const fields = useMemo(() => {
		const entries: { key: string; label: string; type: ExtraFieldDef["type"] }[] = [];
		for (const key of keys) {
			const def = getFieldDef(key);
			entries.push({ key, label: def?.label ?? key, type: def?.type ?? "string" });
		}
		return entries;
	}, [keys]);

	const fieldType = fields.find((f) => f.key === field)?.type ?? "string";
	const projections = projectionsForType(fieldType);
	const projection = projections.find((p) => p.id === projectionId) ?? projections[0];
	const showTz = projection?.needsTz === true && fieldType === "date";
	const showWidth = projection?.needsWidth === true;
	const widthValid = !showWidth || Number(width) > 0;

	const handleFieldChange = (key: string) => {
		setField(key);
		const type = fields.find((f) => f.key === key)?.type ?? "string";
		setProjectionId(projectionsForType(type)[0]?.id ?? "");
		setWidth("");
		setTzLocal(false);
	};

	const handleApply = async () => {
		if (!field || !projection || !widthValid) return;
		const { fetchLocationsByIds, createTags, batchUpdateLocations } = await import(
			"@/store/useMapStore"
		);
		const ids = await cmd.storeResolveSelection({ type: "Everything" });
		if (ids.length === 0) return;
		const locs = await fetchLocationsByIds(ids);
		const groups = groupByField(locs, field, (v, loc) =>
			projection.key(v, { fieldType, loc, tzLocal, width: Number(width) }),
		);
		if (groups.size === 0) return;
		const created = await createTags([...groups.keys()]);
		const tagIdByName = new Map(created.map((t) => [t.name.toLowerCase(), t.id]));
		const locById = new Map(locs.map((l) => [l.id, l]));
		const updates: { id: number; patch: { tags: number[] } }[] = [];
		for (const [name, locIds] of groups) {
			const tagId = tagIdByName.get(name.toLowerCase());
			if (tagId == null) continue;
			for (const id of locIds) {
				const l = locById.get(id);
				if (l && !l.tags.includes(tagId)) updates.push({ id, patch: { tags: [...l.tags, tagId] } });
			}
		}
		if (updates.length > 0) await batchUpdateLocations(updates);
		onOpenChange(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				onOpenChange(v);
				if (!v) {
					setField("");
					setProjectionId("");
					setWidth("");
					setTzLocal(false);
				}
			}}
		>
			<DialogContent title="Apply metadata as tags">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleApply();
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
				>
					<select
						className="input"
						value={field}
						onChange={(e) => handleFieldChange(e.target.value)}
						autoFocus
					>
						<option value="">Select a field...</option>
						{fields.map((f) => (
							<option key={f.key} value={f.key}>
								{f.label}
							</option>
						))}
					</select>
					{field && projections.length > 1 && (
						<select
							className="input"
							value={projection?.id ?? ""}
							onChange={(e) => setProjectionId(e.target.value)}
						>
							{projections.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
					)}
					{showWidth && (
						<input
							className="input"
							type="number"
							min="0"
							value={width}
							onChange={(e) => setWidth(e.target.value)}
							placeholder="Bucket width..."
						/>
					)}
					{showTz && (
						<label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
							<input
								type="checkbox"
								checked={tzLocal}
								onChange={(e) => setTzLocal(e.target.checked)}
							/>
							Location timezone
						</label>
					)}
					<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
						<button className="button" type="button" onClick={() => onOpenChange(false)}>
							Cancel
						</button>
						<button
							className="button button--primary"
							type="submit"
							disabled={!field || !widthValid}
						>
							Apply
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function SelectionRow({
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
	const handleColorChange = useCallback(
		(c: { r: number; g: number; b: number }) => {
			setSelectionColors([{ key: selection.key, color: [c.r, c.g, c.b] }]);
		},
		[selection.key],
	);

	const fieldEntries = useExtraFieldKeys();

	if (!map) return null;
	const inner = selection.props.type === "Invert" ? selection.props.selections[0] : selection;
	// Window filters (between on date/month/number) step inline by their own span.
	const stepFilter = (() => {
		const p = selection.props;
		if (p.type !== "Filter") return null;
		const ft = fieldEntries.find((f) => f.key === p.field)?.fieldType;
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
						const gMap = getGoogleMapInstance();
						if (gMap && map) fitSelectionBounds(gMap, selection);
					}}
				>
					<span className="color-block" style={{ backgroundColor: colorBlockCss }} />{" "}
					{selectionDisplayName(map, selection)}
				</span>
				{isDropTarget && dropZone === "on" && (
					<span className="selection-row__drop-hint">{drag?.altKey ? "OR" : "AND"}</span>
				)}
				<span className="selection-row__size">{fmt.format(selection.count ?? 0)}</span>
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
										{isTopLevel && (
											<DropdownMenu.Item
												className="context-menu__item"
												onSelect={() => toggleGhostSelection(selection.key)}
											>
												{ghosted ? "Un-ghost selection" : "Ghost selection"}
											</DropdownMenu.Item>
										)}
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
											disabled={(selection.count ?? 0) === 0}
											onSelect={async () => {
												const ids = await cmd.storeResolveSelection(selection.props);
												beginReview(ids, selection);
											}}
										>
											Review selection
										</DropdownMenu.Item>
										<DropdownMenu.Item
											className="context-menu__item"
											disabled={(selection.count ?? 0) === 0}
											onSelect={() => {
												const names = new Set(Object.values(map.meta.tags).map((t) => t.name));
												setTagName(uniqueTagName(selectionDisplayName(map, selection), names));
												setSavingTag(true);
											}}
										>
											Save as tag
										</DropdownMenu.Item>
										{pruneDistance(selection) != null && (
											<DropdownMenu.Item
												className="context-menu__item"
												disabled={(selection.count ?? 0) === 0}
												onSelect={async () => {
													const n = await pruneDuplicates(selection.props, pruneDistance(selection)!);
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
						updateFilterSelection(selection.key, { type: "Filter", field, op, value, value2, tzLocal })
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

const ALL_OPS: FilterOp[] = ["eq", "neq", "gt", "lt", "gte", "lte", "between", "has", "nothas"];
const EQUALITY_OPS: FilterOp[] = ["eq", "neq", "has", "nothas"];
// Exact dates are second-precision timestamps: eq/neq at stored precision is a trap
// (matches a single second). Day/minute queries are intervals -> the between family.
const DATE_OPS: FilterOp[] = ["between", "gt", "lt", "gte", "lte", "has", "nothas"];
const filterBuilderState = new Map<
	string,
	{ field: string; op: FilterOp; value: string; value2: string; anyYear?: boolean; anyTime?: boolean; tzLocal?: boolean }
>();

function opsForType(type: string | undefined): FilterOp[] {
	if (type === "enum") return EQUALITY_OPS;
	if (type === "date") return DATE_OPS;
	return ALL_OPS;
}

interface FieldEntry {
	key: string;
	label: string;
	fieldType: ExtraFieldDef["type"];
	fieldDef?: ExtraFieldDef;
}

const VIRTUAL_FIELDS: FieldEntry[] = [
	{ key: "createdAt", label: "Created", fieldType: "date" },
	{ key: "modifiedAt", label: "Modified", fieldType: "date" },
];

function useExtraFieldKeys(): FieldEntry[] {
	const keys = useKnownFieldKeys();
	return useMemo(() => {
		const entries: FieldEntry[] = [];
		for (const key of keys) {
			const def = getFieldDef(key);
			entries.push({
				key,
				label: def?.label ?? key,
				fieldType: def?.type ?? "string",
				fieldDef: def,
			});
		}
		for (const vf of VIRTUAL_FIELDS) {
			if (!keys.has(vf.key)) entries.push(vf);
		}
		return entries;
	}, [keys]);
}

const TIMEZONE_VALUES = Intl.supportedValuesOf("timeZone");

function useEnumValues(
	fieldKey: string | undefined,
	def: ExtraFieldDef | undefined,
	fieldType: string | undefined,
): string[] {
	const [values, setValues] = useState<string[]>([]);
	useEffect(() => {
		if (fieldType !== "enum" && fieldType !== undefined) {
			setValues([]);
			return;
		}
		if (def?.values) {
			setValues(def.values);
			return;
		}
		if (fieldKey === "timezone") {
			setValues(TIMEZONE_VALUES);
			return;
		}
		if (!fieldKey) {
			setValues([]);
			return;
		}
		cmd.storeExtraFieldValues(fieldKey).then(setValues);
	}, [fieldKey, def, fieldType]);
	return values;
}

function FilterValueInput({
	fieldEntry,
	value,
	onChange,
	placeholder,
	anyYear,
	onAnyYearToggle,
	showAnyYear,
	anyTime,
	onAnyTimeToggle,
	showAnyTime,
	tzLocal,
	onTzLocalToggle,
	showTzLocal,
	onYearSelect,
}: {
	fieldEntry: FieldEntry | undefined;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	anyYear?: boolean;
	onAnyYearToggle?: (v: boolean) => void;
	showAnyYear?: boolean;
	anyTime?: boolean;
	onAnyTimeToggle?: (v: boolean) => void;
	showAnyTime?: boolean;
	tzLocal?: boolean;
	onTzLocalToggle?: (v: boolean) => void;
	showTzLocal?: boolean;
	onYearSelect?: (year: number) => void;
}) {
	const type = fieldEntry?.fieldType;
	const def = fieldEntry?.fieldDef;
	const enumValues = useEnumValues(fieldEntry?.key, def, type);
	const exactDateFormat = useSetting("exactDateFormat");

	if (type === "enum") {
		return (
			<select className="nselect" value={value} onChange={(e) => onChange(e.target.value)}>
				<option value="">--</option>
				{enumValues.map((v) => (
					<option key={v} value={v}>
						{def?.labels?.[v] ?? v}
					</option>
				))}
			</select>
		);
	}

	if (type === "date" || type === "month") {
		return (
			<DatePicker
				mode={type}
				value={value}
				onChange={onChange}
				anyYear={anyYear}
				onAnyYearToggle={onAnyYearToggle}
				showAnyYear={showAnyYear}
				showTime={type === "date" && exactDateFormat === "datetime"}
				anyTime={anyTime}
				onAnyTimeToggle={onAnyTimeToggle}
				showAnyTime={showAnyTime}
				tzLocal={tzLocal}
				onTzLocalToggle={onTzLocalToggle}
				showTzLocal={showTzLocal}
				wallClock={tzLocal}
				onYearSelect={onYearSelect}
			/>
		);
	}

	if (type === "number") {
		return (
			<input
				className="input"
				type="number"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder ?? "Value"}
			/>
		);
	}

	return (
		<input
			className="input"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder ?? "Value"}
		/>
	);
}

type FilterFormSeed = {
	field: string;
	op: FilterOp;
	value: string;
	value2: string;
	anyYear?: boolean;
	anyTime?: boolean;
	tzLocal?: boolean;
};

/** Reverse of FilterForm.handleAdd: turn a stored Filter selection back into editable form state. */
function filterPropsToSeed(p: Extract<Selection["props"], { type: "Filter" }>): FilterFormSeed {
	let op = p.op as FilterOp;
	let anyYear = false;
	let anyTime = false;
	if (op === "between_anyyear") {
		op = "between";
		anyYear = true;
	} else if (op === "between_anytime") {
		op = "between";
		anyTime = true;
	}
	return {
		field: p.field,
		op,
		value: p.value == null ? "" : String(p.value),
		value2: p.value2 == null ? "" : String(p.value2),
		anyYear,
		anyTime,
		tzLocal: p.tzLocal ?? false,
	};
}

/** Shared field/op/value editor. `onSubmit` receives parsed pieces; create mode persists
 *  draft state under `persistKey`, edit mode seeds from `initial` and shows Cancel. */
function FilterForm({
	initial,
	persistKey,
	submitLabel,
	onSubmit,
	onClose,
}: {
	initial?: FilterFormSeed;
	persistKey?: string;
	submitLabel: string;
	onSubmit: (
		field: string,
		op: FilterOp,
		value: string | number | null,
		value2: string | number | undefined,
		tzLocal: boolean,
	) => void;
	onClose?: () => void;
}) {
	const fields = useExtraFieldKeys();
	const saved = initial ?? (persistKey ? filterBuilderState.get(persistKey) : undefined);
	const [field, setField] = useState(saved?.field ?? "");
	const [op, setOp] = useState<FilterOp>(saved?.op ?? "eq");
	const [value, setValue] = useState(saved?.value ?? "");
	const [value2, setValue2] = useState(saved?.value2 ?? "");
	const [anyYear, setAnyYear] = useState(saved?.anyYear ?? false);
	const [anyTime, setAnyTime] = useState(saved?.anyTime ?? false);
	const [tzLocal, setTzLocal] = useState(saved?.tzLocal ?? false);
	useEffect(() => {
		if (!field && fields.length > 0) setField(fields[0].key);
	}, [field, fields]);

	useEffect(() => {
		if (persistKey) filterBuilderState.set(persistKey, { field, op, value, value2, anyYear, anyTime, tzLocal });
	}, [persistKey, field, op, value, value2, anyYear, anyTime, tzLocal]);

	const fieldEntry = fields.find((f) => f.key === field);
	const isNumeric = fieldEntry?.fieldType === "number" || fieldEntry?.fieldType === "date";
	const isDateLike = fieldEntry?.fieldType === "date" || fieldEntry?.fieldType === "month";
	const isExactDate = fieldEntry?.fieldType === "date";
	const availableOps = opsForType(fieldEntry?.fieldType);
	const isBetween = op === "between" || op === "between_anyyear" || op === "between_anytime";
	// Persisted/legacy state can hold an op the field type no longer offers (e.g. eq on a date).
	useEffect(() => {
		if (fieldEntry && !availableOps.includes(op)) setOp(availableOps[0]);
	}, [fieldEntry, availableOps, op]);

	const handleFieldChange = (key: string) => {
		setField(key);
		const entry = fields.find((f) => f.key === key);
		const ops = opsForType(entry?.fieldType);
		if (!ops.includes(op)) setOp(ops[0]);
		setValue("");
		setValue2("");
		setAnyYear(false);
		setAnyTime(false);
		setTzLocal(false);
	};

	// tzLocal is an independent toggle: it survives op changes (the values' encoding
	// frame never silently flips) and composes with anyYear/anyTime.
	const handleOpChange = (newOp: FilterOp) => {
		setOp(newOp);
		if (newOp !== "between") {
			setAnyYear(false);
			setAnyTime(false);
		}
	};

	// Toggle wall-clock-in-location-timezone mode. The picker re-encodes between a
	// local-time instant (off) and a wall-clock-as-UTC instant (on); convert the
	// existing values so the displayed wall-clock numbers are preserved.
	const handleTzLocalToggle = (checked: boolean) => {
		setTzLocal(checked);
		// Re-encode epoch values between frames; anyYear/anyTime string values
		// ("MM-DD"/"HH:MM") pass through the NaN guard untouched.
		const convert = (v: string): string => {
			const n = Number(v);
			if (!v || isNaN(n)) return v;
			return String(partsToEpoch(dateParts(n, !checked), checked));
		};
		setValue(convert(value));
		setValue2(convert(value2));
	};

	const handleAnyYearToggle = (checked: boolean) => {
		setAnyYear(checked);
		if (checked) {
			setAnyTime(false);
			const convert = (v: string): string => {
				if (!v) return "";
				if (isExactDate) {
					const n = Number(v);
					if (!isNaN(n) && v !== "") {
						const p = dateParts(n, tzLocal);
						return `${String(p.mo + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
					}
				}
				const ym = /^\d{4}-(\d{2})$/.exec(v);
				if (ym) return ym[1];
				return v;
			};
			setValue(convert(value));
			setValue2(convert(value2));
		} else {
			const now = new Date();
			const yr = now.getFullYear();
			const convert = (v: string): string => {
				if (!v) return "";
				if (isExactDate) {
					const md = /^(\d{2})-(\d{2})$/.exec(v);
					if (md) {
						return String(partsToEpoch({ y: yr, mo: Number(md[1]) - 1, d: Number(md[2]) }, tzLocal));
					}
				}
				if (/^\d{2}$/.test(v)) return `${yr}-${v}`;
				return v;
			};
			setValue(convert(value));
			setValue2(convert(value2));
		}
	};

	const handleAnyTimeToggle = (checked: boolean) => {
		setAnyTime(checked);
		if (checked) {
			setAnyYear(false);
			const convert = (v: string): string => {
				if (!v) return "";
				const n = Number(v);
				if (!isNaN(n) && v !== "") {
					const p = dateParts(n, tzLocal);
					return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
				}
				return "";
			};
			setValue(convert(value));
			setValue2(convert(value2));
		} else {
			setValue("");
			setValue2("");
		}
	};

	const needsValue = op !== "has" && op !== "nothas";
	const toMonthDay = (v: string): string => {
		if (!v) return "";
		if (/^\d{2}-\d{2}$/.test(v)) return v;
		if (/^\d{2}$/.test(v)) return `${v}-01`;
		const n = Number(v);
		if (!isNaN(n) && v !== "") {
			const d = new Date(n * 1000);
			return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		}
		const ym = /^\d{4}-(\d{2})$/.exec(v);
		if (ym) return `${ym[1]}-01`;
		return v;
	};
	const handleAdd = () => {
		if (!field) return;
		if (needsValue && !value) return;
		let finalOp: FilterOp = op;
		if (isBetween && anyYear) finalOp = "between_anyyear";
		if (isBetween && anyTime) finalOp = "between_anytime";
		let parsed: string | number | null;
		let parsed2: string | number | undefined;
		if (anyYear && isBetween) {
			parsed = toMonthDay(value);
			parsed2 = toMonthDay(value2);
		} else if (anyTime && isBetween) {
			parsed = value;
			parsed2 = value2;
		} else {
			parsed = needsValue ? (isNumeric ? Number(value) : value) : null;
			parsed2 = isBetween ? (isNumeric ? Number(value2) : value2) : undefined;
		}
		if (
			isBetween &&
			!anyYear &&
			!anyTime &&
			isNumeric &&
			parsed != null &&
			parsed2 != null &&
			Number(parsed) > Number(parsed2)
		) {
			[parsed, parsed2] = [parsed2, parsed];
		}
		// A date pick denotes a period: midnight = the day, an explicit time = the minute.
		// Bounds that mean "through the end of the pick" expand to the period end.
		if (isExactDate && !anyYear && !anyTime) {
			const grain = (v: number): "day" | "minute" => (hasTimeOfDay(v, tzLocal) ? "minute" : "day");
			if (isBetween && typeof parsed2 === "number") {
				parsed2 = pickPeriodEnd(parsed2, grain(parsed2), tzLocal);
			} else if ((op === "gt" || op === "lte") && typeof parsed === "number") {
				parsed = pickPeriodEnd(parsed, grain(parsed), tzLocal);
			}
		}
		onSubmit(field, finalOp, parsed, parsed2, isExactDate && tzLocal);
		onClose?.();
	};

	const showAnyYear = isBetween && isDateLike;
	const showAnyTime = isBetween && isExactDate;
	const showTzLocal = isExactDate;

	const handleYearSelect = isBetween && fieldEntry?.fieldType === "month"
		? (year: number) => {
			setValue(`${year}-01`);
			setValue2(`${year}-12`);
		}
		: undefined;

	return (
		<div className="extra-filter-builder">
			<label>Filter by metadata:</label>
			<select className="nselect" value={field} onChange={(e) => handleFieldChange(e.target.value)}>
				{fields.length === 0 && <option value="">No metadata yet</option>}
				{fields.map((f) => (
					<option key={f.key} value={f.key}>
						{f.label}
					</option>
				))}
			</select>
			<select
				className="nselect"
				value={op}
				onChange={(e) => handleOpChange(e.target.value as FilterOp)}
			>
				{availableOps.map((o) => (
					<option key={o} value={o}>
						{OP_LABELS[o]}
					</option>
				))}
			</select>
			{needsValue && (
				<FilterValueInput
					fieldEntry={fieldEntry}
					value={value}
					onChange={setValue}
					anyYear={anyYear}
					onAnyYearToggle={handleAnyYearToggle}
					showAnyYear={showAnyYear}
					anyTime={anyTime}
					onAnyTimeToggle={handleAnyTimeToggle}
					showAnyTime={showAnyTime}
					tzLocal={tzLocal}
					onTzLocalToggle={handleTzLocalToggle}
					showTzLocal={showTzLocal}
					onYearSelect={handleYearSelect}
				/>
			)}
			{needsValue && isBetween && (
				<span className="extra-filter-builder__copy">
					<button
						type="button"
						title="Copy to max"
						disabled={!value}
						onClick={() => setValue2(value)}
					>
						<Icon path={mdiArrowRight} size={12} />
					</button>
					<button
						type="button"
						title="Copy to min"
						disabled={!value2}
						onClick={() => setValue(value2)}
					>
						<Icon path={mdiArrowLeft} size={12} />
					</button>
				</span>
			)}
			{isBetween && (
				<FilterValueInput
					fieldEntry={fieldEntry}
					value={value2}
					onChange={setValue2}
					placeholder="Max"
					anyYear={anyYear}
					anyTime={anyTime}
					tzLocal={tzLocal}
				/>
			)}
			<button className="button" type="button" onClick={handleAdd}>
				{submitLabel}
			</button>
			{onClose && (
				<button className="button" type="button" onClick={onClose}>
					Cancel
				</button>
			)}
		</div>
	);
}

function FilterBuilder({ mapId }: { mapId: string }) {
	return (
		<FilterForm
			persistKey={mapId}
			submitLabel="Add filter"
			onSubmit={(field, op, value, value2, tzLocal) => selectFilter(field, op, value, value2, tzLocal)}
		/>
	);
}

function TagFindReplaceDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const [find, setFind] = useState("");
	const [replace, setReplace] = useState("");
	const [applied, setApplied] = useState(false);

	const tags = getVisibleTags();
	const matches = find ? tags.filter((t) => t.name.toLowerCase().includes(find.toLowerCase())) : [];

	const handleApply = async () => {
		if (!find || matches.length === 0) return;
		const patches = matches.map((t) => ({
			id: t.id,
			patch: {
				name: t.name.replaceAll(
					new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
					replace,
				),
			},
		}));
		await updateTags(patches);
		setApplied(true);
	};

	const handleOpenChange = (v: boolean) => {
		if (!v) {
			setFind("");
			setReplace("");
			setApplied(false);
		}
		onOpenChange(v);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent title="Find and replace in tag names" className="tag-find-replace-modal">
				<div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}>
					<label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<span style={{ width: 60 }}>Find</span>
						<input
							className="input"
							style={{ flex: 1 }}
							value={find}
							onChange={(e) => {
								setFind(e.target.value);
								setApplied(false);
							}}
							placeholder="Text to find..."
							autoFocus
						/>
					</label>
					<label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<span style={{ width: 60 }}>Replace</span>
						<input
							className="input"
							style={{ flex: 1 }}
							value={replace}
							onChange={(e) => {
								setReplace(e.target.value);
								setApplied(false);
							}}
							placeholder="Replace with..."
						/>
					</label>
					{find && (
						<div>
							<p style={{ margin: "0 0 0.25rem", fontSize: "0.85rem", color: "#888" }}>
								{matches.length} tag{matches.length !== 1 ? "s" : ""} will be affected:
							</p>
							<ul
								style={{
									margin: 0,
									padding: 0,
									listStyle: "none",
									maxHeight: 320,
									overflowY: "auto",
									fontSize: "0.85rem",
								}}
							>
								{matches.map((t) => {
									const newName = t.name.replaceAll(
										new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
										replace,
									);
									return (
										<li
											key={t.id}
											style={{ padding: "1px 0", display: "flex", alignItems: "center", gap: 6 }}
										>
											<span
												className="tag is-small"
												style={{ backgroundColor: t.color, color: textColorFor(t.color) }}
											>
												<span className="tag__text">{t.name}</span>
											</span>
											<span style={{ opacity: 0.5 }}>&rarr;</span>
											<span
												className="tag is-small"
												style={{ backgroundColor: t.color, color: textColorFor(t.color) }}
											>
												<span className="tag__text">{newName}</span>
											</span>
										</li>
									);
								})}
							</ul>
						</div>
					)}
					<p style={{ margin: 0, fontSize: "0.8rem", color: "#e5a33e" }}>
						Tag renames cannot be undone.
					</p>
					<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
						<button className="button" type="button" onClick={() => handleOpenChange(false)}>
							{applied ? "Close" : "Cancel"}
						</button>
						{!applied && (
							<button
								className="button button--primary"
								type="button"
								disabled={!find || matches.length === 0}
								onClick={handleApply}
							>
								Replace {matches.length} tag{matches.length !== 1 ? "s" : ""}
							</button>
						)}
						{applied && (
							<span style={{ alignSelf: "center", color: "#2fcc8b", fontSize: "0.85rem" }}>
								Done!
							</span>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function MapOverview() {
	const map = useCurrentMap();
	const selected = useSelectedLocationIds();
	const selections = useSelections();
	const [bulkTagInput, setBulkTagInput] = useState("");
	const [selectionsCollapsed, setSelectionsCollapsed] = useState(false);
	const [dupDistance, setDupDistance] = useState(1);
	const [showTagFindReplace, setShowTagFindReplace] = useState(false);
	const [showMergeDuplicates, setShowMergeDuplicates] = useState(false);
	const [showReviews, setShowReviews] = useState(false);
	const [showApplyFieldAsTags, setShowApplyFieldAsTags] = useState(false);

	useEffect(() => {
		const handler = () => setShowTagFindReplace(true);
		document.addEventListener("open-tag-find-replace", handler);
		return () => document.removeEventListener("open-tag-find-replace", handler);
	}, []);

	useEffect(() => {
		const handler = () => setShowApplyFieldAsTags(true);
		document.addEventListener("open-apply-field-as-tags", handler);
		return () => document.removeEventListener("open-apply-field-as-tags", handler);
	}, []);

	if (!map) return null;

	const handleBulkAddTag = async (e: React.FormEvent) => {
		e.preventDefault();
		const name = bulkTagInput.trim();
		if (!name || selected.size === 0) return;
		const [resolved] = await createTags([name]);
		addTagToLocations(resolved.id, [...selected]);
		setBulkTagInput("");
	};

	const handleDeleteSelected = () => {
		if (selected.size === 0) return;
		removeLocations(selected);
	};

	const hasPolygon = selections.some((s) => s.props.type === "Polygon");

	const handleDownloadGeoJSON = () => {
		const features: unknown[] = [];
		for (const sel of selections) {
			if (sel.props.type !== "Polygon") continue;
			features.push({
				type: "Feature",
				properties: sel.props.polygon.properties ?? {},
				geometry: { type: "Polygon", coordinates: sel.props.polygon.coordinates },
			});
		}
		const fc = { type: "FeatureCollection", features };
		const blob = new Blob([JSON.stringify(fc)], { type: "application/geo+json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "selections.geojson";
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<section className="map-overview">
			<TagManager />

			<ToolBlock
				className="selection-manager"
				title="Selections"
				isCollapsed={selectionsCollapsed}
				onCollapse={setSelectionsCollapsed}
				collapsedAddons={<span>({fmt.format(selected.size)} locations selected)</span>}
				addons={
					<>
						<span>({fmt.format(selected.size)} locations selected)</span>
						<span className="selection-manager__space" />
						<button className="button" disabled={selections.length === 0} onClick={resetSelections}>
							Deselect all
						</button>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger asChild>
								<button className="button">More</button>
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content className="context-menu" align="end">
									<DropdownMenu.Item className="context-menu__item" onSelect={loadGeoJSON}>
										Load polygon selections from GeoJSON
									</DropdownMenu.Item>
									<DropdownMenu.Item
										className="context-menu__item"
										disabled={!hasPolygon}
										onSelect={handleDownloadGeoJSON}
									>
										Download polygon selections as GeoJSON
									</DropdownMenu.Item>
									<DropdownMenu.Item
										className="context-menu__item"
										disabled={selections.length < 2}
										onSelect={() => selectIntersection()}
									>
										AND all selections
									</DropdownMenu.Item>
									<DropdownMenu.Item
										className="context-menu__item"
										disabled={selections.length < 2}
										onSelect={() => selectUnion()}
									>
										OR all selections
									</DropdownMenu.Item>
									<DropdownMenu.Item
										className="context-menu__item"
										disabled={selections.length === 0}
										onSelect={() => selectInverse()}
									>
										Invert all selections
									</DropdownMenu.Item>
									<DropdownMenu.Sub>
										<DropdownMenu.SubTrigger className="context-menu__item">
											Select locations
											<span style={{ float: "right" }}>
												<Icon path={mdiChevronRight} />
											</span>
										</DropdownMenu.SubTrigger>
										<DropdownMenu.Portal>
											<DropdownMenu.SubContent
												className="context-menu"
												sideOffset={2}
												alignOffset={-6}
											>
												<DropdownMenu.Item
													className="context-menu__item"
													onSelect={() => selectUntagged()}
												>
													No tags
												</DropdownMenu.Item>
												<DropdownMenu.Item
													className="context-menu__item"
													onSelect={() => selectUnpanned()}
												>
													Panned north
												</DropdownMenu.Item>
												<DropdownMenu.Item
													className="context-menu__item"
													onSelect={() => selectPanoIds()}
												>
													Pano IDs
												</DropdownMenu.Item>
												<DropdownMenu.Item
													className="context-menu__item"
													onSelect={() => selectNotPanoIds()}
												>
													Not Pano IDs
												</DropdownMenu.Item>
											</DropdownMenu.SubContent>
										</DropdownMenu.Portal>
									</DropdownMenu.Sub>
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>
					</>
				}
			>
				{selections.length > 0 && (
					<div className="selection-manager__selections">
						{selections.map((sel) => (
							<SelectionRow
								key={sel.key}
								selection={sel}
								onRemove={() => removeSelections([sel.key])}
							/>
						))}
					</div>
				)}
				<div style={{ marginTop: ".5rem" }}>
					<button
						className="button button--destructive"
						type="button"
						disabled={selected.size === 0}
						onClick={handleDeleteSelected}
					>
						Delete selected locations
					</button>
					<button
						className="button"
						disabled={selected.size === 0}
						style={{ marginInlineStart: "1rem" }}
						onClick={() => beginReview(Array.from(selected))}
						data-qa="selection-review"
					>
						Review selected locations
					</button>
					<button
						className="button"
						style={{ marginInlineStart: "1rem" }}
						onClick={() => setShowReviews(true)}
						data-qa="open-reviews"
					>
						Reviews...
					</button>
					<form
						style={{ display: "inline-block", marginInline: "1rem" }}
						onSubmit={handleBulkAddTag}
					>
						<span className={`tag-input ${selected.size === 0 ? "is-disabled" : ""} has-button`}>
							<button
								type="submit"
								className="button tag-input__button"
								disabled={selected.size === 0}
							>
								+
							</button>
							<input
								className="tag-input__value"
								type="text"
								placeholder="Bulk-add a tag..."
								disabled={selected.size === 0}
								value={bulkTagInput}
								onChange={(e) => setBulkTagInput(e.target.value)}
							/>
						</span>
					</form>
				</div>
			</ToolBlock>

			<ToolBlock
				title="Tools"
				addons={
					<>
						<PluginToolbar />
						<span style={{ flexGrow: 1 }} />
						<button
							className="button"
							onClick={() => document.dispatchEvent(new CustomEvent("open-command-palette"))}
						>
							Commands...
						</button>
					</>
				}
			>
				<p>
					<label>
						Duplicate distance (metres):{" "}
						<input
							type="number"
							className="input"
							min="0"
							style={{ width: "6rem", marginRight: "1rem" }}
							value={dupDistance}
							onChange={(e) => setDupDistance(Number(e.target.value))}
						/>
					</label>
					<button className="button" type="button" onClick={() => selectDuplicates(dupDistance)}>
						Find duplicates
					</button>{" "}
					<button className="button" type="button" onClick={() => setShowMergeDuplicates(true)}>
						Merge duplicates
					</button>
				</p>
				<FilterBuilder key={map.meta.id} mapId={map.meta.id} />
			</ToolBlock>
			<TagFindReplaceDialog open={showTagFindReplace} onOpenChange={setShowTagFindReplace} />
			<ApplyFieldAsTagsDialog open={showApplyFieldAsTags} onOpenChange={setShowApplyFieldAsTags} />
			<MergeDuplicatesModal
				open={showMergeDuplicates}
				onOpenChange={setShowMergeDuplicates}
				distance={dupDistance}
			/>
			<ReviewSessionsModal open={showReviews} onOpenChange={setShowReviews} />
		</section>
	);
}
