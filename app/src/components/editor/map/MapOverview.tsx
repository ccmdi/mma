import { useState } from "react";
import { NSelect } from "@/components/primitives/NSelect";
import {
	useMapState,
	getMapState,
	addTagToLocations,
	createTags,
	addSelections,
	getVisibleTags,
	getActiveSelections,
	selectRandomFromSelection,
	selectSpacedFromSelection,
	currentSelection,
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
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { TextInput } from "@/components/primitives/TextInput";
import { PluginToolbar } from "@/plugins/PluginPanels";
import { fmt } from "@/lib/util/format";
import { useDialog, useDialogState, openDialog } from "@/store/dialogBus";
import { SelectionRow } from "./SelectionRow";
import { PinnedToolbar } from "./PinnedToolbar";
import { SaveSelectionsDialog, ApplySavedSelectionDialog } from "./SavedSelectionDialogs";
import { t } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";

/** Opt-in "run this pick once per active selection" switch, shown only when there are
 *  enough selections for it to mean anything. */
function PerSelectionToggle({
	value,
	onChange,
}: {
	value: boolean;
	onChange: (v: boolean) => void;
}) {
	const count = useMapState(() => getActiveSelections().length);
	if (count < 2) return null;
	return (
		<label className="selection-manager__inline-option">
			<Checkbox checked={value} onChange={(e) => onChange(e.target.checked)} />
			{t("from each of {n} selections", { n: count })}
		</label>
	);
}

function RandomPickPanel() {
	const [value, setValue] = useState("");
	const [perSelection, setPerSelection] = useState(false);
	const total = useMapState((s) => s.selectedLocationIds).size;
	const parsed = Math.floor(Number(value));
	const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
	const count = valid ? (perSelection ? parsed : Math.min(parsed, total)) : 0;
	return (
		<form
			className="selection-manager__inline-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (!valid) return;
				selectRandomFromSelection(count, perSelection)
					.then((picked) => {
						if (picked === 0) return;
						toast(
							perSelection
								? t(
										{
											one: "Selected {n} random location from each selection",
											other: "Selected {n} random locations from each selection",
										},
										{ n: picked },
									)
								: t(
										{
											one: "Selected {n} random location",
											other: "Selected {n} random locations",
										},
										{ n: picked },
									),
						);
					})
					.catch((err) => toast(String(err)));
			}}
		>
			<TextInput
				type="number"
				min={1}
				style={{ width: "7rem" }}
				placeholder={t("Count")}
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			<span style={{ opacity: 0.6 }}>{t("of {total}", { total: fmt.format(total) })}</span>
			<PerSelectionToggle value={perSelection} onChange={setPerSelection} />
			<Button type="submit" disabled={!valid}>
				{t("Pick")}
			</Button>
		</form>
	);
}

function SpacedPickPanel() {
	const [mode, setMode] = useState<"count" | "distance">("count");
	const [value, setValue] = useState("");
	const [perSelection, setPerSelection] = useState(false);
	const total = useMapState((s) => s.selectedLocationIds).size;
	const parsed = Math.floor(Number(value));
	const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!valid) return;
		const count = perSelection ? parsed : Math.min(parsed, total);
		const opts = mode === "count" ? { count } : { minDistanceM: parsed };
		selectSpacedFromSelection(opts, perSelection)
			.then(({ picked, distanceM }) => {
				if (picked === 0) return;
				const base = perSelection
					? t(
							{
								one: "Selected {n} location from each selection",
								other: "Selected {n} locations from each selection",
							},
							{ n: picked },
						)
					: t({ one: "Selected {n} location", other: "Selected {n} locations" }, { n: picked });
				const spacing =
					distanceM > 0
						? t(", at least {distance}m apart", { distance: fmt.format(distanceM) })
						: "";
				toast(base + spacing);
			})
			.catch((err) => toast(String(err)));
	};

	return (
		<form className="selection-manager__inline-form" onSubmit={handleSubmit}>
			<NSelect value={mode} onChange={(e) => setMode(e.target.value as "count" | "distance")}>
				<option value="count">{t("Count")}</option>
				<option value="distance">{t("Min distance (m)")}</option>
			</NSelect>
			<TextInput
				type="number"
				min={1}
				style={{ width: "7rem" }}
				placeholder={mode === "count" ? t("Count") : t("Meters")}
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			{mode === "count" && (
				<span style={{ opacity: 0.6 }}>{t("of {total}", { total: fmt.format(total) })}</span>
			)}
			<PerSelectionToggle value={perSelection} onChange={setPerSelection} />
			<Button type="submit" disabled={!valid}>
				{t("Pick")}
			</Button>
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
				void addSelections([{ type: "TopK", field, k: count, ascending }]);
			}}
		>
			<NSelect value={field} onChange={(e) => setField(e.target.value)}>
				{fields.map((f) => (
					<option key={f.key} value={f.key}>
						{t(f.label)}
					</option>
				))}
			</NSelect>
			<NSelect
				value={ascending ? "bottom" : "top"}
				onChange={(e) => setAscending(e.target.value === "bottom")}
			>
				<option value="top">{t("Top")}</option>
				<option value="bottom">{t("Bottom")}</option>
			</NSelect>
			<TextInput
				type="number"
				min={1}
				style={{ width: "5rem" }}
				value={count}
				onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
			/>
			<Button type="submit" disabled={!field}>
				{t("Select")}
			</Button>
		</form>
	);
}

function SelectedCount({ className }: { className?: string }) {
	const total = useMapState((s) => s.selectedLocationIds.size);
	return (
		<span className={className}>
			<Trans msg="{count} selected" count={<span className="mono">{fmt.format(total)}</span>} />
		</span>
	);
}

function SelectionList() {
	const selections = useMapState((s) => s.selections);
	if (selections.length === 0) return null;
	return (
		<div className="selection-manager__selections">
			{selections.map((sel) => (
				<SelectionRow key={sel.key} selection={sel} />
			))}
		</div>
	);
}

function BulkTagForm() {
	const [bulkTagInput, setBulkTagInput] = useState("");
	const hasSelection = useMapState((s) => s.selectedLocationIds.size > 0);
	const visibleTags = useMapState(getVisibleTags);
	const tagCounts = useMapState((s) => s.tagCounts);
	const tagSortMode = useSetting("tagSortMode");

	const handleBulkAddTag = async (e: React.FormEvent) => {
		e.preventDefault();
		const name = bulkTagInput.trim();
		const selected = getMapState().selectedLocationIds;
		if (!name || selected.size === 0) return;
		await createTags([name], currentSelection());
		setBulkTagInput("");
	};

	const bulkSuggestions = (() => {
		const all = sortTagsByMode(visibleTags, tagSortMode, tagCounts);
		const q = bulkTagInput.trim().toLowerCase();
		return (q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all).slice(0, 15);
	})();

	const handleBulkPick = (t: Tag) => {
		const selected = getMapState().selectedLocationIds;
		if (selected.size === 0) return;
		void addTagToLocations(t.id, [...selected]);
		setBulkTagInput("");
	};

	return (
		<form className="selection-manager__bulk-tag" onSubmit={(e) => void handleBulkAddTag(e)}>
			<span className="tag-input">
				<Button type="submit" className="tag-input__button" disabled={!hasSelection}>
					+
				</Button>
				<SuggestInput
					containerClassName="tag-input__suggest"
					inputClassName="tag-input__value"
					placeholder={t("Bulk-add tag...")}
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
	);
}

export function MapOverview({ hidden }: { hidden?: boolean }) {
	const map = useMapState((s) => s.map);
	const [selectionsCollapsed, setSelectionsCollapsed] = useState(false);
	const [dupDistance, setDupDistance] = useState(1);
	const [topKField, setTopKField] = useState("");
	const [topKCount, setTopKCount] = useState(10);
	const [topKAscending, setTopKAscending] = useState(false);
	const [showTagFindReplace, setShowTagFindReplace] = useDialogState("tag-find-replace");
	const [showMergeDuplicates, setShowMergeDuplicates] = useDialogState("merge-duplicates");
	const [showReviews, setShowReviews] = useDialogState("review-sessions");
	const [showApplyFieldAsTags, setShowApplyFieldAsTags] = useDialogState("apply-field-as-tags");
	const [showSaveSelections, setShowSaveSelections] = useDialogState("save-selections");
	const [showApplySaved, setShowApplySaved] = useDialogState("apply-saved-selection");
	const [saveSelName, setSaveSelName] = useState("");

	useDialog("review-selected", () => {
		const { selectedLocationIds, selections } = getMapState();
		if (selectedLocationIds.size === 0) return;
		const source = selections.length === 1 ? selections[0] : undefined;
		void beginReview(Array.from(selectedLocationIds), source);
	});

	if (!map) return null;

	return (
		<section className="map-overview" hidden={hidden}>
			<TagManager />

			<ToolBlock
				className="selection-manager"
				title={t("Selections")}
				isCollapsed={selectionsCollapsed}
				onCollapse={setSelectionsCollapsed}
				collapsedAddons={<SelectedCount />}
				addons={
					<>
						<SelectedCount className="selection-manager__count" />
						<span className="selection-manager__space" />
						<PluginToolbar />
						<Button onClick={() => openDialog("command-palette")}>{t("Commands...")}</Button>
					</>
				}
			>
				<SelectionList />

				<PinnedToolbar
					right={<BulkTagForm />}
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
										void addSelections([{ type: "Duplicates", distance: dupDistance }]);
									}}
								>
									<label>
										{t("Distance (m):")}{" "}
										<TextInput
											type="number"
											min="0"
											style={{ width: "5rem" }}
											value={dupDistance}
											onChange={(e) => setDupDistance(Number(e.target.value))}
										/>
									</label>
									<Button type="submit">{t("Find")}</Button>
									<Button onClick={() => setShowMergeDuplicates(true)}>{t("Merge")}</Button>
								</form>
							),
						},
						"filter-by-metadata": {
							render: () => (
								<FilterForm
									persistKey={map.meta.id}
									submitLabel={t("Add filter")}
									onSubmit={(field, op, value, value2, tzLocal) => {
										void addSelections([{ type: "Filter", field, op, value, value2, tzLocal }]);
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

			{showTagFindReplace && <TagFindReplaceDialog open onOpenChange={setShowTagFindReplace} />}
			{showApplyFieldAsTags && (
				<ApplyFieldAsTagsDialog open onOpenChange={setShowApplyFieldAsTags} />
			)}
			{showMergeDuplicates && (
				<MergeDuplicatesModal open onOpenChange={setShowMergeDuplicates} distance={dupDistance} />
			)}
			{showReviews && <ReviewSessionsModal open onOpenChange={setShowReviews} />}

			{showSaveSelections && (
				<SaveSelectionsDialog
					open
					onOpenChange={setShowSaveSelections}
					name={saveSelName}
					onNameChange={setSaveSelName}
				/>
			)}
			{showApplySaved && <ApplySavedSelectionDialog open onOpenChange={setShowApplySaved} />}
		</section>
	);
}
