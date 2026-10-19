import { Cancelled, Err, Ok, type Settled } from "@/types/util";

/**
 * Latest-wins async work: each `replace` supersedes the run before it, so only the newest
 * run's value reaches `publish`. A run's `signal` aborts once `replace` or `cancel` supersedes it.
 * A superseded value goes to `discard` instead, so a run can release what it built.
 * A value `read` returns synchronously publishes before `replace` returns.
 * `replace` resolves to how the run settled: `Ok`, `Err` (also passed to `failed`), or
 * `Cancelled` once superseded, whose error is dropped. With `owner`, a run is also superseded
 * once `owner()` returns something other than it did when the run began. `bind` wraps a
 * callback so it runs only while nothing has superseded the moment it was bound, and returns
 * `inactive()` after.
 */
export function latest<T = unknown>(
	options: {
		publish?: (value: T) => void;
		discard?: (value: T) => void | Promise<void>;
		failed?: (error: Error) => void;
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
		replace(read: (signal: AbortSignal) => T | Promise<T>): Promise<Settled<T>> {
			const signal = supersede();
			const valid = owns(signal);
			const accept = async (value: T): Promise<Settled<T>> => {
				if (!valid()) {
					await options.discard?.(value);
					return new Cancelled();
				}
				options.publish?.(value);
				return new Ok(value);
			};
			const fail = (error: unknown): Settled<T> => {
				if (!valid()) return new Cancelled();
				const failure = error instanceof Error ? error : new Error(String(error));
				options.failed?.(failure);
				return new Err(failure);
			};
			try {
				const result = read(signal);
				return (result instanceof Promise ? result.then(accept) : accept(result)).catch(fail);
			} catch (error) {
				return Promise.resolve(fail(error));
			}
		},
	};
}
