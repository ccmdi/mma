export async function runConcurrent<T>(
	items: T[],
	fn: (item: T, index: number) => Promise<void>,
	opts: { concurrency: number; signal?: AbortSignal },
): Promise<void> {
	let next = 0;
	async function worker() {
		while (next < items.length) {
			opts.signal?.throwIfAborted();
			const i = next++;
			await fn(items[i], i);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(opts.concurrency, items.length) }, () => worker()),
	);
}

/** Resolve after `ms`, or reject with the signal's reason as soon as it aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/** A queue that runs each task after every earlier task settles, in call order. A task's
 *  failure rejects only its own call; the tasks after it still run. */
export function serial(): <T>(task: () => T | Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return (task) => {
		const run = tail.then(task);
		tail = run.catch(() => {});
		return run;
	};
}

/** Run `run` once `ms` pass without another `schedule`, with the last call's arguments.
 *  `flush` runs a pending call now and `cancel` drops it. */
export function debounce<A extends unknown[]>(run: (...args: A) => void, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: A | null = null;
	const cancel = () => {
		clearTimeout(timer);
		pending = null;
	};
	const flush = () => {
		const args = pending;
		cancel();
		if (args) run(...args);
	};
	return {
		schedule: (...args: A) => {
			clearTimeout(timer);
			pending = args;
			timer = setTimeout(flush, ms);
		},
		flush,
		cancel,
	};
}

/** Run `run` at once, then at most once every `ms`: calls in between run once more, with the
 *  last call's arguments, when the wait ends. `cancel` drops that pending call. */
export function throttle<A extends unknown[]>(run: (...args: A) => void, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ranAt = -Infinity;
	let pending: A | null = null;
	const fire = () => {
		timer = undefined;
		ranAt = performance.now();
		const args = pending!;
		pending = null;
		run(...args);
	};
	return {
		schedule: (...args: A) => {
			pending = args;
			if (timer !== undefined) return;
			const wait = ranAt + ms - performance.now();
			if (wait <= 0) fire();
			else timer = setTimeout(fire, wait);
		},
		cancel: () => {
			clearTimeout(timer);
			timer = undefined;
			pending = null;
		},
	};
}
