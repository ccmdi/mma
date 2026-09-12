import { useState, useRef, useCallback, useEffect } from "react";
import { createLocation } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import type {
	GeneratorSettings,
	GeneratorRegion,
	GeneratorRegionMeta,
	GeneratedLocation,
} from "../engine/types";
import { DEFAULT_SETTINGS, GENERATION_CAMERA_TYPE } from "../engine/types";
import { GenerationEngine } from "../engine/GenerationEngine";
import { RegionSelector } from "./RegionSelector";
import { SettingsPanel } from "./SettingsPanel";
import { tickProgress } from "./progressSignal";
import { google } from "@/lib/sv/opensv";
import { getActiveSelections, useMapState, createTags, setPluginMode } from "@/store/useMapStore";
import { registerJob, type JobHandle } from "@/lib/jobs";
import { subscribe } from "@/lib/events";
import { fmt } from "@/lib/util/format";
import type { Selection } from "@/bindings.gen";
import { createPluginStorage } from "@/plugins/registry";
import { Sidebar, Section } from "@/components/primitives/Sidebar";
import { searchCoverage } from "../searchCoverage";
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

function generatedToLocation({ imageDate, ...pano }: GeneratedLocation, tagId: number | null) {
	return createLocation({
		...pano,
		flags: LocationFlag.LoadAsPanoId,
		...(tagId != null ? { tags: [tagId] } : {}),
		...(imageDate ? { extra: { imageDate } } : {}),
	});
}

async function resolveTagByName(name: string): Promise<number | null> {
	if (!name) return null;
	const [tag] = await createTags([name]);
	return tag.id;
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
let sessionEngine: GenerationEngine | null = null;
let sessionRunning = false;
let sessionPaused = false;
let sessionTagId: number | null = null;
let sessionJob: JobHandle | null = null;
let sessionSidebarOpen = false;

let jobUpdateQueued = false;
// Coalesced to a frame like tickProgress: onProgress fires per found pano, and an
// eager jobs:changed per pano re-renders the tray that often.
function updateSessionJob(): void {
	if (!sessionEngine || !sessionJob || jobUpdateQueued) return;
	jobUpdateQueued = true;
	requestAnimationFrame(() => {
		jobUpdateQueued = false;
		if (!sessionEngine || !sessionJob) return;
		const { found, target } = sessionEngine.progress();
		sessionJob.update(
			target > 0 ? Math.min(found / target, 1) : 0,
			`${fmt.format(found)} / ${fmt.format(target)}`,
		);
	});
}

function endSessionJob(message?: string): void {
	sessionJob?.finish(sessionSidebarOpen ? undefined : message);
	sessionJob = null;
}

/** Stop the engine from outside the sidebar (job tray cancel, map close). */
function stopSessionEngine(): void {
	sessionEngine?.stop();
	sessionEngine = null;
	sessionRunning = false;
	sessionPaused = false;
	endSessionJob();
}

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
	const [running, setRunning] = useState(sessionRunning);
	const [paused, setPaused] = useState(sessionPaused);
	const [tagName, setTagName] = useState(() => genStore.get<string>("tagName", ""));
	const [, rerender] = useState(0);
	const engineRef = useRef<GenerationEngine | null>(sessionEngine);
	const selections = useMapState(getActiveSelections);

	useEffect(() => {
		sessionMeta = meta;
	}, [meta]);
	useEffect(() => {
		sessionRunning = running;
	}, [running]);
	useEffect(() => {
		sessionPaused = paused;
	}, [paused]);

	// An outside stop (job tray cancel, map close) ends the session while this sidebar
	// is mounted; follow it rather than claiming a run with no engine behind it.
	useEffect(
		() =>
			subscribe("jobs:changed", () => {
				if (sessionEngine || !engineRef.current) return;
				engineRef.current = null;
				setRunning(false);
				setPaused(false);
			}),
		[],
	);

	// If engine is still running from before remount, wire up callbacks
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !running) return;
		const tagId = sessionTagId;
		engine.replaceCallbacks({
			onLocationsFound: (locs: GeneratedLocation[]) => {
				void MMA.addLocations(locs.map((l) => generatedToLocation(l, tagId)));
				updateSessionJob();
				rerender((n) => n + 1);
			},
			onProgress: () => {
				tickProgress();
				updateSessionJob();
			},
			onRegionComplete: () => {
				rerender((n) => n + 1);
			},
			onDone: () => {
				setRunning(false);
				setPaused(false);
				engineRef.current = null;
				sessionEngine = null;
				endSessionJob(t("Generation complete"));
			},
		});
	}, [running]);

	// Drive the search-coverage overlay's visibility live from the toggle.
	useEffect(() => {
		searchCoverage.setEnabled(settings.showSearchOverlay);
	}, [settings.showSearchOverlay]);

	// Clear the overlay when leaving the generator, unless it's still running in the background.
	useEffect(() => {
		sessionSidebarOpen = true;
		sessionJob?.setHidden(true);
		return () => {
			sessionSidebarOpen = false;
			sessionJob?.setHidden(false);
			if (!sessionRunning) searchCoverage.endSession();
		};
	}, []);

	const updateSettings = useCallback((patch: Partial<GeneratorSettings>) => {
		setSettings((prev) => {
			const next = { ...prev, ...patch };
			saveSettings(next);
			engineRef.current?.updateSettings(next); // apply live to a running job
			return next;
		});
	}, []);

	const handleMetaChange = useCallback((next: Map<string, GeneratorRegionMeta>) => {
		setMeta(next);
		engineRef.current?.updateRegionTargets(new Map([...next].map(([k, m]) => [k, m.target])));
	}, []);

	const handleStart = useCallback(async () => {
		const sels = getActiveSelections().filter((s) => s.selector.type === "Polygon");
		if (sels.length === 0) return;
		if (!google) return;

		const tagId = await resolveTagByName(tagName);
		sessionTagId = tagId;

		// Reset metadata for selected regions
		const nextMeta = new Map(sessionMeta);
		const regions: GeneratorRegion[] = [];
		for (const sel of sels) {
			const m = nextMeta.get(sel.key) ?? {
				target: settings.defaultTarget,
				found: [],
				checkedPanos: new Set(),
				isProcessing: false,
			};
			m.found = [];
			m.checkedPanos = new Set();
			m.isProcessing = false;
			nextMeta.set(sel.key, m);
			const region = selectionToRegion(sel, m);
			if (region) regions.push(region);
		}
		setMeta(nextMeta);

		const engine = new GenerationEngine(settings, regions, {
			onLocationsFound: (locs: GeneratedLocation[]) => {
				void MMA.addLocations(locs.map((l) => generatedToLocation(l, tagId)));
				updateSessionJob();
				rerender((n) => n + 1);
			},
			onProgress: () => {
				tickProgress();
				updateSessionJob();
			},
			onRegionComplete: () => {
				rerender((n) => n + 1);
			},
			onDone: () => {
				setRunning(false);
				setPaused(false);
				engineRef.current = null;
				sessionEngine = null;
				endSessionJob(t("Generation complete"));
			},
		});

		engineRef.current = engine;
		sessionEngine = engine;
		sessionJob?.finish();
		sessionJob = registerJob(t("Map generator"), {
			scope: "map",
			cancel: stopSessionEngine,
			reveal: () => setPluginMode("map-generator"),
		});
		sessionJob.setHidden(true);
		setRunning(true);
		setPaused(false);
		void engine.start();
	}, [settings, tagName]);

	const handlePause = useCallback(() => {
		const engine = engineRef.current;
		if (!engine) return;
		if (engine.isPaused()) {
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
			engine.reconcileRegions(desired);
			engine.resume();
			setPaused(false);
		} else {
			engine.pause();
			setPaused(true);
		}
	}, [settings.defaultTarget]);

	const handleStop = useCallback(() => {
		stopSessionEngine();
		setRunning(false);
		setPaused(false);
		engineRef.current = null;
	}, []);

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
							onClick={() => void handleStart()}
							disabled={polygonSelections.length === 0}
						>
							{t("Start")}
						</Button>
					) : (
						<>
							<Button onClick={handlePause}>{paused ? t("Resume") : t("Pause")}</Button>
							<Button onClick={handleStop}>{t("Stop")}</Button>
						</>
					)}
				</div>
			</div>
		</Sidebar>
	);
}
