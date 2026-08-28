import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { NSelect } from "@/components/primitives/NSelect";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Radio } from "@/components/primitives/Radio";
import { TextInput } from "@/components/primitives/TextInput";
import {
	addSelections,
	applyFieldOp,
	countIn,
	fetchLocations,
	fieldCoverage,
	getMapState,
} from "@/store/useMapStore";
import { useSelectorPick, type SelectorPickController } from "@/store/selectorPick";
import type { Selector, FieldOp, FilterOp } from "@/bindings.gen";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import {
	getFieldDef,
	fieldLabel,
	fieldValueLabel,
	getAllFieldDefs,
	isWritableField,
} from "@/lib/data/fieldDefRegistry";
import { cmd } from "@/lib/commands";
import { buildSelection } from "@/store/selections";
import { ValidationState } from "@/bindings.consts";
import { validateLocations } from "@/lib/sv/validate";
import { enrichAll, type EnrichResult } from "@/lib/sv/enrich";
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
import { fmt } from "@/lib/util/format";
import { toast } from "@/lib/util/toast";
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

type ProgressFn = (done: number, total: number, label?: string) => void;

interface BulkRunContext {
	selector: Selector;
	signal: AbortSignal;
	onProgress: ProgressFn;
}

interface BulkRunResult {
	doneMessage?: string;
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
 *  no location rows. `coverage` maps an `extra` key to how many selected rows carry it. */
interface TargetInfo {
	total: number;
	noPano: number;
	pinned: number;
	coverage: Map<string, number>;
}

interface SetupProps {
	picker: SelectorPickController;
	info: TargetInfo;
	/** Every `extra` key present anywhere on the map, sorted. */
	fieldKeys: string[];
	onReady: (run: BulkRunner) => void;
}

async function readTargetInfo(selector: Selector): Promise<TargetInfo> {
	const panoFilter = (op: FilterOp): Selector => ({
		type: "Filter",
		field: "panoId",
		op,
		value: null,
	});
	const narrowed = (...extra: Selector[]): Selector => ({
		type: "Intersection",
		selections: [selector, ...extra].map(buildSelection),
	});
	const [total, noPano, pinned, coverage] = await Promise.all([
		countIn(selector),
		countIn(narrowed(panoFilter("nothas"))),
		// Pinned is a pano ID *and* the flag: the flag alone can outlive the id.
		countIn(narrowed(panoFilter("has"), { type: "PanoIds" })),
		fieldCoverage(selector),
	]);
	return { total, noPano, pinned, coverage: new Map(coverage) };
}

// ---------------------------------------------------------------------------
// Setup components — each produces a BulkRunner closure
// ---------------------------------------------------------------------------

function ValidateSetup({ picker, onReady }: SetupProps) {
	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ selector, signal, onProgress }) => {
							const results = await validateLocations(selector, { signal, onProgress });
							const stateOrder = [
								ValidationState.Ok,
								ValidationState.UpdateAvailable,
								ValidationState.UpdateApplied,
								ValidationState.GoodcamAvailable,
								ValidationState.PanoIdBroke,
								ValidationState.Unofficial,
								ValidationState.NotFound,
							];
							const batch = stateOrder
								.filter((state) => (results.get(state)?.length ?? 0) > 0)
								.map((state) => ({
									type: "ValidationState" as const,
									locations: results.get(state)!,
									state,
								}));
							if (batch.length > 0) void addSelections(batch);
							const n = batch.reduce((total, b) => total + b.locations.length, 0);
							return {
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
		have: info.coverage.get(f.key) ?? 0,
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
			{info.noPano > 0 && (
				<div className="bulk-operation__status">
					{t(
						{
							one: "{n} without pano ID will be resolved from coordinates.",
							other: "{n} without pano ID will be resolved from coordinates.",
						},
						{ n: info.noPano },
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
								doneContent: (
									<EnrichSummary
										result={er}
										onSelect={(ids) => void addSelections([{ type: "Manual", locations: ids }])}
									/>
								),
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
							const count = await bulkPinToPano(selector, {
								signal,
								force: force || useLatest,
								useLatest,
								onProgress,
							});
							return {
								doneMessage: t(
									{ one: "Done -- {n} location pinned.", other: "Done -- {n} locations pinned." },
									{ n: count },
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

	const toggle = (key: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const withData = (key: string) => info.coverage.get(key) ?? 0;

	return (
		<div className="bulk-operation">
			<SelectorPicker ctl={picker} />
			{fieldKeys.length === 0 ? (
				<div className="bulk-operation__status">{t("No metadata fields on this map.")}</div>
			) : (
				<div className="bulk-operation__field-list">
					{fieldKeys.map((key) => {
						const def = getFieldDef(key);
						const count = withData(key);
						return (
							<label key={key} className="bulk-operation__field-item">
								<Checkbox checked={selected.has(key)} onChange={() => toggle(key)} />
								<span className="bulk-operation__field-label">{t(fieldLabel(key))}</span>
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
							const { changed } = await applyFieldOp(selector, { kind: "delete", keys }, true);
							return {
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
		for (const k of fieldKeys) known.add(k);
		return [...known].sort();
	}, [fieldKeys]);

	const [key, setKey] = useState("");
	const [creatingNew, setCreatingNew] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [raw, setRaw] = useState("");

	const effectiveKey = (creatingNew ? newKey : key).trim();
	const def = effectiveKey ? getFieldDef(effectiveKey) : undefined;
	const isNumber = def?.type === "number";
	const isEnum = def?.type === "enum" && def.values;
	const [exprError, setExprError] = useState<string | null>(null);
	useEffect(() => {
		if (!isNumber || raw.trim() === "") {
			setExprError(null);
			return;
		}
		let live = true;
		void cmd.fieldExprError(raw).then((err) => {
			if (live) setExprError(err);
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
							{t(fieldLabel(k))}
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
				{isEnum ? (
					<NSelect value={raw} onChange={(e) => setRaw(e.target.value)}>
						<option value="" />
						{def!.values!.map((v) => (
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
							const { changed, skipped } = await applyFieldOp(selector, op, true);
							const message =
								t(
									{ one: "Set field on {n} location.", other: "Set field on {n} locations." },
									{ n: changed },
								) +
								(skipped > 0
									? " " + t("{n} skipped (missing source fields).", { n: skipped })
									: "");
							return { doneMessage: message };
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
							const count = await bulkPanHeading(selector, direction, { signal, onProgress });
							return {
								doneMessage: t(
									{ one: "Panned {n} heading.", other: "Panned {n} headings." },
									{ n: count },
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
			{info.noPano > 0 && (
				<div className="bulk-operation__status">
					{t(
						{
							one: "{n} without pano ID will be resolved from coordinates.",
							other: "{n} without pano ID will be resolved from coordinates.",
						},
						{ n: info.noPano },
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
								doneMessage:
									t("Done -- {n} downloaded", { n: result.succeeded.length }) +
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
	if (!result.outputPath || !result.suggestedName) return false;
	const ok = await saveExportTempFile(result.outputPath, result.suggestedName);
	if (ok) {
		toast(
			result.fileCount === 1
				? t("Panorama saved")
				: t(
						{ one: "Saved {n} panorama as ZIP", other: "Saved {n} panoramas as ZIP" },
						{ n: result.fileCount },
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
			{result.outputPath != null && !saved && (
				<Button variant="primary" onClick={() => void save()}>
					{result.fileCount === 1 ? t("Save image") : t("Save ZIP")}
				</Button>
			)}
			{result.failed.length > 0 && (
				<Button
					onClick={() => {
						void addSelections([{ type: "Manual", locations: result.failed }]);
						toast(
							t(
								{
									one: "Selected {n} failed location",
									other: "Selected {n} failed locations",
								},
								{ n: result.failed.length },
							),
						);
					}}
				>
					{t("Select failed")}
				</Button>
			)}
		</>
	);
}

function EnrichSummary({
	result,
	onSelect,
}: {
	result: EnrichResult;
	onSelect: (ids: number[], label: string) => void;
}) {
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
					{t(":")} {t({ one: "{n} updated", other: "{n} updated" }, { n: r.success })}
					{r.failed.length > 0 && (
						<>
							{t({ one: ", {n} failed", other: ", {n} failed" }, { n: r.failed.length })}
							<Button
								style={{ marginLeft: 8 }}
								onClick={() => onSelect(r.failed, t("{label} failed", { label: t(r.label) }))}
							>
								{t("Select failed")}
							</Button>
						</>
					)}
				</div>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Progress — runs the BulkRunner and shows progress/results
// ---------------------------------------------------------------------------

function BulkProgress({
	runner,
	selector,
	onClose,
}: {
	runner: BulkRunner;
	selector: Selector;
	onClose: () => void;
}) {
	const [progress, setProgress] = useState(0);
	const [total, setTotal] = useState(0);
	const [done, setDone] = useState(0);
	const [rate, setRate] = useState<number | null>(null);
	const [elapsed, setElapsed] = useState<number | null>(null);
	const [phaseLabel, setPhaseLabel] = useState<string | null>(null);
	const [status, setStatus] = useState<"running" | "done" | "cancelled" | "error">("running");
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<BulkRunResult>({});
	// The run's selector is fixed at start: a live-selection selector changes when the run
	// itself adds selections, and re-running on that would loop.
	const [target] = useState(selector);
	const controllerRef = useRef<AbortController | null>(null);
	const rateRef = useRef<{ t: number; done: number; ema: number | null }>({
		t: 0,
		done: 0,
		ema: null,
	});

	const run = useCallback(async () => {
		const controller = new AbortController();
		controllerRef.current = controller;

		const runStart = performance.now();
		rateRef.current = { t: runStart, done: 0, ema: null };
		setRate(null);
		setElapsed(null);

		const onProgress: ProgressFn = (d, t, label) => {
			setPhaseLabel(label ?? null);
			setTotal(t);
			setDone(d);
			setProgress(t > 0 ? d / t : 1);

			// Smoothed items/s. `d` resets between enrich waves; on a reset just
			// re-anchor rather than emit a negative spike.
			const now = performance.now();
			const prev = rateRef.current;
			const dd = d - prev.done;
			const dt = (now - prev.t) / 1000;
			if (dd < 0) {
				rateRef.current = { ...prev, t: now, done: d };
			} else if (dt >= 0.25 && dd > 0) {
				const inst = dd / dt;
				const ema = prev.ema == null ? inst : prev.ema * 0.7 + inst * 0.3;
				rateRef.current = { t: now, done: d, ema };
				setRate(ema);
			}
		};

		try {
			const r = await runner({ selector: target, signal: controller.signal, onProgress });
			setResult(r);
			setProgress(1);
			setElapsed((performance.now() - runStart) / 1000);
			setStatus("done");
		} catch (e: unknown) {
			if (e instanceof Error && e.name === "AbortError") {
				if (controllerRef.current === controller) setStatus("cancelled");
			} else {
				setError(e instanceof Error ? e.message : t("Operation failed"));
				setStatus("error");
			}
		}
	}, [runner, target]);

	useEffect(() => {
		void run();
		return () => {
			controllerRef.current?.abort();
		};
	}, [run]);

	const pct = Math.round(progress * 100);

	return (
		<div className="bulk-operation">
			<div className="bulk-operation__status">
				{status === "running" &&
					(phaseLabel ? `${t(phaseLabel)}${t(":")} ` : "") +
						t("{done} / {total} ({pct}%)", {
							done: fmt.format(done),
							total: fmt.format(total),
							pct,
						}) +
						(rate != null ? t(" -- {rate}/s", { rate: fmt.format(Math.round(rate)) }) : "")}
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
					<Button variant="destructive" onClick={() => controllerRef.current?.abort()}>
						{t("Cancel")}
					</Button>
				) : (
					<>
						{status === "done" && result.doneActions}
						<Button variant="primary" onClick={onClose}>
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
	const [runner, setRunner] = useState<BulkRunner | null>(null);
	const picker = useSelectorPick();
	const { data: allKeys } = useAsync(() => fieldCoverage({ type: "Everything" }), []);
	const info = useAsyncSticky(() => readTargetInfo(picker.selector), [picker.selector]);

	if (allKeys === null || info === null) return null;

	const onReady = (run: BulkRunner) => setRunner(() => run);
	const Setup = SETUPS[operation];

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title={t(TITLES[operation])} className="bulk-operation-modal">
				{runner ? (
					<BulkProgress runner={runner} selector={picker.selector} onClose={onClose} />
				) : (
					<Setup
						picker={picker}
						info={info}
						fieldKeys={allKeys.map(([key]) => key)}
						onReady={onReady}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
