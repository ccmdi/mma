/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useMemo } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { NSelect } from "@/components/primitives/NSelect";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Radio } from "@/components/primitives/Radio";
import { TextInput } from "@/components/primitives/TextInput";
import {
	applySelectionUpdate,
	applyFieldOp,
	countIn,
	fetchLocations,
	coverage,
	getMapState,
} from "@/store/useMapStore";
import { addSelection, batch as batchOp } from "@/store/selections";
import { useSelectorPick, type SelectorPickController } from "@/store/selectorPick";
import type { Selector, FieldOp } from "@/bindings.gen";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import {
	getFieldDef,
	fieldLabel,
	fieldValueLabel,
	getAllFieldDefs,
	isClearableField,
	isWritableField,
} from "@/lib/data/fieldDefRegistry";
import { cmd } from "@/lib/commands";
import { buildSelection } from "@/store/selections";
import { ValidationState } from "@/bindings.consts";
import { validateLocations } from "@/lib/sv/validate";
import { enrichAll, type EnrichOutcome } from "@/lib/sv/enrich";
import { getEnrichFieldOptions, getDefaultEnrichKeys, isFieldEnabled } from "@/lib/data/fieldDefs";
import { bulkPinToPano } from "@/lib/sv/pinPano";
import { bulkPanHeading, type RoadDirection } from "@/lib/sv/headingRoad";
import {
	bulkDownloadPanoramas,
	type BulkDownloadResult,
	type PanoRenderMode,
} from "@/lib/sv/panoDownload";
import { useAsync, useAsyncSticky } from "@/lib/hooks/useAsync";
import { saveExportTempFile } from "@/lib/util/tauri";
import { exprErrorText, fmt } from "@/lib/util/format";
import { phaseRate, type PhaseRate } from "@/lib/util/util";
import type { BatchOutcome, BulkOpts, ProviderPart } from "@/lib/data/procedures";
import { toast } from "@/lib/util/toast";
import { registerJob, type JobHandle } from "@/lib/jobs";
import { emit as emitEvent, useEventValue } from "@/lib/events";
import { openDialog } from "@/store/dialogBus";
import { t, msg } from "@/lib/i18n";

const TITLES = {
	validate: msg("Validate locations"),
	enrich: msg("Enrich metadata"),
	pinPano: msg("Pin to Pano ID"),
	clearFields: msg("Clear metadata fields"),
	setField: msg("Set metadata field"),
	headingRoad: msg("Pan headings along road"),
	downloadPanoramas: msg("Download panoramas"),
} as const;
export type BulkOperation = keyof typeof TITLES;

type BulkRunContext = { selector: Selector } & Required<BulkOpts>;

interface BulkRunResult {
	doneMessage?: string;
	/** What the run did, so one button can offer back the rows it could not work. */
	outcome?: BatchOutcome;
	doneContent?: React.ReactNode;
	/** Extra buttons rendered in the actions row next to Close when done. */
	doneActions?: React.ReactNode;
}

type BulkRunner = (ctx: BulkRunContext) => Promise<BulkRunResult>;

interface Props {
	operation: BulkOperation;
	onClose: () => void;
}

/** Everything the setup screens display about the current selector, read as projections --
 *  no location rows. */
interface TargetInfo {
	total: number;
	pinned: number;
	/** Selected rows holding a value for `key`. */
	have: (key: string) => number;
	/** Selected rows lacking one. */
	missing: (key: string) => number;
}

interface SetupProps {
	picker: SelectorPickController;
	info: TargetInfo;
	/** Every `extra` key present anywhere on the map, sorted. */
	fieldKeys: string[];
	onReady: (run: BulkRunner) => void;
}

async function readTargetInfo(selector: Selector): Promise<TargetInfo> {
	const narrowed = (...extra: Selector[]): Selector => ({
		type: "Intersection",
		selections: [selector, ...extra].map(buildSelection),
	});
	const [total, pinned, counts] = await Promise.all([
		countIn(selector),
		countIn(narrowed({ type: "PanoIds" })),
		coverage(selector),
	]);
	const have = new Map(counts);
	return {
		total,
		pinned,
		have: (key) => have.get(key) ?? 0,
		missing: (key) => total - (have.get(key) ?? 0),
	};
}

// ---------------------------------------------------------------------------
// Setup components — each produces a BulkRunner closure
// ---------------------------------------------------------------------------

function ValidateSetup({ picker, info, onReady }: SetupProps) {
	const [checkPinned, setCheckPinned] = useState(true);
	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			{info.pinned > 0 && (
				<label className="bulk-operation__option">
					<Checkbox checked={checkPinned} onChange={(e) => setCheckPinned(e.target.checked)} />

					{t("Check pinned locations for newer coverage")}
				</label>
			)}
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ selector, signal, onProgress }) => {
							const result = await validateLocations(selector, {
								signal,
								onProgress,
								config: { checkPinned },
							});
							const batch = Object.values(ValidationState)
								.filter((state) => (result.states.get(state)?.length ?? 0) > 0)
								.map((state) => ({
									type: "ValidationState" as const,
									locations: result.states.get(state)!,
									state,
								}));
							if (batch.length > 0) void applySelectionUpdate(batchOp(addSelection)(batch));
							const n = batch.reduce((total, b) => total + b.locations.length, 0);
							return {
								outcome: result,
								doneMessage: t(
									{
										one: "Done -- {n} location validated.",
										other: "Done -- {n} locations validated.",
									},
									{ n },
								),
							};
						})
					}
				>
					{t("Start")}
				</Button>
			</div>
		</div>
	);
}

function EnrichSetup({ picker, info, onReady }: SetupProps) {
	const [force, setForce] = useState(false);
	const map = getMapState().map;
	if (!map) return null;

	const enrichFields = map.settings.enrichFields ?? getDefaultEnrichKeys();
	const allOptions = getEnrichFieldOptions();
	const enabledFields = allOptions.filter((f) => isFieldEnabled(enrichFields, f.key));
	const total = info.total;
	const coverage = enabledFields.map((f) => ({
		key: f.key,
		label: f.label,
		have: info.have(f.key),
	}));
	const needsAny = coverage.some((c) => c.have < total);

	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			{enabledFields.length === 0 && (
				<div className="bulk-operation__status" style={{ opacity: 0.8 }}>
					{t(
						"No enrichment fields are enabled. Enable them in Map Settings under the Enrichment tab.",
					)}
				</div>
			)}
			{total > 0 && enabledFields.length > 0 && (
				<table className="bulk-operation__coverage">
					<tbody>
						{coverage.map((c) => {
							const missing = total - c.have;
							const pct = Math.round((c.have / total) * 100);
							return (
								<tr key={c.key} className={missing > 0 ? "is-incomplete" : ""}>
									<td className="bulk-operation__coverage-label">{t(c.label)}</td>
									<td className="bulk-operation__coverage-bar">
										<span className="bulk-operation__coverage-fill" style={{ width: `${pct}%` }} />
									</td>
									<td
										className={`bulk-operation__coverage-stat ${missing > 0 ? "is-incomplete" : "is-complete"}`}
									>
										{missing > 0 ? `${pct}%` : "100%"}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
			{info.missing("panoId") > 0 && (
				<div className="bulk-operation__status">
					{t(
						{
							one: "{n} without pano ID will be resolved from coordinates.",
							other: "{n} without pano ID will be resolved from coordinates.",
						},
						{ n: info.missing("panoId") },
					)}
				</div>
			)}
			<label className="bulk-operation__option">
				<Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />

				{t("Re-enrich already enriched locations")}
			</label>
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ selector, signal, onProgress }) => {
							const er = await enrichAll(selector, { signal, force, onProgress });
							return {
								doneContent: <EnrichSummary result={er} />,
							};
						})
					}
					disabled={enabledFields.length === 0 || (!force && !needsAny)}
				>
					{t("Start")}
				</Button>
			</div>
		</div>
	);
}

function PinPanoSetup({ picker, info, onReady }: SetupProps) {
	const [force, setForce] = useState(false);
	const [useLatest, setUseLatest] = useState(false);
	const unpinned = info.total - info.pinned;

	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			<div className="bulk-operation__status">
				{t(
					{
						one: "{n} location not pinned to a pano ID.",
						other: "{n} locations not pinned to a pano ID.",
					},
					{ n: unpinned },
				)}
			</div>
			<label className="bulk-operation__option">
				<Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />

				{t("Re-pin already pinned locations")}
			</label>
			<label className="bulk-operation__option">
				<Checkbox checked={useLatest} onChange={(e) => setUseLatest(e.target.checked)} />

				{t("Use latest timeline coverage")}
			</label>
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ selector, signal, onProgress }) => {
							const outcome = await bulkPinToPano(selector, {
								signal,
								force: force || useLatest,
								useLatest,
								onProgress,
							});
							return {
								outcome,
								doneMessage: t(
									{ one: "Done -- {n} location pinned.", other: "Done -- {n} locations pinned." },
									{ n: outcome.succeeded },
								),
							};
						})
					}
					disabled={!force && !useLatest && unpinned === 0}
				>
					{t("Start")}
				</Button>
			</div>
		</div>
	);
}

function ClearFieldsSetup({ info, fieldKeys, picker, onReady }: SetupProps) {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const clearable = fieldKeys.filter(isClearableField);

	const toggle = (key: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			{clearable.length === 0 ? (
				<div className="bulk-operation__status">{t("No metadata fields on this map.")}</div>
			) : (
				<div className="bulk-operation__field-list">
					{clearable.map((key) => {
						const def = getFieldDef(key);
						const count = info.have(key);
						return (
							<label key={key} className="bulk-operation__field-item">
								<Checkbox checked={selected.has(key)} onChange={() => toggle(key)} />
								<span className="bulk-operation__field-label">{fieldLabel(key)}</span>
								{def?.label && def.label !== key && (
									<span className="bulk-operation__field-key">{key}</span>
								)}
								<span className="bulk-operation__field-count">
									{count > 0
										? t({ one: "{n} value", other: "{n} values" }, { n: count })
										: t("no data")}
								</span>
							</label>
						);
					})}
				</div>
			)}
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() => {
						const keys = [...selected];
						onReady(async ({ selector }) => {
							const { changed, failed } = await applyFieldOp(
								selector,
								{ kind: "delete", keys },
								true,
							);
							return {
								outcome: { succeeded: changed, failed },
								doneMessage: t(
									{
										one: "Cleared fields from {n} location.",
										other: "Cleared fields from {n} locations.",
									},
									{ n: changed },
								),
							};
						});
					}}
					disabled={selected.size === 0}
				>
					{selected.size > 0
						? t({ one: "Clear {n} field", other: "Clear {n} fields" }, { n: selected.size })
						: t("Clear")}
				</Button>
			</div>
		</div>
	);
}

function SetFieldSetup({ fieldKeys, picker, onReady }: SetupProps) {
	const sortedKeys = useMemo(() => {
		const known = new Set<string>(Object.keys(getAllFieldDefs()).filter(isWritableField));
		for (const k of fieldKeys) if (isWritableField(k)) known.add(k);
		return [...known].sort();
	}, [fieldKeys]);

	const [key, setKey] = useState("");
	const [creatingNew, setCreatingNew] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [raw, setRaw] = useState("");

	const effectiveKey = (creatingNew ? newKey : key).trim();
	const def = effectiveKey ? getFieldDef(effectiveKey) : undefined;
	const isNumber = def?.type === "number";
	const enumValues = def?.type === "enum" ? def.values : null;
	const [exprError, setExprError] = useState<string | null>(null);
	useEffect(() => {
		if (!isNumber || raw.trim() === "") {
			setExprError(null);
			return;
		}
		let live = true;
		void cmd.fieldExprError(raw).then((err) => {
			if (live) setExprError(err && exprErrorText(err));
		});
		return () => {
			live = false;
		};
	}, [isNumber, raw]);
	const invalid = !effectiveKey || (isNumber && (raw.trim() === "" || exprError != null));

	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			<label className="bulk-operation__option">
				{t("Field")}
				<NSelect
					value={creatingNew ? "__new__" : key}
					onChange={(e) => {
						if (e.target.value === "__new__") {
							setCreatingNew(true);
						} else {
							setCreatingNew(false);
							setKey(e.target.value);
						}
					}}
				>
					<option value="" disabled>
						{t("Select a field...")}
					</option>
					{sortedKeys.map((k) => (
						<option key={k} value={k}>
							{fieldLabel(k)}
						</option>
					))}
					<option value="__new__">{t("New field...")}</option>
				</NSelect>
			</label>
			{creatingNew && (
				<label className="bulk-operation__option">
					{t("New field name")}
					<TextInput
						value={newKey}
						onChange={(e) => setNewKey(e.target.value)}
						placeholder={t("field name")}
						autoFocus
					/>
				</label>
			)}
			<label className="bulk-operation__option">
				{t("Value")}
				{enumValues ? (
					<NSelect value={raw} onChange={(e) => setRaw(e.target.value)}>
						<option value="" />
						{enumValues.map((v) => (
							<option key={v} value={v}>
								{fieldValueLabel(def, v)}
							</option>
						))}
					</NSelect>
				) : (
					<TextInput
						type="text"
						value={raw}
						onChange={(e) => setRaw(e.target.value)}
						placeholder={isNumber ? t("e.g. 45 or mod(sunAzimuth + 180, 360)") : undefined}
					/>
				)}
			</label>
			{isNumber && (
				<div className="bulk-operation__status">
					{exprError
						? t("Invalid expression: {error}", { error: exprError })
						: t("Constant or expression over fields (e.g. sunAzimuth, drivingDirection, lat).")}
				</div>
			)}
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					disabled={invalid}
					onClick={() => {
						const ek = effectiveKey;
						const rv = raw;
						const useExpr = isNumber;
						onReady(async ({ selector }) => {
							const op: FieldOp = useExpr
								? { kind: "expr", key: ek, expr: rv }
								: { kind: "set", key: ek, value: rv };
							const { changed, failed } = await applyFieldOp(selector, op, true);
							const message =
								t(
									{ one: "Set field on {n} location.", other: "Set field on {n} locations." },
									{ n: changed },
								) +
								(failed.length > 0
									? " " + t({ one: "{n} failed.", other: "{n} failed." }, { n: failed.length })
									: "");
							return { outcome: { succeeded: changed, failed }, doneMessage: message };
						});
					}}
				>
					{t("Set field")}
				</Button>
			</div>
		</div>
	);
}

function HeadingRoadSetup({ picker, onReady }: SetupProps) {
	const [direction, setDirection] = useState<RoadDirection>("forwards");

	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			<div className="bulk-operation__fieldset">
				<label>
					<Radio
						name="direction"
						checked={direction === "forwards"}
						onChange={() => setDirection("forwards")}
					/>

					{t("Forwards (along driving direction)")}
				</label>
				<label>
					<Radio
						name="direction"
						checked={direction === "backwards"}
						onChange={() => setDirection("backwards")}
					/>

					{t("Backwards")}
				</label>
			</div>
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ selector, signal, onProgress }) => {
							const outcome = await bulkPanHeading(selector, direction, { signal, onProgress });
							return {
								outcome,
								doneMessage: t(
									{ one: "Panned {n} heading.", other: "Panned {n} headings." },
									{ n: outcome.succeeded },
								),
							};
						})
					}
				>
					{t("Start")}
				</Button>
			</div>
		</div>
	);
}

function DownloadPanoramasSetup({ picker, info, onReady }: SetupProps) {
	const [mode, setMode] = useState<PanoRenderMode>("equirectangular");
	const [zoom, setZoom] = useState(5);
	const [tileX, setTileX] = useState(0);
	const [tileY, setTileY] = useState(0);

	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			{info.missing("panoId") > 0 && (
				<div className="bulk-operation__status">
					{t(
						{
							one: "{n} without pano ID will be resolved from coordinates.",
							other: "{n} without pano ID will be resolved from coordinates.",
						},
						{ n: info.missing("panoId") },
					)}
				</div>
			)}
			<label className="bulk-operation__option">
				{t("Mode")}
				<NSelect value={mode} onChange={(e) => setMode(e.target.value as PanoRenderMode)}>
					<option value="equirectangular">{t("Equirectangular (full panorama)")}</option>
					<option value="perspective">{t("Perspective (1920×1080)")}</option>
					<option value="thumbnail">{t("Thumbnail (1024×768)")}</option>
					<option value="tile">{t("Tile (512×512)")}</option>
				</NSelect>
			</label>
			{mode !== "thumbnail" && (
				<label className="bulk-operation__option">
					{t("Zoom level")}
					<NSelect
						style={{ width: 100 }}
						value={String(zoom)}
						onChange={(e) => setZoom(Number(e.target.value))}
					>
						{[1, 2, 3, 4, 5].map((z) => (
							<option key={z} value={z}>
								{z}
							</option>
						))}
					</NSelect>
				</label>
			)}
			{mode === "tile" && (
				<>
					<label className="bulk-operation__option">
						{t("Tile X")}
						<TextInput
							type="number"
							min={0}
							step={1}
							value={tileX}
							onChange={(e) => setTileX(Math.max(0, Number(e.target.value) || 0))}
							style={{ width: 100 }}
						/>
					</label>
					<label className="bulk-operation__option">
						{t("Tile Y")}
						<TextInput
							type="number"
							min={0}
							step={1}
							value={tileY}
							onChange={(e) => setTileY(Math.max(0, Number(e.target.value) || 0))}
							style={{ width: 100 }}
						/>
					</label>
				</>
			)}
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() => {
						const config = { mode, zoom, tileX, tileY };
						onReady(async ({ selector, signal, onProgress }) => {
							const locations = await fetchLocations(selector);
							const result = await bulkDownloadPanoramas(locations, config, {
								signal,
								onProgress,
							});
							// Prompt for the destination right away; the button below
							// only reappears as a retry if the dialog is cancelled.
							let saved = false;
							try {
								saved = await saveDownloadResult(result);
							} catch {
								toast(t("Save failed"));
							}
							return {
								outcome: result,
								doneMessage:
									t("Done -- {n} downloaded", { n: result.succeeded }) +
									(result.failed.length > 0
										? t(
												{ one: ", {n} failed.", other: ", {n} failed." },
												{ n: result.failed.length },
											)
										: "."),
								doneActions: <DownloadDoneActions result={result} initiallySaved={saved} />,
							};
						});
					}}
				>
					{t("Start")}
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Result display
// ---------------------------------------------------------------------------

/** Prompt for a destination and move the packaged download there. False = cancelled. */
async function saveDownloadResult(result: BulkDownloadResult): Promise<boolean> {
	if (!result.output) return false;
	const ok = (await saveExportTempFile(result.output.path, result.output.name)) !== null;
	if (ok) {
		toast(
			result.succeeded === 1
				? t("Panorama saved")
				: t(
						{ one: "Saved {n} panorama as ZIP", other: "Saved {n} panoramas as ZIP" },
						{ n: result.succeeded },
					),
		);
	}
	return ok;
}

function DownloadDoneActions({
	result,
	initiallySaved,
}: {
	result: BulkDownloadResult;
	initiallySaved: boolean;
}) {
	// storeSaveExportFile consumes the temp file, so a completed save is final.
	const [saved, setSaved] = useState(initiallySaved);

	const save = async () => {
		try {
			if (await saveDownloadResult(result)) setSaved(true);
		} catch {
			toast(t("Save failed"));
		}
	};

	return (
		<>
			{result.output != null && !saved && (
				<Button variant="primary" onClick={() => void save()}>
					{result.succeeded === 1 ? t("Save image") : t("Save ZIP")}
				</Button>
			)}
		</>
	);
}

export function SelectFailedButton({
	outcome,
	style,
}: {
	outcome: BatchOutcome;
	style?: React.CSSProperties;
}) {
	if (outcome.failed.length === 0) return null;
	return (
		<Button
			style={style}
			onClick={() => {
				void applySelectionUpdate(
					batchOp(addSelection)([{ type: "Manual", locations: outcome.failed }]),
				);
				toast(
					t(
						{ one: "Selected {n} failed location", other: "Selected {n} failed locations" },
						{ n: outcome.failed.length },
					),
				);
			}}
		>
			{t("Select failed")}
		</Button>
	);
}

function EnrichSummary({ result }: { result: EnrichOutcome[] }) {
	if (result.length === 0) {
		return (
			<div>
				<div>{t("Nothing to process.")}</div>
			</div>
		);
	}
	return (
		<div>
			{result.map((r) => (
				<div key={r.id}>
					{t(r.label)}
					{t(":")} {t({ one: "{n} updated", other: "{n} updated" }, { n: r.succeeded })}
					{r.failed.length > 0 &&
						t({ one: ", {n} failed", other: ", {n} failed" }, { n: r.failed.length })}
					<SelectFailedButton outcome={r} style={{ marginLeft: 8 }} />
				</div>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Run store — bulk runs live at module level so closing the dialog backgrounds
// them instead of aborting; the dialog re-attaches to the run for its operation.
// ---------------------------------------------------------------------------

type BulkRunStatus = "running" | "done" | "cancelled" | "error";

export interface BulkRunState {
	operation: BulkOperation;
	status: BulkRunStatus;
	progress: number;
	total: number;
	done: number;
	rate: number | null;
	elapsed: number | null;
	parts: ProviderPart[];
	providerRates: ReadonlyMap<string, number | null>;
	error: string | null;
	result: BulkRunResult;
	controller: AbortController;
	job: JobHandle;
	/** The dialog for this operation is showing the run. */
	attached: boolean;
}

let bulkRuns: ReadonlyMap<BulkOperation, BulkRunState> = new Map();

export function getBulkRuns(): ReadonlyMap<BulkOperation, BulkRunState> {
	return bulkRuns;
}

function patchRun(operation: BulkOperation, fields: Partial<BulkRunState>) {
	const cur = bulkRuns.get(operation);
	if (!cur) return;
	bulkRuns = new Map(bulkRuns).set(operation, { ...cur, ...fields });
	emitEvent("bulkruns:changed");
}

function dropRun(operation: BulkOperation) {
	if (!bulkRuns.has(operation)) return;
	const next = new Map(bulkRuns);
	next.delete(operation);
	bulkRuns = next;
	emitEvent("bulkruns:changed");
}

/** The run ended. Attached: the dialog shows the outcome and the run stays until it
 *  closes. Backgrounded: announce through the job tray and drop the run. */
function settleRun(operation: BulkOperation) {
	const run = bulkRuns.get(operation);
	if (!run) return;
	if (run.attached) {
		run.job.finish();
		return;
	}
	if (run.status === "error") run.job.fail(t("Error: {error}", { error: run.error ?? "" }));
	else if (run.status === "cancelled") run.job.finish();
	else {
		run.job.finish(
			run.result.doneMessage ??
				t(
					{ one: "Done -- {n} location processed", other: "Done -- {n} locations processed" },
					{ n: run.total },
				),
		);
	}
	dropRun(operation);
}

/** Dialog for `operation` mounted or unmounted its run view. Detaching from a finished
 *  run drops it — the outcome was on screen. */
function setRunAttached(operation: BulkOperation, attached: boolean) {
	const run = bulkRuns.get(operation);
	if (!run) return;
	run.job.setHidden(attached);
	if (!attached && run.status !== "running") dropRun(operation);
	else patchRun(operation, { attached });
}

// The run's selector is fixed at start: a live-selection selector changes when the run
// itself adds selections, and re-running on that would loop.
export function startBulkRun(operation: BulkOperation, runner: BulkRunner, target: Selector): void {
	if (bulkRuns.get(operation)?.status === "running") return;
	const controller = new AbortController();
	const job = registerJob(t(TITLES[operation]), {
		scope: "map",
		cancel: () => controller.abort(),
		reveal: () => openDialog("bulk-op", operation),
	});
	job.setHidden(true);
	bulkRuns = new Map(bulkRuns).set(operation, {
		operation,
		status: "running",
		progress: 0,
		total: 0,
		done: 0,
		rate: null,
		elapsed: null,
		parts: [],
		providerRates: new Map(),
		error: null,
		result: {},
		controller,
		job,
		attached: true,
	});
	emitEvent("bulkruns:changed");

	const runStart = performance.now();
	let rateState: PhaseRate | null = null;
	const providerRateStates = new Map<string, PhaseRate>();
	const onProgress: BulkRunContext["onProgress"] = (d, tot, providerParts) => {
		const now = performance.now();
		const overall = phaseRate(rateState, d, tot, now);
		rateState = overall.state;
		const rates = new Map<string, number | null>();
		for (const p of providerParts) {
			const r = phaseRate(providerRateStates.get(p.label) ?? null, p.done, p.total, now);
			providerRateStates.set(p.label, r.state);
			rates.set(p.label, r.rate);
		}
		const progress = tot > 0 ? d / tot : 1;
		patchRun(operation, {
			done: d,
			total: tot,
			parts: providerParts,
			progress,
			rate: overall.rate,
			providerRates: rates,
		});
		job.update(progress, `${fmt.format(d)} / ${fmt.format(tot)}`);
	};

	void (async () => {
		try {
			const r = await runner({ selector: target, signal: controller.signal, onProgress });
			patchRun(operation, {
				result: r,
				progress: 1,
				elapsed: (performance.now() - runStart) / 1000,
				status: "done",
			});
		} catch (e: unknown) {
			if (controller.signal.aborted) {
				patchRun(operation, { status: "cancelled" });
			} else {
				patchRun(operation, {
					error: e instanceof Error ? e.message : t("Operation failed"),
					status: "error",
				});
			}
		}
		settleRun(operation);
	})();
}

// ---------------------------------------------------------------------------
// Progress — shows the module-level run for this operation
// ---------------------------------------------------------------------------

export function BulkProgress({
	operation,
	onClose,
}: {
	operation: BulkOperation;
	onClose: () => void;
}) {
	const run = useEventValue("bulkruns:changed", getBulkRuns).get(operation);

	useEffect(() => {
		setRunAttached(operation, true);
		return () => setRunAttached(operation, false);
	}, [operation]);

	if (!run) return null;
	const { status, progress, total, done, rate, elapsed, parts, providerRates, error, result } =
		run;
	const pct = Math.round(progress * 100);

	return (
		<div className="bulk-operation">
			<div className="bulk-operation__status">
				{status === "running" && parts.length > 0 && (
					<div className="bulk-operation__providers">
						{parts.map((p) => {
							const waiting = !p.finished && p.done === 0 && p.total === 0;
							const running = !p.finished && !waiting;
							const provRate = providerRates.get(p.label);
							return (
								<div key={p.label} className="bulk-operation__provider">
									<span className="bulk-operation__provider-label">
										{t(p.label)}
										{running && provRate != null && (
											<span className="bulk-operation__provider-rate">
												{t("{rate}/s", { rate: fmt.format(Math.round(provRate)) })}
											</span>
										)}
									</span>
									<span className="bulk-operation__provider-count">
										{waiting && t("Waiting")}
										{running && `${fmt.format(p.done)}/${fmt.format(p.total)}`}
										{p.finished && t("Done")}
										{p.failed > 0 && (
											<>
												{" · "}
												<span className="bulk-operation__provider-failed">
													{t({ one: "{n} failed", other: "{n} failed" }, { n: p.failed })}
												</span>
											</>
										)}
									</span>
									<progress
										className="bulk-operation__provider-bar"
										value={p.total > 0 ? p.done / p.total : p.finished ? 1 : 0}
										max={1}
									/>
								</div>
							);
						})}
					</div>
				)}
				{status === "done" &&
					(result.doneContent ??
						result.doneMessage ??
						t(
							{
								one: "Done -- {n} location processed",
								other: "Done -- {n} locations processed",
							},
							{ n: total },
						) +
							(elapsed != null && elapsed > 0
								? t(" in {seconds}s ({rate}/s)", {
										seconds: elapsed.toFixed(1),
										rate: fmt.format(Math.round(total / elapsed)),
									})
								: "") +
							".")}
				{status === "cancelled" &&
					t("Cancelled at {done} / {total}.", {
						done: fmt.format(done),
						total: fmt.format(total),
					})}
				{status === "error" && t("Error: {error}", { error: error ?? "" })}
			</div>
			<progress className="bulk-operation__bar" value={progress} max={1} />
			<div className="bulk-operation__actions">
				{status === "running" ? (
					<>
						<span className="bulk-operation__meter">
							{t("{done} / {total} ({pct}%)", {
								done: fmt.format(done),
								total: fmt.format(total),
								pct,
							}) + (rate != null ? t(" -- {rate}/s", { rate: fmt.format(Math.round(rate)) }) : "")}
						</span>
						<Button variant="destructive" onClick={() => run.controller.abort()}>
							{t("Cancel")}
						</Button>
					</>
				) : (
					<>
						{status === "done" && result.doneActions}
						{status === "done" && result.outcome != null && (
							<SelectFailedButton outcome={result.outcome} />
						)}
						<Button
							variant="primary"
							onClick={() => {
								dropRun(operation);
								onClose();
							}}
						>
							{t("Close")}
						</Button>
					</>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

const SETUPS: Record<BulkOperation, React.ComponentType<SetupProps>> = {
	validate: ValidateSetup,
	enrich: EnrichSetup,
	pinPano: PinPanoSetup,
	clearFields: ClearFieldsSetup,
	setField: SetFieldSetup,
	headingRoad: HeadingRoadSetup,
	downloadPanoramas: DownloadPanoramasSetup,
};

export function BulkOperationModal({ operation, onClose }: Props) {
	const run = useEventValue("bulkruns:changed", getBulkRuns).get(operation);
	const picker = useSelectorPick();
	const { data: allKeys } = useAsync(() => coverage({ type: "Everything" }), []);
	const info = useAsyncSticky(() => readTargetInfo(picker.selector), [picker.selector]);

	if (!run && (allKeys === null || info === null)) return null;

	const onReady = (runner: BulkRunner) => startBulkRun(operation, runner, picker.selector);
	const Setup = SETUPS[operation];

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title={t(TITLES[operation])} className="bulk-operation-modal">
				{run ? (
					<BulkProgress operation={operation} onClose={onClose} />
				) : (
					<Setup
						picker={picker}
						info={info!}
						fieldKeys={allKeys!.map(([key]) => key)}
						onReady={onReady}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
