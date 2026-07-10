import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { NSelect } from "@/components/primitives/NSelect";
import {
	getCurrentMap,
	addSelections,
	fetchAllLocations,
	fetchLocationsByIds,
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
import { getFieldDef, fieldLabel, getAllFieldDefs } from "@/lib/data/fieldDefRegistry";
import { planFieldSet, planFieldExpr, parseFieldExpr, fieldPatch } from "@/lib/data/fieldOps";
import { ValidationState } from "@/store/selections";
import { validateLocations } from "@/lib/sv/validate";
import { enrichAll, type EnrichResult } from "@/lib/sv/enrich";
import { getEnrichFieldOptions, getDefaultEnrichKeys, isFieldEnabled } from "@/lib/data/fieldDefs";
import { bulkPinToPano } from "@/lib/sv/pinPano";
import { bulkPanHeading, type RoadDirection } from "@/lib/sv/headingRoad";
import {
	bulkDownloadPanoramas,
	saveDownloadedImages,
	type BulkDownloadConfig,
	type BulkDownloadResult,
	type DownloadProgressDetail,
} from "@/lib/sv/bulkDownloadPanoramas";
import type { DownloadRenderMode } from "@/lib/sv/downloadPanorama";
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

type ProgressFn = (
	done: number,
	total: number,
	label?: string,
	detail?: DownloadProgressDetail,
) => void;

interface BulkRunContext {
	locations: Location[];
	signal: AbortSignal;
	onProgress: ProgressFn;
}

interface BulkRunResult {
	doneMessage?: string;
	doneContent?: React.ReactNode;
	downloadResult?: BulkDownloadResult;
}

type BulkRunner = (ctx: BulkRunContext) => Promise<BulkRunResult>;

interface Props {
	operation: BulkOperation;
	onClose: () => void;
	locationIds?: number[];
}

interface SetupProps {
	scopeCtl: ScopeController;
	locs: Location[];
	scopedLocs: Location[];
	onReady: (run: BulkRunner) => void;
	hideScope?: boolean;
}

// ---------------------------------------------------------------------------
// Setup components — each produces a BulkRunner closure
// ---------------------------------------------------------------------------

function ValidateSetup({ scopeCtl, onReady }: SetupProps) {
	return (
		<div className="bulk-operation">
			<ScopeSelector ctl={scopeCtl} />
			<div className="bulk-operation__actions">
				<button
					className="button button--primary"
					type="button"
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
				</button>
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
				<input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
				Re-enrich already enriched locations
			</label>
			<div className="bulk-operation__actions">
				<button
					className="button button--primary"
					type="button"
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
				</button>
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
				<input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
				Re-pin already pinned locations
			</label>
			<label className="bulk-operation__option">
				<input
					type="checkbox"
					checked={useLatest}
					onChange={(e) => setUseLatest(e.target.checked)}
				/>
				Use latest timeline coverage
			</label>
			<div className="bulk-operation__actions">
				<button
					className="button button--primary"
					type="button"
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
				</button>
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
								<input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
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
				<button
					className="button button--primary"
					type="button"
					onClick={() => {
						const keys = [...selected];
						onReady(async ({ locations }) => {
							const updates: Update<LocationPatch>[] = [];
							for (const loc of locations) {
								if (!loc.extra) continue;
								const hasAny = keys.some((k) => loc.extra![k] != null);
								if (!hasAny) continue;
								const cleaned = { ...loc.extra };
								for (const k of keys) delete cleaned[k];
								updates.push({ id: loc.id, patch: { extra: cleaned } });
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
				</button>
			</div>
		</div>
	);
}

function SetFieldSetup({ locs, scopeCtl, onReady }: SetupProps) {
	const sortedKeys = useMemo(() => {
		const known = new Set<string>(Object.keys(getAllFieldDefs()));
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
					<input
						className="input"
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
					<input
						className="input"
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
				<button
					className="button button--primary"
					type="button"
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
				</button>
			</div>
		</div>
	);
}

function DownloadPanoramasSetup({ scopeCtl, scopedLocs, onReady, hideScope }: SetupProps) {
	const [mode, setMode] = useState<DownloadRenderMode>("equirectangular");
	const [zoom, setZoom] = useState(5);
	const [tileX, setTileX] = useState(0);
	const [tileY, setTileY] = useState(0);
	const noPano = scopedLocs.filter((l) => !l.panoId).length;
	const showZoom = mode !== "thumbnail";
	const showTileCoords = mode === "tile";

	return (
		<div className="bulk-operation">
			{hideScope ? (
				<div className="bulk-operation__status">
					{fmt.format(scopedLocs.length)} locations in this selection.
				</div>
			) : (
				<ScopeSelector ctl={scopeCtl} />
			)}
			<div className="bulk-operation__status">
				Perspective and thumbnail use each location&apos;s heading and pitch. A single image
				is saved as-is; multiple images are packed into a ZIP when you save.
			</div>
			{noPano > 0 && (
				<div className="bulk-operation__status">
					{fmt.format(noPano)} without pano ID will be resolved from coordinates.
				</div>
			)}
			<label className="bulk-operation__option">
				Mode
				<NSelect
					value={mode}
					onChange={(e) => setMode(e.target.value as DownloadRenderMode)}
				>
					<option value="equirectangular">Equirectangular (full panorama)</option>
					<option value="perspective">Perspective (1920×1080)</option>
					<option value="thumbnail">Thumbnail (1024×768)</option>
					<option value="tile">Tile (512×512)</option>
				</NSelect>
			</label>
			{showZoom && (
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
			{showTileCoords && (
				<>
					<label className="bulk-operation__option">
						Tile X
						<input
							className="input"
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
						<input
							className="input"
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
				<button
					className="button button--primary"
					type="button"
					onClick={() => {
						const config: BulkDownloadConfig = { mode, zoom, tileX, tileY };
						onReady(async ({ locations, signal, onProgress }) => {
							const result = await bulkDownloadPanoramas(locations, config, {
								signal,
								onProgress,
							});
							return { downloadResult: result };
						});
					}}
				>
					Start
				</button>
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
					<input
						type="radio"
						name="direction"
						checked={direction === "forwards"}
						onChange={() => setDirection("forwards")}
					/>
					Forwards (along driving direction)
				</label>
				<label>
					<input
						type="radio"
						name="direction"
						checked={direction === "backwards"}
						onChange={() => setDirection("backwards")}
					/>
					Backwards
				</label>
			</div>
			<div className="bulk-operation__actions">
				<button
					className="button button--primary"
					type="button"
					onClick={() =>
						onReady(async ({ locations, signal, onProgress }) => {
							const count = await bulkPanHeading(locations, direction, { signal, onProgress });
							return { doneMessage: `Panned ${fmt.format(count)} headings.` };
						})
					}
				>
					Start
				</button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Result display
// ---------------------------------------------------------------------------

function DownloadLocationLists({
	succeeded,
	failed,
}: {
	succeeded: number[];
	failed: number[];
}) {
	if (succeeded.length === 0 && failed.length === 0) return null;
	return (
		<div className="bulk-operation__download-lists">
			{succeeded.length > 0 && (
				<div className="bulk-operation__download-list bulk-operation__download-list--ok">
					<div className="bulk-operation__download-list-title">
						Succeeded ({fmt.format(succeeded.length)})
					</div>
				</div>
			)}
			{failed.length > 0 && (
				<div className="bulk-operation__download-list bulk-operation__download-list--fail">
					<div className="bulk-operation__download-list-title">
						Failed ({fmt.format(failed.length)})
					</div>
				</div>
			)}
		</div>
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
						<button
							className="button"
							type="button"
							style={{ marginLeft: 8 }}
							onClick={() => onSelect(r.failed, `${r.label} failed`)}
						>
							Select failed
						</button>
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
	locationsOverride,
	onClose,
}: {
	runner: BulkRunner;
	scope: Scope;
	locationsOverride?: Location[];
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
	const [downloadProgress, setDownloadProgress] = useState<DownloadProgressDetail | null>(null);
	const controllerRef = useRef<AbortController | null>(null);
	const rateRef = useRef<{ t: number; done: number; ema: number | null }>({
		t: 0,
		done: 0,
		ema: null,
	});

	const run = useCallback(async () => {
		const controller = new AbortController();
		controllerRef.current = controller;

		const locations =
			locationsOverride ?? applyScope(scope, await fetchAllLocations());
		const runStart = performance.now();
		rateRef.current = { t: runStart, done: 0, ema: null };
		setRate(null);
		setElapsed(null);

		const onProgress: ProgressFn = (d, t, label, detail) => {
			setPhaseLabel(label ?? null);
			setTotal(t);
			setDone(d);
			setProgress(t > 0 ? d / t : 1);
			if (detail) setDownloadProgress(detail);

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
	}, [runner, scope, locationsOverride]);

	useEffect(() => {
		run();
		return () => {
			controllerRef.current?.abort();
		};
	}, [run]);

	const pct = Math.round(progress * 100);
	const downloadResult = result.downloadResult;
	const listSucceeded = downloadResult?.succeeded ?? downloadProgress?.succeeded ?? [];
	const listFailed = downloadResult?.failed ?? downloadProgress?.failed ?? [];
	const showDownloadLists = listSucceeded.length > 0 || listFailed.length > 0;

	const handleSaveDownload = async () => {
		if (!downloadResult?.files.length) return;
		try {
			const saved = await saveDownloadedImages(downloadResult.files, downloadResult.archive);
			if (saved) {
				toast(
					downloadResult.files.length === 1
						? "Panorama saved"
						: `Saved ${fmt.format(downloadResult.files.length)} panoramas as ZIP`,
				);
			}
		} catch {
			toast("Save failed");
		}
	};

	const handleSelectFailed = () => {
		if (!downloadResult?.failed.length) return;
		addSelections([
			{ type: "Locations", locations: downloadResult.failed, name: "failed to download" },
		]);
		toast(`Added ${fmt.format(downloadResult.failed.length)} locations to selections`);
		onClose();
	};

	return (
		<div className="bulk-operation">
			<div className="bulk-operation__status">
				{status === "running" &&
					`${phaseLabel ? `${phaseLabel}: ` : ""}${fmt.format(done)} / ${fmt.format(total)} (${pct}%)${
						rate != null ? ` -- ${fmt.format(Math.round(rate))}/s` : ""
					}`}
				{status === "done" && downloadResult && (
					<>
						Done — {fmt.format(downloadResult.succeeded.length)} succeeded
						{downloadResult.failed.length > 0 &&
							`, ${fmt.format(downloadResult.failed.length)} failed`}
						{elapsed != null && elapsed > 0
							? ` in ${elapsed.toFixed(1)}s`
							: ""}
						.
					</>
				)}
				{status === "done" &&
					!downloadResult &&
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
			{showDownloadLists && (
				<DownloadLocationLists succeeded={listSucceeded} failed={listFailed} />
			)}
			<progress className="bulk-operation__bar" value={progress} max={1} />
			<div className="bulk-operation__actions">
				{status === "running" ? (
					<button
						className="button button--destructive"
						type="button"
						onClick={() => controllerRef.current?.abort()}
					>
						Cancel
					</button>
				) : status === "done" && downloadResult ? (
					<>
						<button
							className="button button--primary"
							type="button"
							disabled={downloadResult.files.length === 0}
							onClick={() => void handleSaveDownload()}
						>
							{downloadResult.files.length === 1 ? "Save image" : "Save ZIP"}
						</button>
						<button
							className="button"
							type="button"
							disabled={downloadResult.failed.length === 0}
							onClick={handleSelectFailed}
						>
							Add failed to selections
						</button>
						<button className="button" type="button" onClick={onClose}>
							Close
						</button>
					</>
				) : (
					<button className="button button--primary" type="button" onClick={onClose}>
						Close
					</button>
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

export function BulkOperationModal({ operation, onClose, locationIds }: Props) {
	const [runner, setRunner] = useState<BulkRunner | null>(null);
	const [locs, setLocs] = useState<Location[] | null>(null);
	const scopeCtl = useScope();
	const fixedScope = locationIds != null;

	useEffect(() => {
		if (locationIds != null) {
			fetchLocationsByIds(locationIds).then(setLocs);
		} else {
			fetchAllLocations().then(setLocs);
		}
	}, [locationIds]);

	if (locs === null) return null;

	const onReady = (run: BulkRunner) => setRunner(() => run);
	const scopedLocs = fixedScope ? locs : applyScope(scopeCtl.scope, locs);
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
					<BulkProgress
						runner={runner}
						scope={scopeCtl.scope}
						locationsOverride={fixedScope ? locs : undefined}
						onClose={onClose}
					/>
				) : (
					<Setup
						scopeCtl={scopeCtl}
						locs={locs}
						scopedLocs={scopedLocs}
						onReady={onReady}
						hideScope={fixedScope}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
