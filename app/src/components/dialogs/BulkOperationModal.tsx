import { useState, useEffect, useRef, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import {
	getCurrentMap,
	addSelections,
	fetchAllLocations,
	fetchLocationsByIds,
	batchUpdateLocations,
	useSelectedLocationIds,
} from "@/store/useMapStore";
import type { Location } from "@/types";
import { isPinnedToPano } from "@/types";
import { getFieldDef, getAllFieldDefs } from "@/lib/data/fieldDefRegistry";
import { planFieldSet } from "@/lib/data/fieldOps.add";
import { ValidationState } from "@/store/selections";
import { validateLocations } from "@/lib/sv/validate";
import { enrichAll, needsEnrichment, type EnrichResult } from "@/lib/sv/enrich.add";
import { bulkPinToPano } from "@/lib/sv/pinPano.add";
import { fmt } from "@/lib/util/format";

export type BulkOperation = "validate" | "enrich" | "pinPano" | "clearFields" | "setField";

interface Props {
	operation: BulkOperation;
	onClose: () => void;
}

const TITLES: Record<BulkOperation, string> = {
	validate: "Validate locations",
	enrich: "Enrich metadata",
	pinPano: "Pin to Pano ID",
	clearFields: "Clear metadata fields",
	setField: "Set metadata field",
};

interface SetFieldOpt {
	key: string;
	value: unknown;
}

type Scope = "all" | "selection";

function ScopeToggle({
	scope,
	onScopeChange,
	allCount,
	selectionCount,
}: {
	scope: Scope;
	onScopeChange: (s: Scope) => void;
	allCount: number;
	selectionCount: number;
}) {
	const hasSelection = selectionCount > 0;
	return (
		<div className="bulk-operation__scope">
			<label className="bulk-operation__scope-option">
				<input
					type="radio"
					name="scope"
					checked={scope === "all"}
					onChange={() => onScopeChange("all")}
				/>
				All locations ({fmt.format(allCount)})
			</label>
			<label
				className="bulk-operation__scope-option"
				style={!hasSelection ? { opacity: 0.5 } : undefined}
			>
				<input
					type="radio"
					name="scope"
					checked={scope === "selection"}
					disabled={!hasSelection}
					onChange={() => onScopeChange("selection")}
				/>
				Current selection ({fmt.format(selectionCount)})
			</label>
		</div>
	);
}

function BulkSetup({
	operation,
	onStart,
}: {
	operation: BulkOperation;
	onStart: (opts: {
		force: boolean;
		scope: Scope;
		clearKeys?: string[];
		setField?: SetFieldOpt;
	}) => void;
}) {
	const [force, setForce] = useState(false);
	const [locs, setLocs] = useState<Location[]>([]);
	const selectedIds = useSelectedLocationIds();
	const selectionCount = selectedIds.size;
	const [scope, setScope] = useState<Scope>(selectionCount > 0 ? "selection" : "all");
	const map = getCurrentMap();

	useEffect(() => {
		fetchAllLocations().then(setLocs);
	}, []);

	if (!map) return null;
	const total = locs.length;

	const scopedLocs = scope === "selection" ? locs.filter((l) => selectedIds.has(l.id)) : locs;

	if (operation === "enrich") {
		const unenriched = scopedLocs.filter(needsEnrichment).length;
		const noPano = scopedLocs.filter((l) => !l.panoId).length;
		return (
			<div className="bulk-operation">
				<ScopeToggle
					scope={scope}
					onScopeChange={setScope}
					allCount={total}
					selectionCount={selectionCount}
				/>
				<div className="bulk-operation__status">
					{fmt.format(unenriched)} locations need enrichment.
					{noPano > 0 &&
						` ${fmt.format(noPano)} without pano ID will be resolved from coordinates.`}
				</div>
				<label className="bulk-operation__option">
					<input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
					Re-enrich already enriched locations
				</label>
				<div className="bulk-operation__actions">
					<button
						className="button button--primary"
						type="button"
						onClick={() => onStart({ force, scope })}
						disabled={!force && unenriched === 0}
					>
						Start
					</button>
				</div>
			</div>
		);
	}

	if (operation === "pinPano") {
		const unpinned = scopedLocs.filter((l) => !isPinnedToPano(l)).length;
		return (
			<div className="bulk-operation">
				<ScopeToggle
					scope={scope}
					onScopeChange={setScope}
					allCount={total}
					selectionCount={selectionCount}
				/>
				<div className="bulk-operation__status">
					{fmt.format(scopedLocs.length)} locations in scope. {fmt.format(unpinned)} not pinned to a
					pano ID.
				</div>
				<label className="bulk-operation__option">
					<input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
					Re-pin already pinned locations
				</label>
				<div className="bulk-operation__actions">
					<button
						className="button button--primary"
						type="button"
						onClick={() => onStart({ force, scope })}
						disabled={!force && unpinned === 0}
					>
						Start
					</button>
				</div>
			</div>
		);
	}

	if (operation === "clearFields") {
		return (
			<ClearFieldsSetup
				locs={locs}
				scopedLocs={scopedLocs}
				scope={scope}
				onScopeChange={setScope}
				allCount={total}
				selectionCount={selectionCount}
				onStart={(keys) => onStart({ force: false, scope, clearKeys: keys })}
			/>
		);
	}

	if (operation === "setField") {
		return (
			<SetFieldSetup
				locs={locs}
				scope={scope}
				onScopeChange={setScope}
				allCount={total}
				selectionCount={selectionCount}
				onStart={(setField) => onStart({ force: false, scope, setField })}
			/>
		);
	}

	// validate has no setup options beyond scope
	return (
		<div className="bulk-operation">
			<ScopeToggle
				scope={scope}
				onScopeChange={setScope}
				allCount={total}
				selectionCount={selectionCount}
			/>
			<div className="bulk-operation__actions">
				<button
					className="button button--primary"
					type="button"
					onClick={() => onStart({ force: false, scope })}
				>
					Start
				</button>
			</div>
		</div>
	);
}

function ClearFieldsSetup({
	locs,
	scopedLocs,
	scope,
	onScopeChange,
	allCount,
	selectionCount,
	onStart,
}: {
	locs: Location[];
	scopedLocs: Location[];
	scope: Scope;
	onScopeChange: (s: Scope) => void;
	allCount: number;
	selectionCount: number;
	onStart: (keys: string[]) => void;
}) {
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
			<ScopeToggle
				scope={scope}
				onScopeChange={onScopeChange}
				allCount={allCount}
				selectionCount={selectionCount}
			/>
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
								<span className="bulk-operation__field-label">{def?.label ?? key}</span>
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
					onClick={() => onStart([...selected])}
					disabled={selected.size === 0}
				>
					Clear {selected.size > 0 ? `${selected.size} field${selected.size !== 1 ? "s" : ""}` : ""}
				</button>
			</div>
		</div>
	);
}

function SetFieldSetup({
	locs,
	scope,
	onScopeChange,
	allCount,
	selectionCount,
	onStart,
}: {
	locs: Location[];
	scope: Scope;
	onScopeChange: (s: Scope) => void;
	allCount: number;
	selectionCount: number;
	onStart: (opt: SetFieldOpt) => void;
}) {
	const knownKeys = new Set<string>(Object.keys(getAllFieldDefs()));
	for (const loc of locs) {
		if (loc.extra) for (const k of Object.keys(loc.extra)) knownKeys.add(k);
	}
	const sortedKeys = [...knownKeys].sort();

	const [key, setKey] = useState("");
	const [creatingNew, setCreatingNew] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [raw, setRaw] = useState("");

	const effectiveKey = (creatingNew ? newKey : key).trim();
	const def = effectiveKey ? getFieldDef(effectiveKey) : undefined;
	const isNumber = def?.type === "number";
	const isEnum = def?.type === "enum" && def.values;
	const value: unknown = isNumber ? Number(raw) : raw;
	const invalid = !effectiveKey || (isNumber && (raw === "" || Number.isNaN(Number(raw))));

	return (
		<div className="bulk-operation">
			<ScopeToggle
				scope={scope}
				onScopeChange={onScopeChange}
				allCount={allCount}
				selectionCount={selectionCount}
			/>
			<label className="bulk-operation__option">
				Field
				<select
					className="nselect"
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
							{getFieldDef(k)?.label ?? k}
						</option>
					))}
					<option value="__new__">New field...</option>
				</select>
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
					<select className="nselect" value={raw} onChange={(e) => setRaw(e.target.value)}>
						<option value="" />
						{def!.values!.map((v) => (
							<option key={v} value={v}>
								{def!.labels?.[v] ?? v}
							</option>
						))}
					</select>
				) : (
					<input
						className="input"
						type={isNumber ? "number" : "text"}
						value={raw}
						onChange={(e) => setRaw(e.target.value)}
					/>
				)}
			</label>
			<div className="bulk-operation__actions">
				<button
					className="button button--primary"
					type="button"
					disabled={invalid}
					onClick={() => onStart({ key: effectiveKey, value })}
				>
					Set field
				</button>
			</div>
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
	return (
		<div className="enrich-summary">
			{(result.metaSuccess.length > 0 || result.metaFailed.length > 0) && (
				<div>
					Metadata: {fmt.format(result.metaSuccess.length)} enriched
					{result.metaFailed.length > 0 && <>, {fmt.format(result.metaFailed.length)} failed</>}
					{result.metaFailed.length > 0 && (
						<button
							className="button"
							type="button"
							style={{ marginLeft: 8 }}
							onClick={() => onSelect(result.metaFailed, "Metadata failed")}
						>
							Select failed
						</button>
					)}
				</div>
			)}
			{(result.dateSuccess.length > 0 || result.dateFailed.length > 0) && (
				<div>
					Exact dates: {fmt.format(result.dateSuccess.length)} resolved
					{result.dateFailed.length > 0 && <>, {fmt.format(result.dateFailed.length)} failed</>}
					{result.dateFailed.length > 0 && (
						<button
							className="button"
							type="button"
							style={{ marginLeft: 8 }}
							onClick={() => onSelect(result.dateFailed, "Date resolution failed")}
						>
							Select failed
						</button>
					)}
				</div>
			)}
			{result.metaSuccess.length === 0 &&
				result.metaFailed.length === 0 &&
				result.dateSuccess.length === 0 &&
				result.dateFailed.length === 0 && <div>Nothing to process.</div>}
		</div>
	);
}

function BulkProgress({
	operation,
	force,
	scope,
	selectedIds,
	clearKeys,
	setField,
	onClose,
}: {
	operation: BulkOperation;
	force: boolean;
	scope: Scope;
	selectedIds: Set<number>;
	clearKeys?: string[];
	setField?: SetFieldOpt;
	onClose: () => void;
}) {
	const [progress, setProgress] = useState(0);
	const [total, setTotal] = useState(0);
	const [done, setDone] = useState(0);
	const [status, setStatus] = useState<"running" | "done" | "cancelled" | "error">("running");
	const [error, setError] = useState<string | null>(null);
	const [enrichResult, setEnrichResult] = useState<EnrichResult | null>(null);
	const [clearCount, setClearCount] = useState(0);
	const controllerRef = useRef<AbortController | null>(null);

	// Stable ref -- scope and selectedIds are fixed at mount time
	const locationIdsRef = useRef(scope === "selection" ? [...selectedIds] : null);

	const run = useCallback(async () => {
		const map = getCurrentMap();
		if (!map) return;
		const controller = new AbortController();
		controllerRef.current = controller;

		const locationIds = locationIdsRef.current;
		const locations = locationIds
			? await fetchLocationsByIds(locationIds)
			: await fetchAllLocations();

		const onProgress = (d: number, t: number) => {
			setTotal(t);
			setDone(d);
			setProgress(t > 0 ? d / t : 1);
		};

		try {
			if (operation === "validate") {
				const results = await validateLocations(locations, {
					signal: controller.signal,
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
			} else if (operation === "enrich") {
				const er = await enrichAll(locations, {
					signal: controller.signal,
					force,
					onProgress,
				});
				setEnrichResult(er);
			} else if (operation === "pinPano") {
				await bulkPinToPano(locations, {
					signal: controller.signal,
					force,
					onProgress,
				});
			} else if (operation === "clearFields") {
				const keys = clearKeys ?? [];
				const updates: { id: number; patch: { extra: Record<string, unknown> } }[] = [];
				for (const loc of locations) {
					if (!loc.extra) continue;
					const hasAny = keys.some((k) => loc.extra![k] != null);
					if (!hasAny) continue;
					const cleaned = { ...loc.extra };
					for (const k of keys) delete cleaned[k];
					updates.push({ id: loc.id, patch: { extra: cleaned } });
				}

				setTotal(updates.length);
				if (updates.length > 0) {
					await batchUpdateLocations(updates);
				}
				setDone(updates.length);
				setClearCount(updates.length);
			} else if (operation === "setField" && setField) {
				const updates = planFieldSet(locations, setField.key, setField.value).map((u) => ({
					id: u.id,
					patch: { extra: u.extra },
				}));
				setTotal(updates.length);
				if (updates.length > 0) {
					await batchUpdateLocations(updates);
				}
				setDone(updates.length);
				setClearCount(updates.length);
			}
			setProgress(1);
			setStatus("done");
		} catch (e: unknown) {
			if (e instanceof Error && e.name === "AbortError") {
				if (controllerRef.current === controller) setStatus("cancelled");
			} else {
				setError(e instanceof Error ? e.message : "Operation failed");
				setStatus("error");
			}
		}
	}, [operation, force, clearKeys, setField]);

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
				{status === "running" && `${fmt.format(done)} / ${fmt.format(total)} (${pct}%)`}
				{status === "done" && enrichResult ? (
					<EnrichSummary
						result={enrichResult}
						onSelect={(ids, _label) => {
							addSelections([{ type: "Manual", locations: ids }]);
						}}
					/>
				) : status === "done" && operation === "clearFields" ? (
					`Cleared fields from ${fmt.format(clearCount)} locations.`
				) : status === "done" && operation === "setField" ? (
					`Set field on ${fmt.format(clearCount)} locations.`
				) : (
					status === "done" && `Done -- ${fmt.format(total)} locations processed.`
				)}
				{status === "cancelled" && `Cancelled at ${fmt.format(done)} / ${fmt.format(total)}.`}
				{status === "error" && `Error: ${error}`}
			</div>
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
				) : (
					<button className="button button--primary" type="button" onClick={onClose}>
						Close
					</button>
				)}
			</div>
		</div>
	);
}

export function BulkOperationModal({ operation, onClose }: Props) {
	const [started, setStarted] = useState(false);
	const [force, setForce] = useState(false);
	const [scope, setScope] = useState<Scope>("all");
	const [clearKeys, setClearKeys] = useState<string[]>([]);
	const [setField, setSetField] = useState<SetFieldOpt | undefined>(undefined);
	const selectedIds = useSelectedLocationIds();

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent title={TITLES[operation]} className="bulk-operation-modal">
				{!started ? (
					<BulkSetup
						operation={operation}
						onStart={(opts) => {
							setForce(opts.force);
							setScope(opts.scope);
							if (opts.clearKeys) setClearKeys(opts.clearKeys);
							if (opts.setField) setSetField(opts.setField);
							setStarted(true);
						}}
					/>
				) : (
					<BulkProgress
						operation={operation}
						force={force}
						scope={scope}
						selectedIds={selectedIds}
						clearKeys={clearKeys}
						setField={setField}
						onClose={onClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
