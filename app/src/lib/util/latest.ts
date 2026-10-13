/** Only current work may publish or invoke callbacks. The owner can be an existing resource. */
export function latest<T = unknown>(
	defaults: {
		publish?: (value: T) => void;
		discard?: (value: T) => void | Promise<void>;
		failed?: (error: unknown) => void;
		owner?: () => unknown;
	} = {},
) {
	let current = new AbortController();
	const supersede = () => {
		const previous = current;
		const next = new AbortController();
		current = next;
		previous.abort();
		return next.signal;
	};
	const owns = (signal: AbortSignal) => {
		const owner = defaults.owner?.();
		return () => !signal.aborted && (!defaults.owner || defaults.owner() === owner);
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
		replace<V extends T = T>(
			read: (signal: AbortSignal) => V | Promise<V>,
			publish?: (value: V) => void,
			options: {
				discard?: (value: V) => void | Promise<void>;
				failed?: (error: unknown) => void;
			} = {},
		): Promise<void> {
			const signal = supersede();
			const valid = owns(signal);
			const accept = (value: V) => {
				if (!valid()) return (options.discard ?? defaults.discard)?.(value);
				(publish ?? defaults.publish)?.(value);
			};
			const fail = (error: unknown) => {
				if (!valid()) return;
				const failed = options.failed ?? defaults.failed;
				if (failed) failed(error);
				else throw error;
			};
			try {
				if (!valid()) return Promise.resolve();
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
