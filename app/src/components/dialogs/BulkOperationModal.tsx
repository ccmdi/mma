import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { NSelect } from "@/components/primitives/NSelect";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Radio } from "@/components/primitives/Radio";
import { TextInput } from "@/components/primitives/TextInput";
import {
	getCurrentMap,
	addSelections,
	fetchAllLocations,
	useScope,
	applyScope,
	type ScopeController,
	updateLocations,
} from "@/store/useMapStore";
import type {
	Scope,
	Location,
	Update,
	LocationPatch_Deserialize as LocationPatch,
} from "@/bindings.gen";
import { ScopeSelector } from "@/components/primitives/ScopeSelector";
import { isPinnedToPano } from "@/types";
import {
	getFieldDef,
	fieldLabel,
	getAllFieldDefs,
	isWritableField,
} from "@/lib/data/fieldDefRegistry";
import { planFieldSet, planFieldExpr, parseFieldExpr, fieldPatch } from "@/lib/data/fieldOps";
import { ValidationState } from "@/store/selections";
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
import { saveExportTempFile } from "@/lib/util/util";
import { fmt } from "@/lib/util/format";
import { toast } from "@/lib/util/toast";

const TITLES = {
	validate: "Validate locations",
	enrich: "Enrich metadata",
	pinPano: "Pin to Pano ID",
	clearFields: "Clear metadata fields",
	setField: "Set metadata field",
	headingRoad: "Pan headings along road",
	downloadPanoramas: "Download panoramas",
} as const;
export type BulkOperation = keyof typeof TITLES;

type ProgressFn = (done: number, total: number, label?: string) => void;

interface BulkRunContext {
	locations: Location[];
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

interface SetupProps {
	scopeCtl: ScopeController;
	locs: Location[];
	scopedLocs: Location[];
	onReady: (run: BulkRunner) => void;
}

// ---------------------------------------------------------------------------
// Setup components — each produces a BulkRunner closure
// ---------------------------------------------------------------------------

function ValidateSetup({ scopeCtl, onReady }: SetupProps) {
	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ locations, signal, onProgress }) => {
							const results = await validateLocations(locations, {
								signal,
								onProgress: (p) =>
									onProgress(Math.round(p.progress * locations.length), locations.length),
							});
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
									locations: results.get(state)!.map((l) => l.id),
									state,
								}));
							if (batch.length > 0) addSelections(batch);
							return {
								doneMessage: `Done -- ${fmt.format(locations.length)} locations validated.`,
							};
						})
					}
				>
					Start
				</Button>
			</div>
		</div>
	);
}

function EnrichSetup({ scopeCtl, locs, onReady }: SetupProps) {
	const [force, setForce] = useState(false);
	const map = getCurrentMap();
	if (!map) return null;

	const scopedLocs = applyScope(scopeCtl.scope, locs);
	const enrichFields = map.meta.settings.enrichFields ?? getDefaultEnrichKeys();
	const allOptions = getEnrichFieldOptions();
	const enabledFields = allOptions.filter((f) => isFieldEnabled(enrichFields, f.key));
	const total = scopedLocs.length;
	const coverage = enabledFields.map((f) => ({
		key: f.key,
		label: f.label,
		have: scopedLocs.filter((l) => l.extra?.[f.key] != null).length,
	}));
	const needsAny = coverage.some((c) => c.have < total);
	const noPano = scopedLocs.filter((l) => !l.panoId).length;

	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			{enabledFields.length === 0 && (
				<div className="bulk-operation__status" style={{ opacity: 0.8 }}>
					No enrichment fields are enabled. Enable them in Map Settings under the Enrichment tab.
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
									<td className="bulk-operation__coverage-label">{c.label}</td>
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
			{noPano > 0 && (
				<div className="bulk-operation__status">
					{fmt.format(noPano)} without pano ID will be resolved from coordinates.
				</div>
			)}
			<label className="bulk-operation__option">
				<Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />
				Re-enrich already enriched locations
			</label>
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ locations, signal, onProgress }) => {
							const er = await enrichAll(locations, { signal, force, onProgress });
							return {
								doneContent: (
									<EnrichSummary
										result={er}
										onSelect={(ids) => addSelections([{ type: "Manual", locations: ids }])}
									/>
								),
							};
						})
					}
					disabled={enabledFields.length === 0 || (!force && !needsAny)}
				>
					Start
				</Button>
			</div>
		</div>
	);
}

function PinPanoSetup({ scopeCtl, locs, onReady }: SetupProps) {
	const [force, setForce] = useState(false);
	const [useLatest, setUseLatest] = useState(false);
	const scopedLocs = applyScope(scopeCtl.scope, locs);
	const unpinned = scopedLocs.filter((l) => !isPinnedToPano(l)).length;

	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			<div className="bulk-operation__status">
				{fmt.format(unpinned)} locations not pinned to a pano ID.
			</div>
			<label className="bulk-operation__option">
				<Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />
				Re-pin already pinned locations
			</label>
			<label className="bulk-operation__option">
				<Checkbox checked={useLatest} onChange={(e) => setUseLatest(e.target.checked)} />
				Use latest timeline coverage
			</label>
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ locations, signal, onProgress }) => {
							const count = await bulkPinToPano(locations, {
								signal,
								force: force || useLatest,
								useLatest,
								onProgress,
							});
							return { doneMessage: `Done -- ${fmt.format(count)} locations pinned.` };
						})
					}
					disabled={!force && !useLatest && unpinned === 0}
				>
					Start
				</Button>
			</div>
		</div>
	);
}

function ClearFieldsSetup({ locs, scopedLocs, scopeCtl, onReady }: SetupProps) {
	const allKeys = new Set<string>();
	for (const loc of locs) {
		if (loc.extra) for (const k of Object.keys(loc.extra)) allKeys.add(k);
	}

	const sortedKeys = [...allKeys].sort();
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const toggle = (key: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const scopedWithData = (key: string) => scopedLocs.filter((l) => l.extra?.[key] != null).length;

	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			{sortedKeys.length === 0 ? (
				<div className="bulk-operation__status">No metadata fields on this map.</div>
			) : (
				<div className="bulk-operation__field-list">
					{sortedKeys.map((key) => {
						const def = getFieldDef(key);
						const count = scopedWithData(key);
						return (
							<label key={key} className="bulk-operation__field-item">
								<Checkbox checked={selected.has(key)} onChange={() => toggle(key)} />
								<span className="bulk-operation__field-label">{fieldLabel(key)}</span>
								{def?.label && def.label !== key && (
									<span className="bulk-operation__field-key">{key}</span>
								)}
								<span className="bulk-operation__field-count">
									{count > 0 ? `${fmt.format(count)} values` : "no data"}
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
						onReady(async ({ locations }) => {
							const updates: Update<LocationPatch>[] = [];
							for (const loc of locations) {
								if (!loc.extra) continue;
								const present = keys.filter((k) => loc.extra![k] != null);
								if (present.length === 0) continue;
								updates.push({
									id: loc.id,
									patch: { extra: Object.fromEntries(present.map((k) => [k, null])) },
								});
							}
							if (updates.length > 0) await updateLocations(updates);
							return {
								doneMessage: `Cleared fields from ${fmt.format(updates.length)} locations.`,
							};
						});
					}}
					disabled={selected.size === 0}
				>
					Clear {selected.size > 0 ? `${selected.size} field${selected.size !== 1 ? "s" : ""}` : ""}
				</Button>
			</div>
		</div>
	);
}

function SetFieldSetup({ locs, scopeCtl, onReady }: SetupProps) {
	const sortedKeys = useMemo(() => {
		const known = new Set<string>(Object.keys(getAllFieldDefs()).filter(isWritableField));
		for (const loc of locs) {
			if (loc.extra) for (const k of Object.keys(loc.extra)) known.add(k);
		}
		return [...known].sort();
	}, [locs]);

	const [key, setKey] = useState("");
	const [creatingNew, setCreatingNew] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [raw, setRaw] = useState("");

	const effectiveKey = (creatingNew ? newKey : key).trim();
	const def = effectiveKey ? getFieldDef(effectiveKey) : undefined;
	const isNumber = def?.type === "number";
	const isEnum = def?.type === "enum" && def.values;
	const exprError = useMemo(() => {
		if (!isNumber || raw.trim() === "") return null;
		try {
			parseFieldExpr(raw);
			return null;
		} catch (e) {
			return e instanceof Error ? e.message : "Invalid expression";
		}
	}, [isNumber, raw]);
	const invalid = !effectiveKey || (isNumber && (raw.trim() === "" || exprError != null));

	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			<label className="bulk-operation__option">
				Field
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
						Select a field...
					</option>
					{sortedKeys.map((k) => (
						<option key={k} value={k}>
							{fieldLabel(k)}
						</option>
					))}
					<option value="__new__">New field...</option>
				</NSelect>
			</label>
			{creatingNew && (
				<label className="bulk-operation__option">
					New field name
					<TextInput
						value={newKey}
						onChange={(e) => setNewKey(e.target.value)}
						placeholder="field name"
						autoFocus
					/>
				</label>
			)}
			<label className="bulk-operation__option">
				Value
				{isEnum ? (
					<NSelect value={raw} onChange={(e) => setRaw(e.target.value)}>
						<option value="" />
						{def!.values!.map((v) => (
							<option key={v} value={v}>
								{def!.labels?.[v] ?? v}
							</option>
						))}
					</NSelect>
				) : (
					<TextInput
						type="text"
						value={raw}
						onChange={(e) => setRaw(e.target.value)}
						placeholder={isNumber ? "e.g. 45 or mod(sunAzimuth + 180, 360)" : undefined}
					/>
				)}
			</label>
			{isNumber && (
				<div className="bulk-operation__status">
					{exprError
						? `Invalid expression: ${exprError}`
						: "Constant or expression over fields (e.g. sunAzimuth, drivingDirection, lat)."}
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
						onReady(async ({ locations }) => {
							if (useExpr) {
								const { updates, skipped } = planFieldExpr(locations, ek, parseFieldExpr(rv));
								if (updates.length > 0) await updateLocations(updates);
								const msg =
									`Set field on ${fmt.format(updates.length)} locations.` +
									(skipped > 0 ? ` ${fmt.format(skipped)} skipped (missing source fields).` : "");
								return { doneMessage: msg };
							}
							const updates = planFieldSet(locations, fieldPatch(ek, rv));
							if (updates.length > 0) await updateLocations(updates);
							return { doneMessage: `Set field on ${fmt.format(updates.length)} locations.` };
						});
					}}
				>
					Set field
				</Button>
			</div>
		</div>
	);
}

function HeadingRoadSetup({ scopeCtl, onReady }: SetupProps) {
	const [direction, setDirection] = useState<RoadDirection>("forwards");

	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			<div className="bulk-operation__fieldset">
				<label>
					<Radio
						name="direction"
						checked={direction === "forwards"}
						onChange={() => setDirection("forwards")}
					/>
					Forwards (along driving direction)
				</label>
				<label>
					<Radio
						name="direction"
						checked={direction === "backwards"}
						onChange={() => setDirection("backwards")}
					/>
					Backwards
				</label>
			</div>
			<div className="bulk-operation__actions">
				<Button
					variant="primary"
					onClick={() =>
						onReady(async ({ locations, signal, onProgress }) => {
							const count = await bulkPanHeading(locations, direction, { signal, onProgress });
							return { doneMessage: `Panned ${fmt.format(count)} headings.` };
						})
					}
				>
					Start
				</Button>
			</div>
		</div>
	);
}

function DownloadPanoramasSetup({ scopeCtl, scopedLocs, onReady }: SetupProps) {
	const [mode, setMode] = useState<PanoRenderMode>("equirectangular");
	const [zoom, setZoom] = useState(5);
	const [tileX, setTileX] = useState(0);
	const [tileY, setTileY] = useState(0);
	const noPano = scopedLocs.filter((l) => !l.panoId).length;

	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			{noPano > 0 && (
				<div className="bulk-operation__status">
					{fmt.format(noPano)} without pano ID will be resolved from coordinates
					(using each location's provider).
				</div>
			)}
			<div className="bulk-operation__status">
				Supports Google, Baidu, Tencent, and Apple Look Around in the same batch.
				Tile mode is Google-only; Apple skips thumbnail mode.
			</div>
			<label className="bulk-operation__option">
				Mode
				<NSelect value={mode} onChange={(e) => setMode(e.target.value as PanoRenderMode)}>
					<option value="equirectangular">Equirectangular (full panorama)</option>
					<option value="perspective">Perspective (1920×1080)</option>
					<option value="thumbnail">Thumbnail (1024×768)</option>
					<option value="tile">Tile (512×512)</option>
				</NSelect>
			</label>
			{mode !== "thumbnail" && (
				<label className="bulk-operation__option">
					Zoom level
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
						Tile X
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
						Tile Y
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
						onReady(async ({ locations, signal, onProgress }) => {
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
								toast("Save failed");
							}
							return {
								doneMessage:
									`Done -- ${fmt.format(result.succeeded.length)} downloaded` +
									(result.failed.length > 0
										? `, ${fmt.format(result.failed.length)} failed.`
										: "."),
								doneActions: <DownloadDoneActions result={result} initiallySaved={saved} />,
							};
						});
					}}
				>
					Start
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
				? "Panorama saved"
				: `Saved ${fmt.format(result.fileCount)} panoramas as ZIP`,
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
			toast("Save failed");
		}
	};

	return (
		<>
			{result.outputPath != null && !saved && (
				<Button variant="primary" onClick={() => void save()}>
					{result.fileCount === 1 ? "Save image" : "Save ZIP"}
				</Button>
			)}
			{result.failed.length > 0 && (
				<Button
					onClick={() => {
						addSelections([{ type: "Manual", locations: result.failed }]);
						toast(`Selected ${fmt.format(result.failed.length)} failed locations`);
					}}
				>
					Select failed
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
			<div className="enrich-summary">
				<div>Nothing to process.</div>
			</div>
		);
	}
	return (
		<div className="enrich-summary">
			{result.map((r) => (
				<div key={r.id}>
					{r.label}: {fmt.format(r.success.length)} updated
					{r.failed.length > 0 && <>, {fmt.format(r.failed.length)} failed</>}
					{r.failed.length > 0 && (
						<Button
							style={{ marginLeft: 8 }}
							onClick={() => onSelect(r.failed, `${r.label} failed`)}
						>
							Select failed
						</Button>
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
	scope,
	onClose,
}: {
	runner: BulkRunner;
	scope: Scope;
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
	const controllerRef = useRef<AbortController | null>(null);
	const rateRef = useRef<{ t: number; done: number; ema: number | null }>({
		t: 0,
		done: 0,
		ema: null,
	});

	const run = useCallback(async () => {
		const controller = new AbortController();
		controllerRef.current = controller;

		const locations = applyScope(scope, await fetchAllLocations());
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
			const r = await runner({ locations, signal: controller.signal, onProgress });
			setResult(r);
			setProgress(1);
			setElapsed((performance.now() - runStart) / 1000);
			setStatus("done");
		} catch (e: unknown) {
			if (e instanceof Error && e.name === "AbortError") {
				if (controllerRef.current === controller) setStatus("cancelled");
			} else {
				setError(e instanceof Error ? e.message : "Operation failed");
				setStatus("error");
			}
		}
	}, [runner, scope]);

	useEffect(() => {
		run();
		return () => {
			controllerRef.current?.abort();
		};
	}, [run]);

	const pct = Math.round(progress * 100);

	return (
		<div className="bulk-operation">
			<div className="bulk-operation__status">
				{status === "running" &&
					`${phaseLabel ? `${phaseLabel}: ` : ""}${fmt.format(done)} / ${fmt.format(total)} (${pct}%)${
						rate != null ? ` -- ${fmt.format(Math.round(rate))}/s` : ""
					}`}
				{status === "done" &&
					(result.doneContent ??
						result.doneMessage ??
						`Done -- ${fmt.format(total)} locations processed${
							elapsed != null && elapsed > 0
								? ` in ${elapsed.toFixed(1)}s (${fmt.format(Math.round(total / elapsed))}/s)`
								: ""
						}.`)}
				{status === "cancelled" && `Cancelled at ${fmt.format(done)} / ${fmt.format(total)}.`}
				{status === "error" && `Error: ${error}`}
			</div>
			<progress className="bulk-operation__bar" value={progress} max={1} />
			<div className="bulk-operation__actions">
				{status === "running" ? (
					<Button variant="destructive" onClick={() => controllerRef.current?.abort()}>
						Cancel
					</Button>
				) : (
					<>
						{status === "done" && result.doneActions}
						<Button variant="primary" onClick={onClose}>
							Close
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
	const [locs, setLocs] = useState<Location[] | null>(null);
	const scopeCtl = useScope();

	useEffect(() => {
		fetchAllLocations().then(setLocs);
	}, []);

	if (locs === null) return null;

	const onReady = (run: BulkRunner) => setRunner(() => run);
	const scopedLocs = applyScope(scopeCtl.scope, locs);
	const Setup = SETUPS[operation];

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title={TITLES[operation]} className="bulk-operation-modal">
				{runner ? (
					<BulkProgress runner={runner} scope={scopeCtl.scope} onClose={onClose} />
				) : (
					<Setup scopeCtl={scopeCtl} locs={locs} scopedLocs={scopedLocs} onReady={onReady} />
				)}
			</DialogContent>
		</Dialog>
	);
}
