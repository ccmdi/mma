import { useLayoutEffect, useRef, useState, type DependencyList } from "react";
import { latest } from "@/lib/util/latest";
import { Err, Loading, Ok, type AsyncState, type Settled } from "@/types/util";

/** An `AsyncState` whose work can be run again. */
export type Rerunnable<T> = AsyncState<T> & {
	/** Run the work again with the same deps, resolving to how that run settled. */
	rerun: () => Promise<Settled<T>>;
};

/** Run `fn` whenever `deps` change, ignoring results from superseded runs (newer
 *  deps or unmount); the `signal` it is handed aborts at the same moment, so a run can
 *  cancel its own requests rather than only having its answer dropped. `fn` may return a
 *  value synchronously - then the result lands before the browser paints, with no loading
 *  frame. A returned promise is `loading` until it settles. A value a superseded run still
 *  produces goes to `discard`, so a run can release what it built. */
export function useAsync<T>(
	fn: (signal: AbortSignal) => T | Promise<T>,
	deps: DependencyList,
	options: { discard?: (value: T) => void } = {},
): Rerunnable<T> {
	const work = useRef(fn);
	work.current = fn;
	const discard = useRef(options.discard);
	discard.current = options.discard;
	const [controls] = useState(() => {
		const requests = latest<T>({
			discard: (value) => discard.current?.(value),
			publish: (value) => settle(new Ok(value)),
			failed: (error) => settle(new Err(error)),
		});
		const rerun = (): Promise<Settled<T>> =>
			requests.replace((signal) => {
				const result = work.current(signal);
				if (result instanceof Promise) settle(new Loading());
				return result;
			});
		return { requests, rerun };
	});
	const [state, setState] = useState<Rerunnable<T>>(() =>
		Object.assign(new Loading(), { rerun: controls.rerun }),
	);
	const settle = (next: AsyncState<T>): void =>
		setState(Object.assign(next, { rerun: controls.rerun }));
	useLayoutEffect(() => {
		void controls.rerun();
		return () => controls.requests.cancel();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
	return state;
}

/** `state`, except that while it is loading the last value it settled on is held. For a
 *  value a subtree is gated on: without it, a dependency change blanks the value for a
 *  frame and unmounts everything below, resetting its state. An error is never held. A
 *  `key` scopes the hold: when it changes, the last value is dropped rather than shown. */
export function useSticky<S extends AsyncState<unknown>>(
	state: S,
	key: unknown = null,
): S | Loading {
	const held = useRef<{ key: unknown; ok: S | null }>({ key, ok: null });
	if (held.current.key !== key) {
		held.current = { key, ok: null };
		return new Loading();
	}
	if (state.status === "loading") return held.current.ok ?? state;
	held.current.ok = state.status === "ok" ? state : null;
	return state;
}

/** `useAsync` with its result held sticky across runs; see {@link useSticky}. */
export function useAsyncSticky<T>(
	fn: (signal: AbortSignal) => T | Promise<T>,
	deps: DependencyList,
	key: unknown = null,
): Rerunnable<T> | Loading {
	return useSticky(useAsync(fn, [...deps, key]), key);
}
