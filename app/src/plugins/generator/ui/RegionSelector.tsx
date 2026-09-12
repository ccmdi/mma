import { useEffect, useEffectEvent, useState } from "react";
import { useMapState, getActiveSelections } from "@/store/useMapStore";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { Flag } from "@/components/primitives/Flag";
import type { Selection } from "@/bindings.gen";
import type { GeneratorRegionMeta } from "../engine/types";
import { useProgressTick, useFoundRate } from "./progressSignal";
import { t } from "@/lib/i18n";

function getPolygonName(sel: Selection): string {
	if (sel.selector.type !== "Polygon") return sel.key;
	return sel.selector.polygon.properties?.name || t("Unnamed polygon");
}

function getPolygonCode(sel: Selection): string | null {
	if (sel.selector.type !== "Polygon") return null;
	return sel.selector.polygon.properties?.code ?? null;
}

function rateLabel(rate: number | null): string | null {
	if (rate == null) return null;
	return t("{rate}/s", { rate: rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1) });
}

function RegionRow({
	sel,
	found,
	target,
	processing,
	running,
	onTargetChange,
}: {
	sel: Selection;
	found: number;
	target: number;
	processing: boolean;
	running: boolean;
	onTargetChange: (v: number) => void;
}) {
	const name = getPolygonName(sel);
	const code = getPolygonCode(sel);
	const rate = useFoundRate(found, target, running && found < target);
	return (
		<div className="generator-regions__item">
			<div className="generator-regions__item-name">
				<Flag code={code} className="generator-regions__flag" />
				<span>{name}</span>
				{processing && <span className="generator-regions__spinner" />}
			</div>
			<div className="generator-regions__item-count">
				{rate != null && <span className="generator-regions__rate">{rateLabel(rate)}</span>}
				{found} /
				<TextInput
					type="number"
					min={found || 1}
					value={target}
					onChange={(e) => onTargetChange(Number(e.target.value) || 1)}
					style={{ width: "5rem", fontSize: "inherit" }}
				/>
			</div>
		</div>
	);
}

export function RegionSelector({
	defaultTarget,
	onDefaultTargetChange,
	meta,
	onMetaChange,
	running,
}: {
	defaultTarget: number;
	onDefaultTargetChange: (v: number) => void;
	meta: Map<string, GeneratorRegionMeta>;
	onMetaChange: (meta: Map<string, GeneratorRegionMeta>) => void;
	running: boolean;
}) {
	useProgressTick();
	const selections = useMapState(getActiveSelections);
	const polygonSelections = selections.filter((s) => s.selector.type === "Polygon");
	const [capDialogOpen, setCapDialogOpen] = useState(false);
	const [capInput, setCapInput] = useState("");

	const getMeta = useEffectEvent(() => meta);

	// Initialize metadata for new polygon selections
	useEffect(() => {
		let changed = false;
		const next = new Map(getMeta());
		for (const sel of polygonSelections) {
			if (!next.has(sel.key)) {
				next.set(sel.key, {
					target: defaultTarget,
					found: [],
					checkedPanos: new Set(),
					isProcessing: false,
				});
				changed = true;
			}
		}
		if (changed) onMetaChange(next);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when selection count changes
	}, [polygonSelections.length, defaultTarget, onMetaChange]);

	const setTarget = (key: string, target: number) => {
		const next = new Map(meta);
		const existing = next.get(key);
		if (existing) {
			next.set(key, { ...existing, target });
		} else {
			next.set(key, { target, found: [], checkedPanos: new Set(), isProcessing: false });
		}
		onMetaChange(next);
	};

	let totalFound = 0;
	let totalTarget = 0;
	for (const sel of polygonSelections) {
		const m = meta.get(sel.key);
		totalFound += m?.found.length ?? 0;
		totalTarget += m?.target ?? defaultTarget;
	}

	const confirmCap = () => {
		const val = Math.abs(parseInt(capInput || ""));
		if (!isNaN(val) && val > 0) {
			const next = new Map(meta);
			for (const sel of polygonSelections) {
				const existing = next.get(sel.key);
				if (existing) next.set(sel.key, { ...existing, target: val });
				else
					next.set(sel.key, {
						target: val,
						found: [],
						checkedPanos: new Set(),
						isProcessing: false,
					});
			}
			onMetaChange(next);
		}
		setCapDialogOpen(false);
	};

	return (
		<div className="generator-regions">
			{polygonSelections.length === 0 && (
				<div className="generator-regions__hint">
					{t("Draw a polygon on the map or hold")} <kbd>{t("Q")}</kbd>{" "}
					{t("+ click to select a country outline.")}
				</div>
			)}
			<div className="generator-regions__controls">
				<label className="generator-regions__target-label">
					{t("Locations per region:")}
					<TextInput
						type="number"
						min={1}
						value={defaultTarget}
						onChange={(e) => onDefaultTargetChange(Number(e.target.value) || 10)}
						style={{ width: "5.5rem" }}
					/>
				</label>
				<Button
					style={{ fontSize: "inherit" }}
					disabled={polygonSelections.length === 0}
					onClick={() => {
						setCapInput("");
						setCapDialogOpen(true);
					}}
				>
					{t("Change all caps")}
				</Button>
			</div>
			<Dialog open={capDialogOpen} onOpenChange={setCapDialogOpen}>
				<DialogContent title={t("Change all caps")}>
					<div className="generator-cap-dialog">
						<label className="generator-regions__target-label">
							{t("Locations cap for all regions:")}
							<TextInput
								type="number"
								min={1}
								autoFocus
								value={capInput}
								onChange={(e) => setCapInput(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && confirmCap()}
								style={{ width: "6rem" }}
							/>
						</label>
						<div className="generator-cap-dialog__actions">
							<Button variant="primary" onClick={confirmCap}>
								{t("Apply")}
							</Button>
							<Button onClick={() => setCapDialogOpen(false)}>{t("Cancel")}</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
			{polygonSelections.length > 0 && (
				<>
					<div className="generator-regions__list">
						{polygonSelections.map((sel) => {
							const m = meta.get(sel.key);
							return (
								<RegionRow
									key={sel.key}
									sel={sel}
									found={m?.found.length ?? 0}
									target={m?.target ?? defaultTarget}
									processing={m?.isProcessing ?? false}
									running={running}
									onTargetChange={(v) => setTarget(sel.key, v)}
								/>
							);
						})}
					</div>
					<TotalRow found={totalFound} target={totalTarget} running={running} />
				</>
			)}
		</div>
	);
}

function TotalRow({
	found,
	target,
	running,
}: {
	found: number;
	target: number;
	running: boolean;
}) {
	const rate = useFoundRate(found, target, running && found < target);
	return (
		<div className="generator-regions__total">
			{t("Total:")} {found} / {target}
			{rate != null && <span className="generator-regions__rate">{rateLabel(rate)}</span>}
		</div>
	);
}
