import { useEffect, useEffectEvent, useState } from "react";
import { useMapState, getActiveSelections } from "@/store/useMapStore";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import type { Selection } from "@/bindings.gen";
import type { GeneratorRegionMeta } from "../engine/types";
import { t } from "@/lib/i18n";

function getPolygonName(sel: Selection): string {
	if (sel.selector.type !== "Polygon") return sel.key;
	return sel.selector.polygon.properties?.name || t("Unnamed polygon");
}

function getPolygonCode(sel: Selection): string | undefined {
	if (sel.selector.type !== "Polygon") return undefined;
	return sel.selector.polygon.properties?.code;
}

export function RegionSelector({
	defaultTarget,
	onDefaultTargetChange,
	meta,
	onMetaChange,
}: {
	defaultTarget: number;
	onDefaultTargetChange: (v: number) => void;
	meta: Map<string, GeneratorRegionMeta>;
	onMetaChange: (meta: Map<string, GeneratorRegionMeta>) => void;
}) {
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
				<div className="generator-regions__list">
					{polygonSelections.map((sel) => {
						const name = getPolygonName(sel);
						const code = getPolygonCode(sel);
						const m = meta.get(sel.key);
						const found = m?.found.length ?? 0;
						const target = m?.target ?? defaultTarget;
						return (
							<div key={sel.key} className="generator-regions__item">
								<div className="generator-regions__item-name">
									{code && (
										<img
											src={`/flags/${code.toUpperCase()}.svg`}
											alt={code}
											width={20}
											height={15}
											style={{ borderRadius: 2, flexShrink: 0 }}
										/>
									)}
									<span>{name}</span>
								</div>
								<div className="generator-regions__item-count">
									{found} /
									<TextInput
										type="number"
										min={found || 1}
										value={target}
										onChange={(e) => setTarget(sel.key, Number(e.target.value) || 1)}
										style={{ width: "5rem", fontSize: "inherit" }}
									/>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
