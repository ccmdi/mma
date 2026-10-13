import { useEffect, useRef, useState, type DependencyList } from "react";
import { latest } from "@/lib/util/latest";

interface AsyncState<T> {
	data: T | null;
	loading: boolean;
	error: Error | null;
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
	const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
	const [requests] = useState(() =>
		latest<T>({
			publish: (data) => setState({ data, loading: false, error: null }),
			failed: (e) =>
				setState({
					data: null,
					loading: false,
					error: e instanceof Error ? e : new Error(String(e)),
				}),
		}),
	);
	useEffect(() => {
		void requests.replace((signal) => {
			const result = fn(signal);
			if (result instanceof Promise) setState({ data: null, loading: true, error: null });
			return result;
		});
		return () => requests.cancel();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
	return state;
}

/** The last settled value of `state`, held while a newer run is in flight. For a value a
 *  subtree is gated on: without it, a dependency change blanks the value for a frame and
 *  unmounts everything below, resetting its state. A settled null is a value like any
 *  other. A `key` scopes the hold: when it changes, the last value is dropped rather than
 *  shown. */
export function useSticky<T>(state: AsyncState<T>, key: unknown = null): T | null {
	const last = useRef<{ key: unknown; value: T | null }>({ key, value: null });
	if (last.current.key !== key) last.current = { key, value: null };
	else if (!state.loading) last.current.value = state.data;
	return last.current.value;
}

/** `useAsync` with its result held sticky across runs; see {@link useSticky}. */
export function useAsyncSticky<T>(
	fn: (signal: AbortSignal) => T | Promise<T>,
	deps: DependencyList,
	key: unknown = null,
): T | null {
	return useSticky(useAsync(fn, [...deps, key]), key);
}
