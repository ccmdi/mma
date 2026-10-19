import { useEffect, useRef, useState } from "react";
import { latest } from "@/lib/util/latest";
import { Cancelled, Idle, Running, type JobState, type Settled } from "@/types/util";

/** What a job's work is handed. */
export interface JobContext<P> {
	signal: AbortSignal;
	/** Push a progress value to the UI. Ignored once the job is cancelled. */
	report: (progress: P) => void;
}

/** A job's state, with the controls that start and stop it. */
export type Job<R, P = never> = JobState<R, P> & {
	/** Start `work`, resolving to how it settled. While a run is under way this does nothing
	 *  and resolves cancelled, so a double-clicked button cannot start two. */
	run: <T extends R>(work: (ctx: JobContext<P>) => Promise<T>) => Promise<Settled<T>>;
	/** Stop the run under way; nothing it does afterwards can write back. */
	cancel: () => void;
};

/** User-triggered async work that reports progress and can be cancelled. Unmounting cancels. */
export function useJob<R = unknown, P = never>(): Job<R, P> {
	const [runs] = useState(() => latest<unknown>());
	const running = useRef(false);
	const [controls] = useState(() => ({
		run: async <T extends R>(work: (ctx: JobContext<P>) => Promise<T>): Promise<Settled<T>> => {
			if (running.current) return new Cancelled();
			running.current = true;
			settle(new Running());
			const settled = (await runs.replace((signal) =>
				work({ signal, report: (progress) => !signal.aborted && settle(new Running(progress)) }),
			)) as Settled<T>;
			if (settled.status !== "cancelled") {
				running.current = false;
				settle(settled);
			}
			return settled;
		},
		cancel: () => {
			if (!running.current) return;
			running.current = false;
			runs.cancel();
			settle(new Cancelled());
		},
	}));
	const [state, setState] = useState<Job<R, P>>(() => Object.assign(new Idle(), controls));
	const settle = (next: JobState<R, P>) => setState(Object.assign(next, controls));
	useEffect(() => () => runs.cancel(), [runs]);
	return state;
}
