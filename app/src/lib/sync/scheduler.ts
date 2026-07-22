export type SyncStatus = "idle" | "syncing" | "error";

export interface Scheduler {
	/** Request a sync (debounced). Ignored while a sync is applying, to swallow self-induced edits. */
	request(): void;
	/** Begin the poll loop (remote has no change feed, so we poll). */
	start(): void;
	stop(): void;
	/** Force a sync now, bypassing the debounce and any failure backoff (the manual button). */
	runNow(): Promise<void>;
	status(): SyncStatus;
}

/**
 * Coalescing sync loop. Local edits (via `request`) and a poll interval both drive it; it runs one
 * at a time. While a sync is applying, `request` is a no-op so the store mutations we make don't
 * re-trigger us -- any genuine edit made during that window is caught by the next poll.
 *
 * Consecutive failures back off exponentially (up to `maxBackoffMs`) instead of retrying at full
 * poll rate forever; a manual `runNow` always goes through, and one success resets the backoff.
 */
export function createScheduler(
	run: () => Promise<void>,
	opts: {
		debounceMs?: number;
		pollMs?: number;
		maxBackoffMs?: number;
		onStatus?: (s: SyncStatus) => void;
	},
): Scheduler {
	const debounceMs = opts.debounceMs ?? 1500;
	// Local edits arrive event-driven via `request`, so the poll exists ONLY to notice remote
	// edits; minutes-scale is plenty, and each poll re-reads the whole remote side.
	const pollMs = opts.pollMs ?? 180_000;
	const maxBackoffMs = opts.maxBackoffMs ?? 8 * pollMs;
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	let applying = false;
	let status: SyncStatus = "idle";
	let failures = 0;
	let blockedUntil = 0;

	const setStatus = (s: SyncStatus) => {
		status = s;
		opts.onStatus?.(s);
	};

	async function fire(manual = false) {
		if (applying) return;
		if (!manual && Date.now() < blockedUntil) return;
		applying = true;
		setStatus("syncing");
		try {
			await run();
			failures = 0;
			blockedUntil = 0;
			setStatus("idle");
		} catch {
			failures++;
			blockedUntil = Date.now() + Math.min(pollMs * 2 ** (failures - 1), maxBackoffMs);
			setStatus("error");
		} finally {
			applying = false;
		}
	}

	return {
		request() {
			if (applying) return;
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(fire, debounceMs);
		},
		start() {
			if (poll) return;
			poll = setInterval(fire, pollMs);
		},
		stop() {
			if (debounce) clearTimeout(debounce);
			if (poll) clearInterval(poll);
			debounce = poll = null;
		},
		runNow: () => fire(true),
		status: () => status,
	};
}
