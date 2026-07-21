export type SyncStatus = "idle" | "syncing" | "error";

export interface Scheduler {
	/** Request a sync (debounced). Ignored while a sync is applying, to swallow self-induced edits. */
	request(): void;
	/** Begin the poll loop (remote has no change feed, so we poll). */
	start(): void;
	stop(): void;
	/** Force a sync now, bypassing the debounce (the manual button). */
	runNow(): Promise<void>;
	status(): SyncStatus;
}

/**
 * Coalescing sync loop. Local edits (via `request`) and a poll interval both drive it; it runs one
 * at a time. While a sync is applying, `request` is a no-op so the store mutations we make don't
 * re-trigger us -- any genuine edit made during that window is caught by the next poll.
 */
export function createScheduler(
	run: () => Promise<void>,
	opts: { debounceMs?: number; pollMs?: number; onStatus?: (s: SyncStatus) => void },
): Scheduler {
	const debounceMs = opts.debounceMs ?? 1500;
	const pollMs = opts.pollMs ?? 15000;
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	let applying = false;
	let status: SyncStatus = "idle";

	const setStatus = (s: SyncStatus) => {
		status = s;
		opts.onStatus?.(s);
	};

	async function fire() {
		if (applying) return;
		applying = true;
		setStatus("syncing");
		try {
			await run();
			setStatus("idle");
		} catch {
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
		runNow: fire,
		status: () => status,
	};
}
