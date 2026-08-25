import type {
	GeneratorSettings,
	GeneratorRegion,
	GeneratedLocation,
	GenerationCallbacks,
} from "./types";
import {
	randomPointInBounds,
	getBoundingBox,
	pointInGeoJsonGeometry,
	poissonDiskSample,
} from "./geo";
import { blueLineSample } from "./blueLineSampler";
import { passesInitialFilters, passesDateFilters, isPanoGood, computeHeading } from "./filters";
import { svMetadata } from "@/lib/sv/query";
import { PanoType } from "@/types";
import type { Pano } from "@/types";
import { imageDateOf } from "@/lib/sv/getMetadata";
import { panosAt } from "@/lib/sv/query";
import { distMeters, lerpLng, unionBounds } from "@/lib/geo/geo";
import { searchCoverage } from "../searchCoverage";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { chunk } from "@/lib/util/util";
import type { Bounds, LatLng } from "@/types";

export class GenerationEngine {
	private settings: GeneratorSettings;
	private regions: GeneratorRegion[];
	private callbacks: GenerationCallbacks;
	private running = false;
	private paused = false;
	private pauseResolvers: (() => void)[] = [];
	private cancelledRegions = new Set<string>();
	private regionTasks: Promise<void>[] = [];
	private liveRegionIds = new Set<string>();
	private globalFoundPanoIds = new Set<string>();
	private pendingBatch: GeneratedLocation[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private poissonPoints = new Map<string, LatLng[]>();
	private poissonIndex = new Map<string, number>();
	private bluelinePoints = new Map<string, LatLng[]>();
	private bluelineIndex = new Map<string, number>();

	constructor(
		settings: GeneratorSettings,
		regions: GeneratorRegion[],
		callbacks: GenerationCallbacks,
	) {
		this.settings = settings;
		this.regions = regions;
		this.callbacks = callbacks;
	}

	replaceCallbacks(callbacks: GenerationCallbacks) {
		this.callbacks = callbacks;
	}

	// Live-apply settings mid-job. Most settings are read fresh on every probe, so they
	// take effect immediately. numGenerators and oneCountryAtATime are fixed at start().
	updateSettings(settings: GeneratorSettings) {
		this.settings = settings;
	}

	async start(): Promise<void> {
		this.running = true;
		this.beginSearchOverlay();
		try {
			if (this.settings.oneCountryAtATime) {
				this.regionTasks.push(this.runSequential());
			} else {
				for (const region of this.regions) {
					this.regionTasks.push(this.runRegionWorkers(region, this.settings.numGenerators));
				}
			}
			// Drain dynamically: reconcileRegions() can push new tasks while we await.
			while (this.regionTasks.length) {
				await Promise.all(this.regionTasks.splice(0));
			}
		} finally {
			this.flushBatch();
			this.running = false;
			this.callbacks.onDone();
		}
	}

	// One worker per region, finishing each before the next (oneCountryAtATime).
	// Skips regions already running as a reconcile-added worker, or cancelled.
	private async runSequential(): Promise<void> {
		for (let i = 0; i < this.regions.length; i++) {
			if (!this.running) return;
			const region = this.regions[i];
			if (this.cancelledRegions.has(region.id) || this.liveRegionIds.has(region.id)) continue;
			this.liveRegionIds.add(region.id);
			await this.generateRegion(region);
			this.liveRegionIds.delete(region.id);
		}
	}

	private runRegionWorkers(region: GeneratorRegion, count: number): Promise<void> {
		this.liveRegionIds.add(region.id);
		const workers: Promise<void>[] = [];
		for (let i = 0; i < count; i++) workers.push(this.generateRegion(region));
		return Promise.all(workers).then(() => {
			this.liveRegionIds.delete(region.id);
		});
	}

	// Apply a region set change to a running job. Intended to be called while paused
	// (parked workers see cancellation / new workers park immediately), then resume().
	reconcileRegions(desired: GeneratorRegion[]): void {
		if (!this.running) return;
		const desiredIds = new Set(desired.map((r) => r.id));

		for (const region of this.regions) {
			if (!desiredIds.has(region.id)) this.cancelledRegions.add(region.id);
		}

		const count = this.settings.oneCountryAtATime ? 1 : this.settings.numGenerators;
		for (const region of desired) {
			this.cancelledRegions.delete(region.id); // revive if previously removed
			const existing = this.regions.find((r) => r.id === region.id);
			if (existing) existing.target = region.target;
			if (this.liveRegionIds.has(region.id)) continue; // already working (or parked)
			if (!existing) this.regions.push(region);
			this.regionTasks.push(this.runRegionWorkers(existing ?? region, count));
		}

		const b = this.searchOverlayBounds();
		if (b) searchCoverage.growSession(b, this.settings.radius);
	}

	// Live-apply per-region target changes mid-job; workers re-read target every probe.
	updateRegionTargets(targets: ReadonlyMap<string, number>): void {
		for (const region of this.regions) {
			const t = targets.get(region.id);
			if (t != null) region.target = t;
		}
	}

	pause(): void {
		this.flushBatch(); // commit confirmed-but-buffered finds so they land on the map immediately
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		const resolvers = this.pauseResolvers.splice(0);
		for (const resolve of resolvers) resolve();
		this.flushBatch(); // flush any locations held back while paused
	}

	stop(): void {
		this.flushBatch(); // commit confirmed finds before teardown (running still true here)
		this.running = false;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingBatch.length = 0;
		this.resume();
		searchCoverage.endSession();
	}

	/** Every region's box, padded by the probe radius so a disc at the edge still lands. */
	private searchOverlayBounds(): Bounds | null {
		if (this.regions.length === 0) return null;
		let bounds: Bounds | null = null;
		for (const region of this.regions) {
			const bb = getBoundingBox(region.feature);
			if (bb) bounds = bounds ? unionBounds(bounds, bb) : bb;
		}
		if (!bounds) return null;
		const { west, south, east, north } = bounds;
		const r = this.settings.radius;
		const midLat = (south + north) / 2;
		const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180) || 1;
		return {
			west: west - r / mPerDegLng,
			south: south - r / 111320,
			east: east + r / mPerDegLng,
			north: north + r / 111320,
		};
	}

	private beginSearchOverlay(): void {
		const b = this.searchOverlayBounds();
		if (b) searchCoverage.beginSession(b, this.settings.radius);
	}

	isRunning(): boolean {
		return this.running;
	}
	isPaused(): boolean {
		return this.paused;
	}

	private async waitIfPaused(): Promise<void> {
		if (!this.paused) return;
		await new Promise<void>((resolve) => {
			this.pauseResolvers.push(resolve);
		});
	}

	private async generateRegion(region: GeneratorRegion): Promise<void> {
		const mode = this.settings.samplingMode;
		if (mode === "poisson") await this.generateRegionPoisson(region);
		else if (mode === "blueline") await this.generateRegionBlueline(region);
		else if (mode === "kernels") await this.generateRegionKernels(region);
		else await this.generateRegionRandom(region);

		region.isProcessing = false;
		this.callbacks.onRegionComplete(region.id);
	}

	private async generateRegionPoisson(region: GeneratorRegion): Promise<void> {
		if (!this.poissonPoints.has(region.id)) {
			const points = poissonDiskSample(region.feature, 2 * this.settings.radius);
			this.poissonPoints.set(region.id, points);
			this.poissonIndex.set(region.id, 0);
			log.info(`[generator] Poisson disk: ${points.length} probes for ${region.name}`);
		}
		const allPoints = this.poissonPoints.get(region.id)!;

		while (
			region.found.length < region.target &&
			this.running &&
			!this.cancelledRegions.has(region.id)
		) {
			await this.waitIfPaused();
			if (!this.running || this.cancelledRegions.has(region.id)) break;

			region.isProcessing = true;
			const startIdx = this.poissonIndex.get(region.id) ?? 0;
			const endIdx = Math.min(startIdx + this.settings.speed, allPoints.length);
			this.poissonIndex.set(region.id, endIdx);
			let coords = allPoints.slice(startIdx, endIdx);
			if (coords.length === 0) break;

			if (this.settings.skipExisting) {
				try {
					// eslint-disable-next-line local/no-ipc-in-loop -- bulk form: one IPC per batch
					const near = await cmd.storeNearAny(
						coords.map((c) => c.lat),
						coords.map((c) => c.lng),
						this.settings.skipExistingRadius,
					);
					coords = coords.filter((_, i) => !near[i]);
				} catch (e) {
					log.warn("[generator] storeNearAny failed, probing unfiltered:", e);
				}
			}
			if (coords.length === 0) continue;

			const batchSize = this.settings.findRegions ? 1 : 75;
			for (const batch of chunk(coords, batchSize)) {
				if (
					!this.running ||
					this.cancelledRegions.has(region.id) ||
					region.found.length >= region.target
				)
					break;
				await this.waitIfPaused();
				await this.probeCoords(batch, region);
			}
		}

		this.poissonPoints.delete(region.id);
		this.poissonIndex.delete(region.id);
	}

	private async generateRegionBlueline(region: GeneratorRegion): Promise<void> {
		if (!this.bluelinePoints.has(region.id)) {
			const points = await blueLineSample(region.feature);
			this.bluelinePoints.set(region.id, points);
			this.bluelineIndex.set(region.id, 0);
		}
		const allPoints = this.bluelinePoints.get(region.id)!;

		while (
			region.found.length < region.target &&
			this.running &&
			!this.cancelledRegions.has(region.id)
		) {
			await this.waitIfPaused();
			if (!this.running || this.cancelledRegions.has(region.id)) break;

			region.isProcessing = true;
			const startIdx = this.bluelineIndex.get(region.id) ?? 0;
			const endIdx = Math.min(startIdx + this.settings.speed, allPoints.length);
			this.bluelineIndex.set(region.id, endIdx);
			let coords = allPoints.slice(startIdx, endIdx);
			if (coords.length === 0) break;

			if (this.settings.skipExisting) {
				try {
					// eslint-disable-next-line local/no-ipc-in-loop -- bulk form: one IPC per batch
					const near = await cmd.storeNearAny(
						coords.map((c) => c.lat),
						coords.map((c) => c.lng),
						this.settings.skipExistingRadius,
					);
					coords = coords.filter((_, i) => !near[i]);
				} catch (e) {
					log.warn("[generator] storeNearAny failed, probing unfiltered:", e);
				}
			}
			if (coords.length === 0) continue;

			const batchSize = this.settings.findRegions ? 1 : 75;
			for (const batch of chunk(coords, batchSize)) {
				if (
					!this.running ||
					this.cancelledRegions.has(region.id) ||
					region.found.length >= region.target
				)
					break;
				await this.waitIfPaused();
				await this.probeCoords(batch, region);
			}
		}

		this.bluelinePoints.delete(region.id);
		this.bluelineIndex.delete(region.id);
	}

	private async generateRegionKernels(region: GeneratorRegion): Promise<void> {
		const bounds = getBoundingBox(region.feature);
		if (!bounds) return;
		const { east, north, south } = bounds;
		const centroidLat = (south + north) / 2;
		const centroidLng = lerpLng(bounds, 0.5);
		const coveringRadius = distMeters(
			{ lat: centroidLat, lng: centroidLng },
			{ lat: north, lng: east },
		);

		let seeds: string[];
		try {
			const locs = await cmd.storeFindNearby(centroidLat, centroidLng, coveringRadius);
			seeds = locs
				.filter((l) => l.panoId && pointInGeoJsonGeometry(l.lng, l.lat, region.feature.geometry))
				.map((l) => l.panoId!);
		} catch (e) {
			log.warn("[generator] Failed to fetch seed locations:", e);
			return;
		}

		if (seeds.length === 0) {
			log.warn(`[generator] Kernels: no existing locations with panoId in ${region.name}`);
			return;
		}
		log.info(`[generator] Kernels: ${seeds.length} seeds in ${region.name}`);

		const visited = region.checkedPanos;
		const depthMap = new Map<string, number>();
		const queue: string[] = [];
		for (const id of seeds) {
			if (!visited.has(id)) {
				visited.add(id);
				queue.push(id);
				depthMap.set(id, 0);
			}
		}

		const maxDepth = this.settings.linksDepth;
		const s = this.settings;

		while (
			queue.length > 0 &&
			region.found.length < region.target &&
			this.running &&
			!this.cancelledRegions.has(region.id)
		) {
			await this.waitIfPaused();
			if (!this.running || this.cancelledRegions.has(region.id)) break;

			region.isProcessing = true;
			const frontier = queue.splice(0, Math.max(s.speed, 50));
			const results = await svMetadata(frontier);

			for (let i = 0; i < results.length; i++) {
				if (region.found.length >= region.target) break;

				const pano = results[i];
				if (!pano) continue;

				const lat = pano.lat;
				const lng = pano.lng;
				if (!pointInGeoJsonGeometry(lng, lat, region.feature.geometry)) continue;

				let depth = depthMap.get(frontier[i]) ?? 0;

				// a find resets depth
				if (isPanoGood(pano, s)) {
					await this.finalizeLoc(pano, region);
					depth = 0;
				} else if (++depth > maxDepth) {
					continue;
				}

				for (const link of pano.links) {
					if (link.pano && !visited.has(link.pano)) {
						visited.add(link.pano);
						queue.push(link.pano);
						depthMap.set(link.pano, depth);
					}
				}
				if (s.checkAllDates && pano.time) {
					for (const entry of pano.time) {
						if (entry.pano && !visited.has(entry.pano)) {
							visited.add(entry.pano);
							queue.push(entry.pano);
							depthMap.set(entry.pano, depth);
						}
					}
				}
			}
		}
	}

	private async generateRegionRandom(region: GeneratorRegion): Promise<void> {
		const bounds = getBoundingBox(region.feature);
		if (!bounds) return;
		let coveredRounds = 0;

		while (
			region.found.length < region.target &&
			this.running &&
			!this.cancelledRegions.has(region.id)
		) {
			await this.waitIfPaused();
			if (!this.running || this.cancelledRegions.has(region.id)) return;

			region.isProcessing = true;
			const n = Math.min(region.target * 100, this.settings.speed);
			let randomCoords: LatLng[] = [];
			let attempts = 0;
			const maxAttempts = n * 200;
			while (randomCoords.length < n && attempts < maxAttempts) {
				attempts++;
				const pt = randomPointInBounds(bounds);
				if (pointInGeoJsonGeometry(pt.lng, pt.lat, region.feature.geometry)) {
					randomCoords.push(pt);
				}
			}
			if (this.settings.skipExisting && randomCoords.length > 0) {
				try {
					// eslint-disable-next-line local/no-ipc-in-loop -- bulk form: one IPC per batch
					const near = await cmd.storeNearAny(
						randomCoords.map((c) => c.lat),
						randomCoords.map((c) => c.lng),
						this.settings.skipExistingRadius,
					);
					randomCoords = randomCoords.filter((_, i) => !near[i]);
				} catch (e) {
					log.warn("[generator] storeNearAny failed, probing unfiltered:", e);
				}
				if (randomCoords.length === 0) {
					if (++coveredRounds >= 20) break;
					continue;
				}
				coveredRounds = 0;
			}
			if (randomCoords.length === 0) break;

			const batchSize = this.settings.findRegions ? 1 : 75;
			for (const batch of chunk(randomCoords, batchSize)) {
				if (
					!this.running ||
					this.cancelledRegions.has(region.id) ||
					region.found.length >= region.target
				)
					break;
				await this.waitIfPaused();
				await this.probeCoords(batch, region);
			}
		}
	}

	private async probeCoords(coords: LatLng[], region: GeneratorRegion): Promise<void> {
		for (const c of coords) searchCoverage.addProbe(c.lng, c.lat);
		const s = this.settings;

		// The search answers the metadata too, so there is no second lookup.
		const panos = (
			await panosAt(
				coords,
				s.radius,
				s.rejectUnofficial ? { sources: [PanoType.Official] } : undefined,
			)
		).filter((p) => p !== null);
		if (panos.length === 0) return;

		// Paused or stopped while the lookups were in flight: drop the results.
		if (!this.running || this.paused || this.cancelledRegions.has(region.id)) return;

		const seeds: string[] = [];
		for (let i = 0; i < panos.length; i++) {
			const pano = panos[i];
			if (!pano || !passesInitialFilters(pano, s)) continue;

			if (s.findRegions) {
				const coord = { lat: pano.lat, lng: pano.lng };
				if (region.found.some((f) => distMeters(f, coord) < s.regionRadius * 1000)) continue;
			}

			const dateResult = passesDateFilters(pano, s);
			if (dateResult === false) continue;

			if (s.randomInTimeline && pano.time?.length) {
				const entry = pano.time[Math.floor(Math.random() * pano.time.length)];
				if (entry.date) {
					const ym = entry.date.slice(0, 7);
					if (Date.parse(ym) < Date.parse(s.fromDate) || Date.parse(ym) > Date.parse(s.toDate)) {
						continue;
					}
				}
				seeds.push(entry.pano);
				continue;
			}

			if (dateResult === "checkAll" && pano.time) {
				const fromDate = Date.parse(s.fromDate);
				const toDate = Date.parse(s.toDate);
				for (const entry of pano.time) {
					if (s.rejectUnofficial && entry.pano.length !== 22) continue;
					if (!entry.date) continue;
					const ym = entry.date.slice(0, 7);
					if (Date.parse(ym) >= fromDate && Date.parse(ym) <= toDate) seeds.push(entry.pano);
				}
			} else {
				seeds.push(pano.pano);
			}
		}

		this.walk(seeds, region, 0);
	}

	/** The walk runs alongside the probing rather than holding it up, so a region keeps
	 *  sampling while earlier finds are still opening up. */
	private walk(ids: string[], region: GeneratorRegion, depth: number): void {
		void this.walkPanos(ids, region, depth).catch((e) => {
			log.warn("[generator] link walk failed:", e);
		});
	}

	/** Walks a level of the link/timeline graph: every id at `depth` is fetched in one
	 *  batch, and what each one opens up is walked as the next level. A pano that passes
	 *  resets the depth of what it leads to, which is what lets a good stretch keep
	 *  going while a dead one bottoms out at `linksDepth`. */
	private async walkPanos(ids: string[], region: GeneratorRegion, depth: number): Promise<void> {
		if (!this.running || this.paused || this.cancelledRegions.has(region.id)) return;
		const s = this.settings;
		if (depth > s.linksDepth) return;
		if (region.found.length >= region.target) return;

		const fresh = ids.filter((id) => id && !region.checkedPanos.has(id));
		if (fresh.length === 0) return;
		for (const id of fresh) region.checkedPanos.add(id);

		const panos = await svMetadata(fresh);
		if (!this.running || this.paused || this.cancelledRegions.has(region.id)) return;

		// A pano that passed sends what it opens up back to depth 1; everything else sinks.
		const fromGood: string[] = [];
		const deeper: string[] = [];

		for (const pano of panos) {
			if (!pano) continue;
			const inRegion = pointInGeoJsonGeometry(pano.lng, pano.lat, region.feature.geometry);
			const good = isPanoGood(pano, s) && inRegion;
			const next = good ? fromGood : deeper;

			if (s.checkAllDates && !s.selectMonths && pano.time) {
				const fromDate = Date.parse(s.fromDate);
				const toDate = Date.parse(s.toDate);
				for (const entry of pano.time) {
					if (s.rejectUnofficial && entry.pano.length !== 22) continue;
					if (!entry.date) continue;
					const ym = entry.date.slice(0, 7);
					if (Date.parse(ym) >= fromDate && Date.parse(ym) <= toDate) next.push(entry.pano);
				}
			}

			if (s.checkLinks) {
				for (const link of pano.links) if (link.pano) next.push(link.pano);
				for (const entry of pano.time) next.push(entry.pano);
			}

			if (good) void this.finalizeLoc(pano, region);
		}

		this.walk(fromGood, region, 1);
		this.walk(deeper, region, depth + 1);
	}

	private async finalizeLoc(pano: Pano, region: GeneratorRegion): Promise<void> {
		if (!this.running || this.paused || this.cancelledRegions.has(region.id)) return;
		const s = this.settings;
		const panoId: string = pano.pano;

		if (this.globalFoundPanoIds.has(panoId)) return;
		if (region.found.length >= region.target) return;

		this.globalFoundPanoIds.add(panoId);

		// A link-walked or snapped pano can sit near an existing location even when
		// its probe coordinate didn't — final skip-existing gate before accepting.
		if (s.skipExisting) {
			try {
				const covered = await cmd.storeNearAny([pano.lat], [pano.lng], s.skipExistingRadius);
				if (covered[0]) return;
			} catch (e) {
				log.warn("[generator] storeNearAny failed, accepting unchecked:", e);
			}
			if (!this.running || this.paused || this.cancelledRegions.has(region.id)) return;
			if (region.found.length >= region.target) return;
		}

		const loc: GeneratedLocation = {
			panoId,
			lat: pano.lat,
			lng: pano.lng,
			heading: computeHeading(pano, s),
			pitch: s.adjustPitch ? s.pitchDeviation : 0,
			zoom: s.adjustZoom ? s.zoomLevel : 0,
			imageDate: imageDateOf(pano) || null,
		};

		region.found.push(loc);
		this.pendingBatch.push(loc);
		this.callbacks.onProgress(region.id, region.found.length, region.target);

		if (this.pendingBatch.length >= 200) {
			this.flushBatch();
		} else if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => this.flushBatch(), 1000);
		}
	}

	private flushBatch(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.pendingBatch.length === 0 || !this.running || this.paused) return;
		const batch = this.pendingBatch.splice(0);
		this.callbacks.onLocationsFound(batch);
	}
}
