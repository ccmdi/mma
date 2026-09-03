import { useEffect, useRef, useState, type DependencyList } from "react";

interface AsyncState<T> {
	data: T | null;
	loading: boolean;
	error: Error | null;
}

/** Monotonic gate. Each `next()` mints a fresh `isCurrent` predicate and
 *  invalidates every earlier one, so only the most recent caller reports current.
 *  This is the stale-result guard `useAsync` relies on, factored out so the
 *  invariant is unit-testable without rendering a hook. */
export function makeLatestGate(): () => () => boolean {
	let current = 0;
	return () => {
		const token = ++current;
		return () => token === current;
	};
}

/** Run `fn` whenever `deps` change, ignoring results from superseded runs (newer
 *  deps or unmount); the `signal` it is handed aborts at the same moment, so a run can
 *  cancel its own requests rather than only having its answer dropped. `fn` may return a
 *  value synchronously - then the result is applied immediately with no loading frame
 *  (so a synchronous short-circuit never flashes a spinner). A returned promise resets
 *  to `{loading: true}` until it resolves to `{data}` or rejects to `{error}`. */
export function useAsync<T>(
	fn: (signal: AbortSignal) => T | Promise<T>,
	deps: DependencyList,
): AsyncState<T> {
	const next = useRef(makeLatestGate()).current;
	const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
	useEffect(() => {
		const isCurrent = next();
		const ac = new AbortController();
		const result = fn(ac.signal);
		if (result instanceof Promise) {
			setState({ data: null, loading: true, error: null });
			result
				.then((data) => {
					if (isCurrent()) setState({ data, loading: false, error: null });
				})
				.catch((e) => {
					const error = e instanceof Error ? e : new Error(String(e));
					if (isCurrent()) setState({ data: null, loading: false, error });
				});
		} else {
			setState({ data: result, loading: false, error: null });
		}
		return () => {
			next();
			ac.abort();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
	return state;
}

/** `useAsync` that holds its last resolved value while the next run is in flight.
 *  For a value a subtree is gated on: without it, a dependency change blanks the
 *  value for a frame and unmounts everything below, resetting its state. A `key`
 *  scopes the hold: when it changes, the last value is dropped rather than shown. */
export function useAsyncSticky<T>(
	fn: (signal: AbortSignal) => T | Promise<T>,
	deps: DependencyList,
	key: unknown = null,
): T | null {
	const { data } = useAsync(fn, [...deps, key]);
	const last = useRef<{ key: unknown; value: T | null }>({ key, value: null });
	if (last.current.key !== key) last.current = { key, value: null };
	else if (data !== null) last.current.value = data;
	return last.current.value;
}
