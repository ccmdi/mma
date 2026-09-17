import { LocationFlag } from "@/bindings.consts";
import { t } from "@/lib/i18n";
import { registerJob, type JobHandle } from "@/lib/jobs";
import { fmt } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { definePluginEvent, emitPluginEvent } from "@/plugins/pluginEvents";
import { createTags, setPluginMode } from "@/store/useMapStore";
import { createLocation } from "@/types";
import { GenerationEngine } from "./engine/GenerationEngine";
import type {
	GeneratedLocation,
	GeneratorRegion,
	GeneratorSettings,
	GeneratorStats,
} from "./engine/types";
import { searchCoverage } from "./searchCoverage";

export type GeneratorStatus = "idle" | "running" | "paused";

export const GENERATOR_CHANGED = definePluginEvent("map-generator", "changed");

interface Run {
	engine: GenerationEngine;
	job: JobHandle;
}

let run: Run | null = null;
let sidebarOpen = false;
let frameQueued = false;

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

// Finds arrive one pano at a time; the region list and the tray hear about them once a frame.
function progressFrame(): void {
	if (frameQueued) return;
	frameQueued = true;
	requestAnimationFrame(() => {
		frameQueued = false;
		if (run) {
			const { found, target } = run.engine.progress();
			run.job.update(
				target > 0 ? Math.min(found / target, 1) : 0,
				`${fmt.format(found)} / ${fmt.format(target)}`,
			);
		}
		emitPluginEvent(GENERATOR_CHANGED);
	});
}

export function getGeneratorStatus(): GeneratorStatus {
	if (!run) return "idle";
	return run.engine.isPaused() ? "paused" : "running";
}

let lastStats: GeneratorStats | null = null;

/** The live run's stats, or the last run's once it settled. */
export function getGeneratorStats(): GeneratorStats | null {
	return run ? run.engine.stats() : lastStats;
}

/** Generate over `regions`, tagging finds with `tagName`. False while a run is already live,
 *  so a double click starts one run. */
export function startGeneration(
	settings: GeneratorSettings,
	regions: GeneratorRegion[],
	tagName: string,
): boolean {
	if (run) return false;
	let tagId: number | null = null;
	const engine = new GenerationEngine(settings, regions, {
		onLocationsFound: (locs) => {
			void MMA.addLocations(locs.map((l) => generatedToLocation(l, tagId)));
			progressFrame();
		},
		onProgress: progressFrame,
		onRegionComplete: progressFrame,
		onDone: () => settle(engine, t("Generation complete")),
	});
	const job = registerJob(t("Map generator"), {
		scope: "map",
		cancel: () => stop(engine),
		reveal: () => setPluginMode("map-generator"),
	});
	job.setHidden(sidebarOpen);
	run = { engine, job };
	emitPluginEvent(GENERATOR_CHANGED);
	void resolveTagByName(tagName)
		.then((id) => {
			tagId = id;
			return engine.start();
		})
		.catch((e: unknown) => {
			log.error("[generator] run failed:", e);
			stop(engine);
		});
	return true;
}

/** Stop generating. Finds already confirmed are written; nothing lands after. */
export function stopGeneration(): void {
	if (run) stop(run.engine);
}

function stop(engine: GenerationEngine): void {
	engine.stop();
	settle(engine);
}

/** Retire `engine`'s run, and only that run. */
function settle(engine: GenerationEngine, message?: string): void {
	const current = run;
	if (current?.engine !== engine) return;
	lastStats = engine.stats();
	run = null;
	current.job.finish(sidebarOpen ? undefined : message);
	emitPluginEvent(GENERATOR_CHANGED);
}

export function pauseGeneration(): void {
	if (!run || run.engine.isPaused()) return;
	run.engine.pause();
	emitPluginEvent(GENERATOR_CHANGED);
}

/** Resume a paused run over `desired`, the regions selected now. */
export function resumeGeneration(desired: GeneratorRegion[]): void {
	if (!run || !run.engine.isPaused()) return;
	run.engine.reconcileRegions(desired);
	run.engine.resume();
	emitPluginEvent(GENERATOR_CHANGED);
}

export function updateGenerationSettings(settings: GeneratorSettings): void {
	run?.engine.updateSettings(settings);
}

export function updateGenerationTargets(targets: ReadonlyMap<string, number>): void {
	run?.engine.updateRegionTargets(targets);
}

/** The open sidebar shows the run itself, so its tray entry hides; closing it while idle
 *  clears the search overlay. */
export function setGeneratorSidebarOpen(open: boolean): void {
	sidebarOpen = open;
	run?.job.setHidden(open);
	if (!open && !run) searchCoverage.endSession();
}
