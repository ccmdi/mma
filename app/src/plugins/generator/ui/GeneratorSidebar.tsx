import { useState, useRef, useCallback, useEffect } from "react";
import { createLocation, LocationFlag } from "@/types";
import type { GeneratorSettings, GeneratorRegion, GeneratorRegionMeta, GeneratedLocation } from "../engine/types";
import { DEFAULT_SETTINGS } from "../engine/types";
import { GenerationEngine } from "../engine/GenerationEngine";
import { RegionSelector } from "./RegionSelector";
import { SettingsPanel } from "./SettingsPanel";
import { ProgressDisplay } from "./ProgressDisplay";
import { google } from "@/lib/sv/opensv";
import { getSelections, getCurrentMap, createTags } from "@/store/useMapStore";
import type { Selection } from "@/store/selections";
import { Icon } from "@/components/primitives/Icon";
import { mdiArrowLeft } from "@mdi/js";
import "./generator.css";

const STORAGE_KEY = "mma_generator_settings";

function loadSettings(): GeneratorSettings {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
	} catch {
		// ignored
	}
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: GeneratorSettings) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function generatedToLocation(loc: GeneratedLocation, tagId: number | null) {
	return createLocation({
		lat: loc.lat,
		lng: loc.lng,
		heading: loc.heading,
		pitch: loc.pitch,
		panoId: loc.panoId,
		flags: LocationFlag.LoadAsPanoId,
		...(tagId != null ? { tags: [tagId] } : {}),
		...(loc.imageDate ? { extra: { imageDate: loc.imageDate } } : {}),
	});
}

async function resolveGeneratedLocationTag(): Promise<number | null> {
	const tagName = getCurrentMap()?.meta.settings?.generatedLocationTag;
	if (!tagName) return null;
	const [tag] = await createTags([tagName]);
	return tag.id;
}

function selectionToRegion(sel: Selection, meta: GeneratorRegionMeta): GeneratorRegion | null {
	if (sel.props.type !== "Polygon") return null;
	const poly = sel.props.polygon;
	const name = poly.properties?.name || "Unnamed polygon";
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

export function GeneratorSidebar({ onClose }: { onClose: () => void }) {
	const [settings, setSettings] = useState<GeneratorSettings>(loadSettings);
	const [meta, setMeta] = useState<Map<string, GeneratorRegionMeta>>(sessionMeta);
	const [running, setRunning] = useState(sessionRunning);
	const [paused, setPaused] = useState(sessionPaused);
	const [, rerender] = useState(0);
	const engineRef = useRef<GenerationEngine | null>(sessionEngine);

	useEffect(() => { sessionMeta = meta; }, [meta]);
	useEffect(() => { sessionRunning = running; }, [running]);
	useEffect(() => { sessionPaused = paused; }, [paused]);

	// If engine is still running from before remount, wire up callbacks
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !running) return;
		const tagId = sessionTagId;
		engine.replaceCallbacks({
			onLocationsFound: (locs: GeneratedLocation[]) => {
				MMA.addLocations(locs.map((l) => generatedToLocation(l, tagId)));
				rerender((n) => n + 1);
			},
			onProgress: () => {
				rerender((n) => n + 1);
			},
			onRegionComplete: () => {
				rerender((n) => n + 1);
			},
			onDone: () => {
				setRunning(false);
				setPaused(false);
				engineRef.current = null;
				sessionEngine = null;
			},
		});
	}, [running]);

	const updateSettings = useCallback((patch: Partial<GeneratorSettings>) => {
		setSettings((prev) => {
			const next = { ...prev, ...patch };
			saveSettings(next);
			return next;
		});
	}, []);

	const handleStart = useCallback(async () => {
		const sels = getSelections().filter((s) => s.props.type === "Polygon");
		if (sels.length === 0) return;
		if (!google) return;

		const tagId = await resolveGeneratedLocationTag();
		sessionTagId = tagId;

		// Reset metadata for selected regions
		const nextMeta = new Map(sessionMeta);
		const regions: GeneratorRegion[] = [];
		for (const sel of sels) {
			const m = nextMeta.get(sel.key) ?? { target: settings.defaultTarget, found: [], checkedPanos: new Set(), isProcessing: false };
			m.found = [];
			m.checkedPanos = new Set();
			m.isProcessing = false;
			nextMeta.set(sel.key, m);
			const region = selectionToRegion(sel, m);
			if (region) regions.push(region);
		}
		setMeta(nextMeta);

		const engine = new GenerationEngine(google, settings, regions, {
			onLocationsFound: (locs: GeneratedLocation[]) => {
				MMA.addLocations(locs.map((l) => generatedToLocation(l, tagId)));
				rerender((n) => n + 1);
			},
			onProgress: () => {
				rerender((n) => n + 1);
			},
			onRegionComplete: () => {
				rerender((n) => n + 1);
			},
			onDone: () => {
				setRunning(false);
				setPaused(false);
				engineRef.current = null;
				sessionEngine = null;
			},
		});

		engineRef.current = engine;
		sessionEngine = engine;
		setRunning(true);
		setPaused(false);
		engine.start();
	}, [settings]);

	const handlePause = useCallback(() => {
		const engine = engineRef.current;
		if (!engine) return;
		if (engine.isPaused()) {
			engine.resume();
			setPaused(false);
		} else {
			engine.pause();
			setPaused(true);
		}
	}, []);

	const handleStop = useCallback(() => {
		engineRef.current?.stop();
		setRunning(false);
		setPaused(false);
		engineRef.current = null;
		sessionEngine = null;
	}, []);

	const handleClose = useCallback(() => {
		engineRef.current?.stop();
		sessionEngine = null;
		sessionRunning = false;
		sessionPaused = false;
		onClose();
	}, [onClose]);

	// Build regions from current selections + meta for progress display
	const regions: GeneratorRegion[] = [];
	const sels = getSelections().filter((s) => s.props.type === "Polygon");
	for (const sel of sels) {
		const m = meta.get(sel.key);
		if (m) {
			const region = selectionToRegion(sel, m);
			if (region) regions.push(region);
		}
	}

	return (
		<section className="map-sidebar generator-sidebar">
			<header className="generator-sidebar__header">
				<button className="icon-button" onClick={handleClose}>
					<Icon path={mdiArrowLeft} />
				</button>
				<h2 className="generator-sidebar__title">Map Generator</h2>
			</header>

			<div className="generator-sidebar__body">
				<div className="generator-sidebar__section">
					<RegionSelector
						defaultTarget={settings.defaultTarget}
						onDefaultTargetChange={(v) => updateSettings({ defaultTarget: v })}
						meta={meta}
						onMetaChange={setMeta}
					/>
				</div>

				<div className="generator-sidebar__section">
					<SettingsPanel settings={settings} onChange={updateSettings} />
				</div>

				<div className="generator-sidebar__actions">
					{!running ? (
						<button
							className="button button--primary"
							onClick={handleStart}
							disabled={sels.length === 0}
						>
							Start
						</button>
					) : (
						<>
							<button className="button" onClick={handlePause}>
								{paused ? "Resume" : "Pause"}
							</button>
							<button className="button" onClick={handleStop}>
								Stop
							</button>
						</>
					)}
				</div>

				{running && regions.length > 0 && (
					<div className="generator-sidebar__section">
						<ProgressDisplay regions={regions} />
					</div>
				)}
			</div>
		</section>
	);
}
