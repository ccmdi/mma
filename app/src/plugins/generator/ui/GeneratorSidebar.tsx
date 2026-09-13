import { useState, useCallback, useEffect } from "react";
import type { GeneratorSettings, GeneratorRegion, GeneratorRegionMeta } from "../engine/types";
import { DEFAULT_SETTINGS, GENERATION_CAMERA_TYPE } from "../engine/types";
import { RegionSelector } from "./RegionSelector";
import { SettingsPanel } from "./SettingsPanel";
import { google } from "@/lib/sv/opensv";
import { getActiveSelections, useMapState } from "@/store/useMapStore";
import { usePluginEvent } from "@/plugins/scope";
import type { Selection } from "@/bindings.gen";
import { createPluginStorage } from "@/plugins/registry";
import { Sidebar, Section } from "@/components/primitives/Sidebar";
import { searchCoverage } from "../searchCoverage";
import {
	GENERATOR_CHANGED,
	getGeneratorStatus,
	pauseGeneration,
	resumeGeneration,
	setGeneratorSidebarOpen,
	startGeneration,
	stopGeneration,
	updateGenerationSettings,
	updateGenerationTargets,
} from "../session";
import { MONTHS, ymParse } from "@/lib/util/date";
import { formatDistance } from "@/lib/util/format";
import "./generator.css";
import { t } from "@/lib/i18n";
import { fieldValueLabel, getFieldDef } from "@/lib/data/fieldDefRegistry";
import { TextInput } from "@/components/primitives/TextInput";
import { Button } from "@/components/primitives/Button";

const genStore = createPluginStorage("map-generator");

function loadSettings(): GeneratorSettings {
	const saved = genStore.get<Partial<GeneratorSettings>>("settings");
	return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(s: GeneratorSettings) {
	genStore.set("settings", s);
}

function selectionToRegion(sel: Selection, meta: GeneratorRegionMeta): GeneratorRegion | null {
	if (sel.selector.type !== "Polygon") return null;
	const poly = sel.selector.polygon;
	const name = poly.properties?.name || t("Unnamed polygon");
	const geometry = poly.extraPolygons
		? { type: "MultiPolygon" as const, coordinates: [poly.coordinates, ...poly.extraPolygons] }
		: { type: "Polygon" as const, coordinates: poly.coordinates };
	return {
		id: sel.key,
		name,
		feature: { type: "Feature", properties: { name }, geometry },
		found: meta.found,
		target: meta.target,
		checkedPanos: meta.checkedPanos,
		isProcessing: meta.isProcessing,
	};
}

let sessionMeta: Map<string, GeneratorRegionMeta> = new Map();

function formatYearMonth(ym: string) {
	const p = ymParse(ym);
	return p ? `${MONTHS.short[p.m - 1]} ${p.y}` : ym;
}

function summarizeSettings(s: GeneratorSettings): string {
	const parts: string[] = [];
	const camera = getFieldDef("cameraType");

	// Coverage type
	let coverage =
		s.rejectUnofficial && !s.rejectOfficial
			? t("official")
			: s.rejectOfficial && !s.rejectUnofficial
				? t("unofficial")
				: t("any");
	if (s.rejectGen1) coverage += ` ${t("(no {gen})", { gen: fieldValueLabel(camera, "gen1") })}`;
	if (s.findGeneration) {
		coverage += ` ${fieldValueLabel(camera, GENERATION_CAMERA_TYPE[s.generation])}`;
	}
	if (s.rejectDescription) coverage += ` ${t("trekker")}`;
	parts.push(t("{coverage} coverage", { coverage }));

	// Date range
	if (s.selectMonths) {
		parts.push(
			t("in {fromMonth}–{toMonth}, {fromYear}–{toYear}", {
				fromMonth: MONTHS.short[parseInt(s.fromMonth, 10) - 1],
				toMonth: MONTHS.short[parseInt(s.toMonth, 10) - 1],
				fromYear: s.fromYear,
				toYear: s.toYear,
			}),
		);
	} else {
		parts.push(
			t("between {from} and {to}", {
				from: formatYearMonth(s.fromDate),
				to: formatYearMonth(s.toDate),
			}),
		);
	}

	// Heading / pitch / zoom
	if (s.adjustHeading) {
		const ref =
			s.headingReference === "link"
				? t("along road")
				: s.headingReference === "forward"
					? t("forward")
					: t("backward");
		const facing = t("facing {ref}", { ref });
		parts.push(s.headingDeviation > 0 ? `${facing} ±${s.headingDeviation}°` : facing);
	}
	if (s.adjustPitch) parts.push(t("pitch ±{deviation}°", { deviation: s.pitchDeviation }));
	if (s.adjustZoom) parts.push(t("zoom {level}", { level: s.zoomLevel }));

	// Radius
	parts.push(t("{radius} radius", { radius: formatDistance(s.radius) }));
	if (s.samplingMode !== "random") parts.push(t("{mode} sampling", { mode: s.samplingMode }));

	// Date behavior
	if (s.checkAllDates) parts.push(t("checking all dates"));
	if (s.randomInTimeline) parts.push(t("random date in timeline"));

	// Acceptance toggles (only show non-default)
	if (!s.rejectDateless) parts.push(t("allowing dateless"));
	if (!s.rejectNoDescription) parts.push(t("allowing no-description"));
	if (s.onlyOneInTimeframe) parts.push(t("unique in timeframe"));

	// Search strategy
	if (s.skipExisting) {
		parts.push(t("skipping existing ({radius})", { radius: formatDistance(s.skipExistingRadius) }));
	}
	if (s.getIntersection) parts.push(t("intersections"));
	if (s.pinpointSearch) parts.push(t("curves >{angle}°", { angle: s.pinpointAngle }));
	if (s.checkLinks) {
		parts.push(
			t({ one: "checking {n} link hop", other: "checking {n} link hops" }, { n: s.linksDepth }),
		);
	}
	if (s.findRegions) {
		parts.push(t("{distance} from existing", { distance: formatDistance(s.regionRadius * 1000) }));
	}
	if (s.filterByLinks) parts.push(t("{min}–{max} links", { min: s.minLinks, max: s.maxLinks }));
	if (s.searchInDescription && s.searchTerms) {
		parts.push(
			s.searchFilterType === "include"
				? t('matching "{terms}"', { terms: s.searchTerms })
				: t('excluding "{terms}"', { terms: s.searchTerms }),
		);
	}

	// Parallelism
	if (s.numGenerators > 1) {
		parts.push(t({ one: "{n} worker", other: "{n} workers" }, { n: s.numGenerators }));
	}
	if (s.oneCountryAtATime) parts.push(t("one region at a time"));

	return parts.join(", ");
}

export function GeneratorSidebar({ onClose }: { onClose: () => void }) {
	const [settings, setSettings] = useState<GeneratorSettings>(loadSettings);
	const [meta, setMeta] = useState<Map<string, GeneratorRegionMeta>>(sessionMeta);
	const [tagName, setTagName] = useState(() => genStore.get<string>("tagName", ""));
	const status = usePluginEvent(GENERATOR_CHANGED, getGeneratorStatus);
	const running = status !== "idle";
	const paused = status === "paused";
	const selections = useMapState(getActiveSelections);

	useEffect(() => {
		sessionMeta = meta;
	}, [meta]);

	// Drive the search-coverage overlay's visibility live from the toggle.
	useEffect(() => {
		searchCoverage.setEnabled(settings.showSearchOverlay);
	}, [settings.showSearchOverlay]);

	useEffect(() => {
		setGeneratorSidebarOpen(true);
		return () => setGeneratorSidebarOpen(false);
	}, []);

	const updateSettings = useCallback((patch: Partial<GeneratorSettings>) => {
		setSettings((prev) => {
			const next = { ...prev, ...patch };
			saveSettings(next);
			updateGenerationSettings(next);
			return next;
		});
	}, []);

	const handleMetaChange = useCallback((next: Map<string, GeneratorRegionMeta>) => {
		setMeta(next);
		updateGenerationTargets(new Map([...next].map(([k, m]) => [k, m.target])));
	}, []);

	const handleStart = useCallback(() => {
		const sels = getActiveSelections().filter((s) => s.selector.type === "Polygon");
		if (sels.length === 0) return;
		if (!google) return;

		// Fresh metadata for the selected regions, kept only if the run starts
		const nextMeta = new Map(sessionMeta);
		const regions: GeneratorRegion[] = [];
		for (const sel of sels) {
			const m: GeneratorRegionMeta = {
				target: nextMeta.get(sel.key)?.target ?? settings.defaultTarget,
				found: [],
				checkedPanos: new Set(),
				isProcessing: false,
			};
			nextMeta.set(sel.key, m);
			const region = selectionToRegion(sel, m);
			if (region) regions.push(region);
		}
		if (startGeneration(settings, regions, tagName)) setMeta(nextMeta);
	}, [settings, tagName]);

	const handlePause = useCallback(() => {
		if (!paused) {
			pauseGeneration();
			return;
		}
		const sels = getActiveSelections().filter((s) => s.selector.type === "Polygon");
		const nextMeta = new Map(sessionMeta);
		const desired: GeneratorRegion[] = [];
		for (const sel of sels) {
			const m = nextMeta.get(sel.key) ?? {
				target: settings.defaultTarget,
				found: [],
				checkedPanos: new Set(),
				isProcessing: false,
			};
			nextMeta.set(sel.key, m);
			const region = selectionToRegion(sel, m);
			if (region) desired.push(region);
		}
		setMeta(nextMeta);
		resumeGeneration(desired);
	}, [paused, settings.defaultTarget]);

	const handleClose = useCallback(() => {
		onClose();
	}, [onClose]);

	const polygonSelections = selections.filter((s) => s.selector.type === "Polygon");

	return (
		<Sidebar title={t("Map Generator")} onBack={handleClose} className="generator-sidebar">
			<Section title={t("Regions ({n})", { n: polygonSelections.length })}>
				<RegionSelector
					defaultTarget={settings.defaultTarget}
					onDefaultTargetChange={(v) => updateSettings({ defaultTarget: v })}
					meta={meta}
					onMetaChange={handleMetaChange}
					running={running}
				/>
			</Section>

			<SettingsPanel settings={settings} onChange={updateSettings} />

			<Section title={t("Output")}>
				<label className="settings-popup__item settings-popup__select">
					{t("Tag as:")}
					<TextInput
						type="text"
						value={tagName}
						onChange={(e) => {
							setTagName(e.target.value);
							genStore.set("tagName", e.target.value);
						}}
						placeholder={t("None")}
						disabled={running}
					/>
				</label>
			</Section>

			<div className="generator-sidebar__footer">
				<p className="generator-sidebar__summary">{summarizeSettings(settings)}</p>
				<div className="generator-sidebar__actions">
					{!running ? (
						<Button
							variant="primary"
							onClick={handleStart}
							disabled={polygonSelections.length === 0}
						>
							{t("Start")}
						</Button>
					) : (
						<>
							<Button onClick={handlePause}>{paused ? t("Resume") : t("Pause")}</Button>
							<Button onClick={stopGeneration}>{t("Stop")}</Button>
						</>
					)}
				</div>
			</div>
		</Sidebar>
	);
}
