const BUCKETS = 11;
const BUCKET_MS = 1000;

/** Ring of one-second counters covering the last ten whole seconds, so the second
 *  still filling never drags the figure down. */
export class RateWindow {
	private counts = new Array<number>(BUCKETS).fill(0);
	private slots = new Array<number>(BUCKETS).fill(-1);
	private origin = -1;

	add(n: number, now = performance.now()): void {
		const slot = Math.floor(now / BUCKET_MS);
		if (this.origin < 0) this.origin = slot;
		const i = slot % BUCKETS;
		if (this.slots[i] !== slot) {
			this.slots[i] = slot;
			this.counts[i] = 0;
		}
		this.counts[i] += n;
	}

	/** Events in the window: the last ten whole seconds. */
	inWindow(now = performance.now()): number {
		const slot = Math.floor(now / BUCKET_MS);
		let total = 0;
		for (let i = 0; i < BUCKETS; i++) {
			const age = slot - this.slots[i];
			if (this.slots[i] >= 0 && age >= 1 && age < BUCKETS) total += this.counts[i];
		}
		return total;
	}

	/** Events per second over the window. Quiet seconds count as zeroes, so a stall
	 *  reads as a falling rate rather than freezing the last good one. */
	perSecond(now = performance.now()): number {
		if (this.origin < 0) return 0;
		const slot = Math.floor(now / BUCKET_MS);
		const span = Math.min(BUCKETS - 1, slot - this.origin);
		if (span < 1) return 0;
		return this.inWindow(now) / span;
	}
}
