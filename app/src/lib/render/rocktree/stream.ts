// Live octree streaming: re-run the covering traversal when the camera
// settles, fetch picks AND their renderable ancestors (the ancestors are the
// seamless-refinement fallback: a coarse parent keeps covering until its
// children arrive), abort fetches that leave the view, evict LRU, and compute
// per-node octant masks for the drawn set. Generic over the prepared node
// payload so tests can drive it without GPU or network.

import { imageryEpochFor, isRenderable, nodeDataEpoch, type Bulk } from "./decode";
import { coveringSet, type BulkSource, type FoundNode } from "./traverse";
import { obbDistance, type FrustumView } from "./lod";
import { log } from "@/lib/util/log";

export interface StreamOpts {
	/** Nodes shallower than this are never fetched (ENU anchoring breaks). */
	minLevel?: number;
	texelBudget?: number;
	maxLevel?: number;
	maxNodes?: number;
	/** Max ready nodes kept in memory (LRU beyond the current covering). */
	cacheBudget?: number;
}

export interface StreamDeps<T> {
	getRootEpoch(): Promise<number>;
	getBulk: BulkSource;
	/** Lower priority value = more urgent (level-major, then distance to eye). */
	loadNode(found: FoundNode, signal: AbortSignal, priority: number): Promise<T>;
	disposeNode?(data: T): void;
	/** Drawn set changed (node arrived, covering moved). Host re-renders. */
	onChange(): void;
}

export interface DrawnNode<T> {
	path: string;
	data: T;
	/** Octant bits covered by drawn descendants; 0xff = fully covered, skip. */
	mask: number;
}

interface Entry<T> {
	/** "staged": loaded but not yet promoted to drawable (GPU-upload budget). */
	state: "loading" | "staged" | "ready" | "failed";
	data?: T;
	abort?: AbortController;
	lastWanted: number;
}

/** Fetch priority: coarse levels first, then nearest to the eye. */
export function loadPriority(found: FoundNode, view: FrustumView): number {
	const dist = found.obb ? obbDistance(found.obb, view.eye) : 0;
	return found.path.length * 1e8 + Math.min(dist, 1e8 - 1);
}

/**
 * Select what to draw from the wanted tree (picks + ancestor chains, plus
 * cached stand-in chains injected under unready picks by drawnNodes).
 * Walks top-down: a ready pick draws unmasked; a structural node draws with
 * the octants of covered children masked out; an unready node passes coverage
 * up only when ALL its wanted children are covered (so a gap in the chain
 * leaves the coarser ancestor unmasked - no holes, no double-draw). An
 * unready pick draws its stand-in descendants but NEVER reports covered:
 * stand-ins may cover its region only partially, and the pick's own data
 * spans all octants, so the coarser ancestor must keep drawing underneath.
 */
export function computeDrawn(
	wanted: ReadonlySet<string>,
	picks: ReadonlySet<string>,
	ready: ReadonlySet<string>,
): Map<string, number> {
	const out = new Map<string, number>();
	const roots: string[] = [];
	for (const p of wanted) {
		let isRoot = true;
		for (let l = 1; l < p.length; l++)
			if (wanted.has(p.slice(0, l))) {
				isRoot = false;
				break;
			}
		if (isRoot) roots.push(p);
	}

	const walk = (path: string): boolean => {
		const isReady = ready.has(path);
		if (picks.has(path)) {
			if (isReady) {
				out.set(path, 0);
				return true;
			}
			for (let d = 0; d < 8; d++) if (wanted.has(path + d)) walk(path + d);
			return false;
		}
		let mask = 0;
		let hasKids = false;
		let allCovered = true;
		for (let d = 0; d < 8; d++) {
			const child = path + d;
			if (!wanted.has(child)) continue;
			hasKids = true;
			if (walk(child)) mask |= 1 << d;
			else allCovered = false;
		}
		if (isReady) {
			out.set(path, mask);
			return true;
		}
		return hasKids && allCovered;
	};
	for (const r of roots) walk(r);
	return out;
}

export class RocktreeStream<T> {
	private entries = new Map<string, Entry<T>>();
	private bulkPromises = new Map<string, Promise<Bulk>>();
	private bulkByPath = new Map<string, Bulk>();
	private wanted = new Map<string, FoundNode | null>();
	private picks = new Set<string>();
	private seq = 0;
	private rootEpoch: number | null = null;
	private pendingView: FrustumView | null = null;
	private drainPromise: Promise<void> | null = null;
	private disposed = false;

	private readonly minLevel: number;
	private readonly cacheBudget: number;
	private readonly coveringOpts: { texelBudget?: number; maxLevel?: number; maxNodes?: number };

	constructor(
		private deps: StreamDeps<T>,
		opts: StreamOpts = {},
	) {
		this.minLevel = opts.minLevel ?? 12;
		this.cacheBudget = opts.cacheBudget ?? 2500;
		this.coveringOpts = {
			texelBudget: opts.texelBudget,
			maxLevel: opts.maxLevel,
			maxNodes: opts.maxNodes,
		};
	}

	/** Latest camera wins; concurrent calls coalesce. Resolves when settled. */
	update(view: FrustumView): Promise<void> {
		this.pendingView = view;
		this.drainPromise ??= this.drain();
		return this.drainPromise;
	}

	private async drain() {
		while (this.pendingView && !this.disposed) {
			const view = this.pendingView;
			this.pendingView = null;
			try {
				await this.runUpdate(view);
			} catch (e) {
				log.warn(`[rocktree] covering update failed: ${e}`);
			}
		}
		this.drainPromise = null;
	}

	private getBulkCached: BulkSource = (path, epoch) => {
		const key = `${path}:${epoch}`;
		let p = this.bulkPromises.get(key);
		if (!p) {
			p = this.deps.getBulk(path, epoch).then((b) => {
				this.bulkByPath.set(path, b);
				return b;
			});
			this.bulkPromises.set(key, p);
		}
		return p;
	};

	/** Resolve a wanted ancestor from already-fetched bulk metadata. */
	private resolveFound(path: string): FoundNode | null {
		const bulkPath = path.slice(0, ((path.length - 1) >> 2) << 2);
		const bulk = this.bulkByPath.get(bulkPath);
		const node = bulk?.nodes.get(path.slice(bulkPath.length));
		if (!bulk || !node || !isRenderable(node)) return null;
		return {
			path,
			epoch: nodeDataEpoch(bulk, node),
			imageryEpoch: imageryEpochFor(bulk, node),
			obb: node.obb,
		};
	}

	private async runUpdate(view: FrustumView) {
		this.rootEpoch ??= await this.deps.getRootEpoch();
		const picks = (
			await coveringSet(view, this.rootEpoch, this.getBulkCached, this.coveringOpts)
		).filter((p) => p.path.length >= this.minLevel);
		if (this.disposed) return;

		this.seq++;
		const wanted = new Map<string, FoundNode | null>();
		for (const p of picks) {
			wanted.set(p.path, p);
			for (let l = this.minLevel; l < p.path.length; l++) {
				const anc = p.path.slice(0, l);
				if (!wanted.has(anc)) wanted.set(anc, this.resolveFound(anc));
			}
		}
		this.wanted = wanted;
		this.picks = new Set(picks.map((p) => p.path));

		// abort loads that left the view; drop stale failures (staged/ready data
		// stays cached and is governed by the LRU)
		for (const [path, e] of this.entries) {
			if ((e.state === "loading" || e.state === "failed") && !wanted.has(path)) {
				e.abort?.abort();
				this.entries.delete(path);
			}
		}
		// start missing loads, most urgent first
		const toLoad: { found: FoundNode; priority: number }[] = [];
		for (const [path, found] of wanted) {
			if (!found) continue;
			const e = this.entries.get(path);
			if (e && e.state !== "failed") {
				e.lastWanted = this.seq;
				continue;
			}
			toLoad.push({ found, priority: loadPriority(found, view) });
		}
		toLoad.sort((a, b) => a.priority - b.priority);
		for (const { found, priority } of toLoad) this.startLoad(found, priority);
		this.evict();
		this.deps.onChange();
	}

	private startLoad(found: FoundNode, priority: number) {
		const abort = new AbortController();
		const entry: Entry<T> = { state: "loading", abort, lastWanted: this.seq };
		this.entries.set(found.path, entry);
		this.deps.loadNode(found, abort.signal, priority).then(
			(data) => {
				if (abort.signal.aborted || this.disposed) {
					this.deps.disposeNode?.(data);
					return;
				}
				entry.state = "staged";
				entry.data = data;
				this.deps.onChange();
			},
			(e) => {
				if (abort.signal.aborted) return;
				entry.state = "failed";
				log.warn(`[rocktree] node ${found.path} failed: ${e}`);
			},
		);
	}

	private evict() {
		const evictable: [string, Entry<T>][] = [];
		for (const [path, e] of this.entries)
			if (e.state === "ready" && !this.wanted.has(path)) evictable.push([path, e]);
		const excess = this.entries.size - this.cacheBudget;
		if (excess <= 0) return;
		evictable.sort((a, b) => a[1].lastWanted - b[1].lastWanted);
		for (const [path, e] of evictable.slice(0, excess)) {
			if (e.data !== undefined) this.deps.disposeNode?.(e.data);
			this.entries.delete(path);
		}
	}

	/**
	 * Promote up to `budget` staged WANTED nodes to drawable, coarse first.
	 * The host calls this once per frame so GPU uploads never burst; returns
	 * the number still staged (schedule another frame while > 0). Staged nodes
	 * no longer wanted promote for free: they are never drawn (no GPU cost),
	 * they just join the ready cache.
	 */
	promote(budget: number): number {
		const staged: [string, Entry<T>][] = [];
		for (const [path, e] of this.entries) {
			if (e.state !== "staged") continue;
			if (this.wanted.has(path)) staged.push([path, e]);
			else e.state = "ready";
		}
		staged.sort((a, b) => a[0].length - b[0].length);
		for (const [, e] of staged.slice(0, budget)) e.state = "ready";
		return Math.max(0, staged.length - budget);
	}

	/**
	 * Ready wanted nodes with their octant masks (0xff = skip drawing).
	 * Best-available: while a pick downloads, ready CACHED descendants (e.g.
	 * last zoom level's tiles after zooming out) stand in for it, so the
	 * screen never shows less than the best data on hand.
	 */
	drawnNodes(): DrawnNode<T>[] {
		const ready = new Set<string>();
		for (const [path, e] of this.entries) if (e.state === "ready") ready.add(path);
		const wanted = new Set(this.wanted.keys());
		const unreadyPicks: string[] = [];
		for (const p of this.picks) if (!ready.has(p)) unreadyPicks.push(p);
		if (unreadyPicks.length) {
			for (const r of ready) {
				if (wanted.has(r)) continue;
				const pick = unreadyPicks.find((p) => r.length > p.length && r.startsWith(p));
				if (!pick) continue;
				for (let l = pick.length + 1; l <= r.length; l++) wanted.add(r.slice(0, l));
			}
		}
		const masks = computeDrawn(wanted, this.picks, ready);
		const out: DrawnNode<T>[] = [];
		for (const [path, mask] of masks) {
			const e = this.entries.get(path);
			if (e?.data !== undefined) out.push({ path, data: e.data, mask });
		}
		return out;
	}

	dispose() {
		this.disposed = true;
		this.pendingView = null;
		for (const e of this.entries.values()) {
			e.abort?.abort();
			if (e.data !== undefined) this.deps.disposeNode?.(e.data);
		}
		this.entries.clear();
		this.bulkPromises.clear();
		this.bulkByPath.clear();
	}
}
