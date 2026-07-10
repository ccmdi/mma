import { useState } from "react";
import { NSelect } from "@/components/primitives/NSelect";
import {
	useCurrentMap,
	useSelectedLocationIds,
	useAllSelections,
	removeSelections,
	addTagToLocations,
	createTags,
	selectDuplicates,
	useVisibleTags,
	useTagCounts,
	selectFilter,
	selectTopK,
	selectRandomFromSelection,
	selectSpacedFromSelection,
} from "@/store/useMapStore";
import { toast } from "@/lib/util/toast";
import { sortTagsByMode } from "@/lib/util/util";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { useSetting } from "@/store/settings";

import type { Tag } from "@/bindings.gen";
import { TagManager } from "@/components/editor/tags/TagManager";
import { FilterForm, useExtraFieldKeys } from "@/components/editor/map/FilterBuilder";
import { ApplyFieldAsTagsDialog } from "@/components/editor/tags/ApplyFieldAsTagsDialog";
import { TagFindReplaceDialog } from "@/components/editor/tags/TagFindReplaceDialog";
import { MergeDuplicatesModal } from "@/components/dialogs/MergeDuplicatesModal";
import { ReviewSessionsModal } from "@/components/dialogs/ReviewSessions";
import { beginReview } from "@/lib/review/review";
import { ToolBlock } from "@/components/primitives/ToolBlock";
import { PluginToolbar } from "@/plugins/PluginPanels";
import { fmt } from "@/lib/util/format";
import { useDomEvent } from "@/lib/hooks/useDomEvent";
import { SelectionRow } from "./SelectionRow";
import { PinnedToolbar } from "./PinnedToolbar";
import { SaveSelectionsDialog, ApplySavedSelectionDialog } from "./SavedSelectionDialogs";

function RandomPickPanel() {
	const [value, setValue] = useState("");
	const total = useSelectedLocationIds().size;
	const parsed = Math.floor(Number(value));
	const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
	const count = valid ? Math.min(parsed, total) : 0;
	return (
		<form
			className="selection-manager__inline-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (!valid) return;
				const picked = selectRandomFromSelection(count);
				if (picked > 0)
					toast(`Selected ${fmt.format(picked)} random location${picked !== 1 ? "s" : ""}`);
			}}
		>
			<input
				className="input"
				type="number"
				min={1}
				style={{ width: "7rem" }}
				placeholder="Count"
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			<span style={{ opacity: 0.6 }}>of {fmt.format(total)}</span>
			<button className="button" type="submit" disabled={!valid}>
				Pick
			</button>
		</form>
	);
}

function SpacedPickPanel() {
	const [mode, setMode] = useState<"count" | "distance">("count");
	const [value, setValue] = useState("");
	const total = useSelectedLocationIds().size;
	const parsed = Math.floor(Number(value));
	const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!valid) return;
		const opts = mode === "count" ? { count: Math.min(parsed, total) } : { minDistanceM: parsed };
		selectSpacedFromSelection(opts)
			.then(({ picked, distanceM }) => {
				if (picked === 0) return;
				const spacing = distanceM > 0 ? `, at least ${fmt.format(distanceM)}m apart` : "";
				toast(`Selected ${fmt.format(picked)} location${picked !== 1 ? "s" : ""}${spacing}`);
			})
			.catch((err) => toast(String(err)));
	};

	return (
		<form className="selection-manager__inline-form" onSubmit={handleSubmit}>
			<NSelect value={mode} onChange={(e) => setMode(e.target.value as "count" | "distance")}>
				<option value="count">Count</option>
				<option value="distance">Min distance</option>
			</NSelect>
			<input
				className="input"
				type="number"
				min={1}
				style={{ width: "7rem" }}
				placeholder={mode === "count" ? "Count" : "Meters"}
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			{mode === "count" && <span style={{ opacity: 0.6 }}>of {fmt.format(total)}</span>}
			<button className="button" type="submit" disabled={!valid}>
				Pick
			</button>
		</form>
	);
}

function TopKPanel({
	field: fieldProp,
	setField,
	count,
	setCount,
	ascending,
	setAscending,
}: {
	field: string;
	setField: (v: string) => void;
	count: number;
	setCount: (v: number) => void;
	ascending: boolean;
	setAscending: (v: boolean) => void;
}) {
	const fields = useExtraFieldKeys();
	const field = fieldProp || fields[0]?.key || "";
	return (
		<form
			className="selection-manager__inline-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (!field || count < 1) return;
				selectTopK(field, count, ascending);
			}}
		>
			<NSelect value={field} onChange={(e) => setField(e.target.value)}>
				{fields.map((f) => (
					<option key={f.key} value={f.key}>
						{f.label}
					</option>
				))}
			</NSelect>
			<NSelect
				value={ascending ? "bottom" : "top"}
				onChange={(e) => setAscending(e.target.value === "bottom")}
			>
				<option value="top">Top</option>
				<option value="bottom">Bottom</option>
			</NSelect>
			<input
				className="input"
				type="number"
				min={1}
				style={{ width: "5rem" }}
				value={count}
				onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
			/>
			<button className="button" type="submit" disabled={!field}>
				Select
			</button>
		</form>
	);
}

export function MapOverview({ hidden }: { hidden?: boolean }) {
	const map = useCurrentMap();
	const selected = useSelectedLocationIds();
	const selections = useAllSelections();
	const visibleTags = useVisibleTags();
	const tagCounts = useTagCounts();
	const [bulkTagInput, setBulkTagInput] = useState("");
	const tagSortMode = useSetting("tagSortMode");
	const [selectionsCollapsed, setSelectionsCollapsed] = useState(false);
	const [dupDistance, setDupDistance] = useState(1);
	const [topKField, setTopKField] = useState("");
	const [topKCount, setTopKCount] = useState(10);
	const [topKAscending, setTopKAscending] = useState(false);
	const [showTagFindReplace, setShowTagFindReplace] = useState(false);
	const [showMergeDuplicates, setShowMergeDuplicates] = useState(false);
	const [showReviews, setShowReviews] = useState(false);
	const [showApplyFieldAsTags, setShowApplyFieldAsTags] = useState(false);
	const [showSaveSelections, setShowSaveSelections] = useState(false);
	const [showApplySaved, setShowApplySaved] = useState(false);
	const [saveSelName, setSaveSelName] = useState("");

	useDomEvent("open-tag-find-replace", () => setShowTagFindReplace(true));
	useDomEvent("open-apply-field-as-tags", () => setShowApplyFieldAsTags(true));
	useDomEvent("open-merge-duplicates", () => setShowMergeDuplicates(true));
	useDomEvent("open-save-selections", () => setShowSaveSelections(true));
	useDomEvent("open-apply-saved-selection", () => setShowApplySaved(true));
	useDomEvent("open-review-sessions", () => setShowReviews(true));

	useDomEvent("open-review-selected", () => {
		if (selected.size === 0) return;
		const source = selections.length === 1 ? selections[0] : undefined;
		beginReview(Array.from(selected), source);
	});

	if (!map) return null;

	const handleBulkAddTag = async (e: React.FormEvent) => {
		e.preventDefault();
		const name = bulkTagInput.trim();
		if (!name || selected.size === 0) return;
		const [resolved] = await createTags([name]);
		addTagToLocations(resolved.id, [...selected]);
		setBulkTagInput("");
	};

	const bulkSuggestions = (() => {
		const all = sortTagsByMode(visibleTags, tagSortMode, tagCounts);
		const q = bulkTagInput.trim().toLowerCase();
		return (q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all).slice(0, 15);
	})();

	const handleBulkPick = (t: Tag) => {
		if (selected.size === 0) return;
		addTagToLocations(t.id, [...selected]);
		setBulkTagInput("");
	};

	const hasSelection = selected.size > 0;
	const hasSelections = selections.length > 0;

	return (
		<section className="map-overview" hidden={hidden}>
			<TagManager />

			<ToolBlock
				className="selection-manager"
				title="Selections"
				isCollapsed={selectionsCollapsed}
				onCollapse={setSelectionsCollapsed}
				collapsedAddons={<span>{fmt.format(selected.size)} selected</span>}
				addons={
					<>
						<span className="selection-manager__count">{fmt.format(selected.size)} selected</span>
						<span className="selection-manager__space" />
						<PluginToolbar />
						<button
							className="button"
							onClick={() => document.dispatchEvent(new CustomEvent("open-command-palette"))}
						>
							Commands...
						</button>
					</>
				}
			>
				{hasSelections && (
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

				<PinnedToolbar
					right={
						<form className="selection-manager__bulk-tag" onSubmit={handleBulkAddTag}>
							<span className={`tag-input has-button${!hasSelection ? " is-disabled" : ""}`}>
								<button type="submit" className="button tag-input__button" disabled={!hasSelection}>
									+
								</button>
								<SuggestInput
									containerClassName="tag-input__suggest"
									inputClassName="tag-input__value"
									placeholder="Bulk-add tag..."
									disabled={!hasSelection}
									value={bulkTagInput}
									onChange={setBulkTagInput}
									suggestions={bulkSuggestions}
									getKey={(t) => t.id}
									onPick={handleBulkPick}
									renderItem={(t) => t.name}
									pickOnEnter={false}
									listStyle={{ top: "100%", right: 0, zIndex: 10 }}
								/>
							</span>
						</form>
					}
					panels={{
						"select-random": {
							render: () => <RandomPickPanel />,
						},
						"select-spaced": {
							render: () => <SpacedPickPanel />,
						},
						"find-duplicates": {
							render: () => (
								<form
									className="selection-manager__inline-form"
									onSubmit={(e) => {
										e.preventDefault();
										selectDuplicates(dupDistance);
									}}
								>
									<label>
										Distance (m):{" "}
										<input
											type="number"
											className="input"
											min="0"
											style={{ width: "5rem" }}
											value={dupDistance}
											onChange={(e) => setDupDistance(Number(e.target.value))}
										/>
									</label>
									<button className="button" type="submit">
										Find
									</button>
									<button
										className="button"
										type="button"
										onClick={() => setShowMergeDuplicates(true)}
									>
										Merge
									</button>
								</form>
							),
						},
						"filter-by-metadata": {
							render: () => (
								<FilterForm
									persistKey={map.meta.id}
									submitLabel="Add filter"
									onSubmit={(field, op, value, value2, tzLocal) => {
										selectFilter(field, op, value, value2, tzLocal);
									}}
								/>
							),
						},
						"top-k": {
							render: () => (
								<TopKPanel
									field={topKField}
									setField={setTopKField}
									count={topKCount}
									setCount={setTopKCount}
									ascending={topKAscending}
									setAscending={setTopKAscending}
								/>
							),
						},
					}}
				/>
			</ToolBlock>

			<TagFindReplaceDialog open={showTagFindReplace} onOpenChange={setShowTagFindReplace} />
			<ApplyFieldAsTagsDialog open={showApplyFieldAsTags} onOpenChange={setShowApplyFieldAsTags} />
			<MergeDuplicatesModal
				open={showMergeDuplicates}
				onOpenChange={setShowMergeDuplicates}
				distance={dupDistance}
			/>
			<ReviewSessionsModal open={showReviews} onOpenChange={setShowReviews} />

			<SaveSelectionsDialog
				open={showSaveSelections}
				onOpenChange={setShowSaveSelections}
				name={saveSelName}
				onNameChange={setSaveSelName}
			/>
			<ApplySavedSelectionDialog open={showApplySaved} onOpenChange={setShowApplySaved} />
		</section>
	);
}
