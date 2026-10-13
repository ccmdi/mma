/**
 * Latest-wins async work: each `replace` supersedes the run before it, so only the newest
 * run's value reaches `publish`. A run's `signal` aborts once `replace` or `cancel` supersedes it.
 * A superseded value goes to `discard` instead, so a run can release what it built.
 * A value `read` returns synchronously publishes before `replace` returns.
 * A current run's error goes to `failed`, or rejects `replace` when `failed` is unset; a
 * superseded run's error is dropped. With `owner`, a run is also superseded once `owner()`
 * returns something other than it did when the run began. `bind` wraps a callback so it runs
 * only while nothing has superseded the moment it was bound, and returns `inactive()` after.
 */
export function latest<T = unknown>(
	options: {
		publish?: (value: T) => void;
		discard?: (value: T) => void | Promise<void>;
		failed?: (error: unknown) => void;
		owner?: () => unknown;
	} = {},
) {
	let current = new AbortController();
	const supersede = () => {
		const previous = current;
		current = new AbortController();
		previous.abort();
		return current.signal;
	};
	const owns = (signal: AbortSignal) => {
		const owner = options.owner?.();
		return () => !signal.aborted && (!options.owner || options.owner() === owner);
	};
	function bind<A extends unknown[], R>(
		callback: (...args: A) => R,
		inactive: () => R,
	): (...args: A) => R;
	function bind<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R | undefined;
	function bind<A extends unknown[], R>(callback: (...args: A) => R, inactive?: () => R) {
		const valid = owns(current.signal);
		return (...args: A): R | undefined => (valid() ? callback(...args) : inactive?.());
	}
	return {
		cancel: () => {
			supersede();
		},
		bind,
		replace(read: (signal: AbortSignal) => T | Promise<T>): Promise<void> {
			const signal = supersede();
			const valid = owns(signal);
			const accept = (value: T) => {
				if (!valid()) return options.discard?.(value);
				options.publish?.(value);
			};
			const fail = (error: unknown) => {
				if (!valid()) return;
				if (options.failed) options.failed(error);
				else throw error;
			};
			try {
				const result = read(signal);
				return result instanceof Promise
					? result.then(accept).catch(fail)
					: Promise.resolve(accept(result)).catch(fail);
			} catch (error) {
				return Promise.resolve().then(() => fail(error));
			}
		},
	};
}

type OwnedMethods<O, M> = {
	readonly [K in keyof M]: M[K] extends (owner: O, ...args: infer A) => Promise<infer R>
		? (...args: A) => Promise<R | null>
		: never;
};

/** Expose stable methods for the current owner; retained methods resolve null once that owner ends. */
export function owned<
	O,
	M extends Record<string, (owner: O, ...args: never[]) => Promise<unknown>>,
>(
	read: () => O | null,
	methods: M,
	identity: (owner: O) => unknown = (owner) => owner,
): OwnedMethods<O, M> {
	const key = () => {
		const owner = read();
		return owner === null ? null : identity(owner);
	};
	const lifetime = latest({ owner: key });
	const result = {} as OwnedMethods<O, M>;
	for (const name of Object.keys(methods) as Array<keyof M>) {
		let cached: ((...args: unknown[]) => Promise<unknown>) | undefined;
		let ownerKey: unknown;
		Object.defineProperty(result, name, {
			enumerable: true,
			get() {
				const current = key();
				if (!cached || current !== ownerKey) {
					ownerKey = current;
					cached = lifetime.bind(
						async (...args: unknown[]) => {
							const owner = read();
							return owner === null
								? null
								: Reflect.apply(methods[name], undefined, [owner, ...args]);
						},
						() => Promise.resolve(null),
					);
				}
				return cached;
			},
		});
	}
	return result;
}
