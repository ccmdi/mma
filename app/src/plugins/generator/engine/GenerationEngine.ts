import type {
	GeneratorSettings,
	GeneratorRegion,
	GeneratorStats,
	GeneratedLocation,
	GenerationCallbacks,
	PointSource,
	SamplingMode,
} from "./types";
import { gridPointSource, pointsInOrder } from "./pointSources";
import { blueLineSource, DISTRIBUTION_EVENNESS } from "./blueLineSampler";
import { passesInitialFilters, passesDateFilters, isPanoGood, computeHeading } from "./filters";
import { svMetadata } from "@/lib/sv/query";
import { PanoType } from "@/bindings.consts";
import type { Pano } from "@/bindings.gen";
import { isOfficialPano } from "@/lib/sv/panoId";
import { panosAt } from "@/lib/sv/query";
import { distMeters, lerpLng, unionBounds } from "@/lib/geo/geo";
import { searchCoverage } from "../searchCoverage";
import { RateWindow } from "./rateWindow";
import { spreadIndex } from "./spread";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { chunk } from "@/lib/util/util";
import type { Bounds, LatLng } from "@/types";

async function regionBounds(region: GeneratorRegion): Promise<Bounds | null> {
	const box = await cmd.polygonBounds(region.polygon);
	return box ? { west: box[0], south: box[1], east: box[2], north: box[3] } : null;
}

function regionContains(region: GeneratorRegion, points: LatLng[]): Promise<boolean[]> {
	return cmd.polygonContainsPoints(
		region.polygon,
		points.map((p) => p.lat),
		points.map((p) => p.lng),
	);
}

/** Share of a probe round that must have answered before the next round launches. */
const ROUND_OVERLAP_AT = 0.9;
const MAX_ROUNDS_IN_FLIGHT = 4;
const SEED_BATCH = 100;
const SEED_DELAY = 50;

const SILENT: GenerationCallbacks = {
	onLocationsFound: () => {},
	onProgress: () => {},
	onRegionComplete: () => {},
	onDone: () => {},
};

export class GenerationEngine {
	private settings: GeneratorSettings;
	private regions: GeneratorRegion[];
	private callbacks: GenerationCallbacks;
	private readonly abort = new AbortController();
	private started = false;
	private paused = false;
	private pauseResolvers: (() => void)[] = [];
	private cancelledRegions = new Set<string>();
	private regionTasks: Promise<void>[] = [];
	private liveRegionIds = new Set<string>();
	private globalFoundPanoIds = new Set<string>();
	private pendingBatch: GeneratedLocation[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pointSources = new Map<string, Promise<PointSource>>();
	private answered = new RateWindow();
	private accepted = new RateWindow();
	private probesTotal = 0;
	private foundTotal = 0;
	private duplicates = 0;
	private rejected = 0;
	private cells = new Map<string, { probes: number; found: number }>();
	private cellDeg = 0.25;

	constructor(
		settings: GeneratorSettings,
		regions: GeneratorRegion[],
		callbacks: GenerationCallbacks,
	) {
		this.settings = settings;
		this.regions = regions;
		this.callbacks = callbacks;
	}

	// Live-apply settings mid-job. Most settings are read fresh on every probe, so they
	// take effect immediately. numGenerators and oneCountryAtATime are fixed at start().
	updateSettings(settings: GeneratorSettings) {
		this.settings = settings;
	}

	/** Runs until every region is done or the engine is stopped. A stopped engine never starts. */
	async start(): Promise<void> {
		if (this.started || this.stopped) return;
		this.started = true;
		await this.beginSearchOverlay();
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
		} catch (e) {
			// Stopping rejects the lookups in flight; only a live run's failure is news.
			if (!this.stopped) throw e;
		} finally {
			this.flushBatch();
			const { onDone } = this.callbacks;
			// Walks still in flight are dropped, so their lookups are declined.
			this.abort.abort();
			onDone();
		}
	}

	// One worker per region, finishing each before the next (oneCountryAtATime).
	// Skips regions already running as a reconcile-added worker, or cancelled.
	private async runSequential(): Promise<void> {
		for (let i = 0; i < this.regions.length; i++) {
			if (this.stopped) return;
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
		if (!this.isRunning()) return;
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

		void this.searchOverlayBounds().then((b) => {
			if (b && this.isRunning()) searchCoverage.growSession(b, this.settings.radius);
		});
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

	/** Rates over the last ten seconds plus run-wide counts: probes answered, locations
	 *  added, the share of answers that became a location, and how evenly the finds
	 *  spread over the probed cells. */
	stats(): GeneratorStats {
		const answers = this.answered.inWindow();
		return {
			probesPerSec: this.answered.perSecond(),
			locsPerSec: this.accepted.perSecond(),
			hitRate: answers > 0 ? this.accepted.inWindow() / answers : null,
			probes: this.probesTotal,
			found: this.foundTotal,
			duplicates: this.duplicates,
			rejected: this.rejected,
			spread: spreadIndex([...this.cells.values()].filter((c) => c.probes > 0).map((c) => c.found)),
		};
	}

	/** Aggregate found/target over the engine's current regions. */
	progress(): { found: number; target: number } {
		let found = 0;
		let target = 0;
		for (const region of this.regions) {
			found += Math.min(region.found.length, region.target);
			target += region.target;
		}
		return { found, target };
	}

	/** A stopped engine never restarts. Finds already confirmed are delivered; afterwards no
	 *  callback fires and every lookup in flight is declined. */
	stop(): void {
		if (this.stopped) return;
		this.flushBatch();
		this.callbacks = SILENT;
		this.abort.abort();
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingBatch.length = 0;
		this.resume();
		searchCoverage.endSession();
	}

	/** Every region's box, padded by the probe radius so a disc at the edge still lands. */
	private async searchOverlayBounds(): Promise<Bounds | null> {
		if (this.regions.length === 0) return null;
		let bounds: Bounds | null = null;
		for (const region of this.regions) {
			const bb = await regionBounds(region);
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

	private async beginSearchOverlay(): Promise<void> {
		const b = await this.searchOverlayBounds();
		if (b) {
			searchCoverage.beginSession(b, this.settings.radius);
			this.cellDeg = Math.max((b.north - b.south) / 24, (b.east - b.west) / 24, 0.005);
		}
	}

	private cell(p: LatLng): { probes: number; found: number } {
		const key = `${Math.floor(p.lat / this.cellDeg)}:${Math.floor(p.lng / this.cellDeg)}`;
		let c = this.cells.get(key);
		if (!c) {
			c = { probes: 0, found: 0 };
			this.cells.set(key, c);
		}
		return c;
	}

	isRunning(): boolean {
		return this.started && !this.stopped;
	}
	isPaused(): boolean {
		return this.paused;
	}

	private get stopped(): boolean {
		return this.abort.signal.aborted;
	}

	/** Parks while paused, then answers whether the region still has work to do. */
	private async proceed(region: GeneratorRegion): Promise<boolean> {
		while (this.paused) {
			await new Promise<void>((resolve) => {
				this.pauseResolvers.push(resolve);
			});
		}
		return (
			!this.stopped && !this.cancelledRegions.has(region.id) && region.found.length < region.target
		);
	}

	private async generateRegion(region: GeneratorRegion): Promise<void> {
		const mode = this.settings.samplingMode;
		if (mode === "kernels") await this.generateRegionKernels(region);
		else if (mode === "random") await this.generateRegionRandom(region);
		else await this.generateRegionFrom(region, mode);

		region.isProcessing = false;
		this.callbacks.onRegionComplete(region.id);
	}

	/** Probes a region's points in batches until they run out. Every worker on the region
	 *  draws from the one supply, so no point is probed twice. */
	private async generateRegionFrom(
		region: GeneratorRegion,
		mode: Exclude<SamplingMode, "random" | "kernels">,
	): Promise<void> {
		let source = this.pointSources.get(region.id);
		if (!source) {
			source = this.pointSource(region, mode);
			this.pointSources.set(region.id, source);
		}
		const take = await source;
		const rounds = this.roundLauncher(region);

		while (await this.proceed(region)) {
			region.isProcessing = true;
			const batch = await take(this.settings.speed);
			if (batch.length === 0) break;
			const coords = await this.withoutExisting(batch);
			if (coords.length === 0) continue;
			await rounds.launch(coords);
		}
		await rounds.drain();

		this.pointSources.delete(region.id);
	}

	private async pointSource(
		region: GeneratorRegion,
		mode: Exclude<SamplingMode, "random" | "kernels">,
	): Promise<PointSource> {
		if (mode === "blueline")
			return blueLineSource(region.polygon, DISTRIBUTION_EVENNESS[this.settings.distribution]);
		if (mode === "poisson") {
			const pairs = await cmd.polygonPoissonPoints(region.polygon, 2 * this.settings.radius);
			const points = pairs.map(([lng, lat]) => ({ lat, lng }));
			log.info(`[generator] Poisson disk: ${points.length} probes for ${region.name}`);
			return pointsInOrder(points);
		}
		// Discs of the search radius cover the plane with no gaps when their centers form a honeycomb radius * sqrt(3) apart.
		const runs = await cmd.honeycombPoints(region.polygon, this.settings.radius * Math.sqrt(3));
		log.info(
			`[generator] Grid: ${runs.reduce((n, run) => n + run.count, 0)} probes for ${region.name}`,
		);
		return gridPointSource(runs);
	}

	/** With skip-existing on, drops the points that already have a location within its radius. */
	private async withoutExisting(coords: LatLng[]): Promise<LatLng[]> {
		if (!this.settings.skipExisting) return coords;
		try {
			const near = await cmd.storeNearAny(
				coords.map((c) => c.lat),
				coords.map((c) => c.lng),
				this.settings.skipExistingRadius,
			);
			return coords.filter((_, i) => !near[i]);
		} catch (e) {
			log.warn("[generator] storeNearAny failed, probing unfiltered:", e);
			return coords;
		}
	}

	private async generateRegionKernels(region: GeneratorRegion): Promise<void> {
		const bounds = await regionBounds(region);
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
			const withPano = locs.filter((l) => l.panoId);
			const inside = await regionContains(region, withPano);
			seeds = withPano.filter((_, i) => inside[i]).map((l) => l.panoId!);
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

		while (queue.length > 0 && (await this.proceed(region))) {
			region.isProcessing = true;
			const frontier = queue.splice(0, Math.max(s.speed, 50));
			const results = await svMetadata(frontier, this.abort.signal);
			const inside = await regionContains(
				region,
				results.map((p) => (p ? { lat: p.lat, lng: p.lng } : { lat: 0, lng: 0 })),
			);

			for (let i = 0; i < results.length; i++) {
				if (region.found.length >= region.target) break;

				const pano = results[i];
				if (!pano) continue;
				if (!inside[i]) continue;

				let depth = depthMap.get(frontier[i]) ?? 0;

				// a find resets depth
				if (isPanoGood(pano, s)) {
					await this.finalizeLoc(pano, region);
					depth = 0;
				} else if (++depth > maxDepth) {
					continue;
				}

				for (const link of pano.links) {
					if (link.panoId && !visited.has(link.panoId)) {
						visited.add(link.panoId);
						queue.push(link.panoId);
						depthMap.set(link.panoId, depth);
					}
				}
				if (s.checkAllDates && pano.time) {
					for (const entry of pano.time) {
						if (entry.panoId && !visited.has(entry.panoId)) {
							visited.add(entry.panoId);
							queue.push(entry.panoId);
							depthMap.set(entry.panoId, depth);
						}
					}
				}
			}
		}
	}

	private async generateRegionRandom(region: GeneratorRegion): Promise<void> {
		let coveredRounds = 0;
		const rounds = this.roundLauncher(region);

		while (await this.proceed(region)) {
			region.isProcessing = true;
			const n = Math.min(region.target * 100, this.settings.speed);
			let randomCoords = (await cmd.polygonRandomPoints(region.polygon, n)).map(([lng, lat]) => ({
				lat,
				lng,
			}));
			if (this.settings.skipExisting && randomCoords.length > 0) {
				randomCoords = await this.withoutExisting(randomCoords);
				if (randomCoords.length === 0) {
					if (++coveredRounds >= 20) break;
					continue;
				}
				coveredRounds = 0;
			}
			if (randomCoords.length === 0) break;

			await rounds.launch(randomCoords);
		}
		await rounds.drain();
	}

	/** Rounds overlap: the next launches once most of the current one has answered, so a
	 *  straggling request cannot drain the pipe. findRegions stays strictly serial. */
	private roundLauncher(region: GeneratorRegion) {
		const rounds = new Set<Promise<void>>();
		let failure: unknown;
		const surface = () => {
			if (failure !== undefined) throw failure;
		};
		return {
			launch: async (coords: LatLng[]) => {
				surface();
				if (this.settings.findRegions) return this.probeAll(coords, region);
				const round = this.probeCoords(coords, region);
				const settled: Promise<void> = round.settled
					.catch((e: unknown) => {
						failure ??= e ?? new Error("probe round failed");
					})
					.finally(() => rounds.delete(settled));
				rounds.add(settled);
				if (rounds.size >= MAX_ROUNDS_IN_FLIGHT) await Promise.race(rounds);
				await round.mostlyDone;
			},
			drain: async () => {
				await Promise.all(rounds);
				surface();
			},
		};
	}

	private async probeAll(coords: LatLng[], region: GeneratorRegion): Promise<void> {
		// findRegions accepts each pano against region.found as it goes, so it probes one at a time
		const size = this.settings.findRegions ? 1 : coords.length || 1;
		for (const batch of chunk(coords, size)) {
			if (!(await this.proceed(region))) return;
			await this.probeCoords(batch, region).settled;
		}
	}

	/** One probe round. Each answer is handled the moment it streams in; `mostlyDone`
	 *  settles once `ROUND_OVERLAP_AT` of them are in, `settled` when the round is over. */
	private probeCoords(
		coords: LatLng[],
		region: GeneratorRegion,
	): { mostlyDone: Promise<void>; settled: Promise<void> } {
		for (const c of coords) searchCoverage.addProbe(c.lng, c.lat);
		const s = this.settings;
		const seen = new Uint8Array(coords.length);
		const threshold = Math.max(1, Math.ceil(coords.length * ROUND_OVERLAP_AT));
		let received = 0;
		let found = 0;
		let reachedMost!: () => void;
		const mostlyDone = new Promise<void>((resolve) => (reachedMost = resolve));

		let seeds: string[] = [];
		let direct: Pano[] = [];
		let seedTimer: ReturnType<typeof setTimeout> | null = null;
		const flushSeeds = () => {
			if (seedTimer) {
				clearTimeout(seedTimer);
				seedTimer = null;
			}
			if (direct.length > 0) {
				const batch = direct;
				direct = [];
				this.accept(batch, region);
			}
			if (seeds.length > 0) {
				const batch = seeds;
				seeds = [];
				this.walk(batch, region, 0);
			}
		};
		const handle = (index: number, pano: Pano | null) => {
			if (seen[index]) return;
			seen[index] = 1;
			received++;
			this.answered.add(1);
			this.probesTotal++;
			this.cell(coords[index]).probes++;
			if (received === threshold) reachedMost();
			if (!pano) return;
			// Paused or stopped while the lookup was in flight: drop the result.
			if (this.stopped || this.paused || this.cancelledRegions.has(region.id)) return;
			found++;
			// The search already answered the metadata, so a seed that is this pano is
			// accepted from what is in hand; only derived ids need a lookup.
			const ids = this.seedsFrom(pano, region);
			if (ids.length === 0) this.rejected++;
			for (const id of ids) {
				if (id === pano.id) direct.push(pano);
				else seeds.push(id);
			}
			if (seeds.length + direct.length >= SEED_BATCH) flushSeeds();
			else if (seeds.length + direct.length > 0 && !seedTimer)
				seedTimer = setTimeout(flushSeeds, SEED_DELAY);
		};

		const probeStart = performance.now();
		const settled = (async () => {
			try {
				// The search answers the metadata too, so there is no second lookup.
				const panos = await panosAt(
					coords,
					s.radius,
					s.rejectUnofficial ? { sources: [PanoType.Official] } : undefined,
					this.abort.signal,
					handle,
				);
				for (let i = 0; i < panos.length; i++) handle(i, panos[i]);
				const probeMs = Math.max(1, performance.now() - probeStart);
				log.debug(
					`[generator] probed ${coords.length} in ${Math.round(probeMs)}ms (${Math.round((coords.length * 1000) / probeMs)} search/s), ${found} panos`,
				);
			} finally {
				flushSeeds();
				reachedMost();
			}
		})();
		return { mostlyDone, settled };
	}

	private seedsFrom(pano: Pano, region: GeneratorRegion): string[] {
		const s = this.settings;
		if (!passesInitialFilters(pano, s)) return [];

		if (s.findRegions) {
			const coord = { lat: pano.lat, lng: pano.lng };
			if (region.found.some((f) => distMeters(f, coord) < s.regionRadius * 1000)) return [];
		}

		const dateResult = passesDateFilters(pano, s);
		if (dateResult === false) return [];

		if (s.randomInTimeline && pano.time?.length) {
			const entry = pano.time[Math.floor(Math.random() * pano.time.length)];
			if (entry.date) {
				const ym = entry.date.slice(0, 7);
				if (Date.parse(ym) < Date.parse(s.fromDate) || Date.parse(ym) > Date.parse(s.toDate)) {
					return [];
				}
			}
			return [entry.panoId];
		}

		if (dateResult === "checkAll" && pano.time) {
			const seeds: string[] = [];
			const fromDate = Date.parse(s.fromDate);
			const toDate = Date.parse(s.toDate);
			for (const entry of pano.time) {
				if (s.rejectUnofficial && !isOfficialPano(entry.panoId)) continue;
				if (!entry.date) continue;
				const ym = entry.date.slice(0, 7);
				if (Date.parse(ym) >= fromDate && Date.parse(ym) <= toDate) seeds.push(entry.panoId);
			}
			return seeds;
		}

		return [pano.id];
	}

	/** The walk runs alongside the probing rather than holding it up, so a region keeps
	 *  sampling while earlier finds are still opening up. */
	private walk(ids: string[], region: GeneratorRegion, depth: number): void {
		void this.walkPanos(ids, region, depth).catch((e) => {
			if (!this.stopped) log.warn("[generator] link walk failed:", e);
		});
	}

	/** Panos already in hand enter the walk at its post-lookup stage. */
	private accept(panos: Pano[], region: GeneratorRegion): void {
		const fresh = panos.filter((p) => !region.checkedPanos.has(p.id));
		this.duplicates += panos.length - fresh.length;
		if (fresh.length === 0) return;
		for (const p of fresh) region.checkedPanos.add(p.id);
		void this.processPanos(fresh, region, 0).catch((e) => {
			if (!this.stopped) log.warn("[generator] accept failed:", e);
		});
	}

	/** Walks a level of the link/timeline graph: every id at `depth` is fetched in one
	 *  batch, and what each one opens up is walked as the next level. A pano that passes
	 *  resets the depth of what it leads to, which is what lets a good stretch keep
	 *  going while a dead one bottoms out at `linksDepth`. */
	private async walkPanos(ids: string[], region: GeneratorRegion, depth: number): Promise<void> {
		if (this.stopped || this.paused || this.cancelledRegions.has(region.id)) return;
		if (depth > this.settings.linksDepth) return;
		if (region.found.length >= region.target) return;

		const fresh = ids.filter((id) => id && !region.checkedPanos.has(id));
		if (fresh.length === 0) return;
		for (const id of fresh) region.checkedPanos.add(id);

		const panos = await svMetadata(fresh, this.abort.signal);
		await this.processPanos(panos, region, depth);
	}

	private async processPanos(
		panos: (Pano | null)[],
		region: GeneratorRegion,
		depth: number,
	): Promise<void> {
		if (this.stopped || this.paused || this.cancelledRegions.has(region.id)) return;
		if (region.found.length >= region.target) return;
		const s = this.settings;
		const inside = await regionContains(
			region,
			panos.map((p) => (p ? { lat: p.lat, lng: p.lng } : { lat: 0, lng: 0 })),
		);

		// A pano that passed sends what it opens up back to depth 1; everything else sinks.
		const fromGood: string[] = [];
		const deeper: string[] = [];

		for (let i = 0; i < panos.length; i++) {
			const pano = panos[i];
			if (!pano) continue;
			const good = isPanoGood(pano, s) && inside[i];
			const next = good ? fromGood : deeper;

			if (s.checkAllDates && !s.selectMonths && pano.time) {
				const fromDate = Date.parse(s.fromDate);
				const toDate = Date.parse(s.toDate);
				for (const entry of pano.time) {
					if (s.rejectUnofficial && !isOfficialPano(entry.panoId)) continue;
					if (!entry.date) continue;
					const ym = entry.date.slice(0, 7);
					if (Date.parse(ym) >= fromDate && Date.parse(ym) <= toDate) next.push(entry.panoId);
				}
			}

			if (s.checkLinks) {
				for (const link of pano.links) if (link.panoId) next.push(link.panoId);
				for (const entry of pano.time) next.push(entry.panoId);
			}

			if (good) void this.finalizeLoc(pano, region);
		}

		this.walk(fromGood, region, 1);
		this.walk(deeper, region, depth + 1);
	}

	private async finalizeLoc(pano: Pano, region: GeneratorRegion): Promise<void> {
		if (this.stopped || this.paused || this.cancelledRegions.has(region.id)) return;
		const s = this.settings;
		const panoId: string = pano.id;

		if (this.globalFoundPanoIds.has(panoId)) {
			this.duplicates++;
			return;
		}
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
			if (this.stopped || this.paused || this.cancelledRegions.has(region.id)) return;
			if (region.found.length >= region.target) return;
		}

		const loc: GeneratedLocation = {
			panoId,
			lat: pano.lat,
			lng: pano.lng,
			heading: computeHeading(pano, s),
			pitch: s.adjustPitch ? s.pitchDeviation : 0,
			zoom: s.adjustZoom ? s.zoomLevel : 0,
			imageDate: pano.imageDate || null,
		};

		region.found.push(loc);
		this.pendingBatch.push(loc);
		this.accepted.add(1);
		this.foundTotal++;
		this.cell(loc).found++;
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
		if (this.pendingBatch.length === 0 || this.stopped || this.paused) return;
		const batch = this.pendingBatch.splice(0);
		this.callbacks.onLocationsFound(batch);
	}
}
