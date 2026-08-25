import { useEffect, useRef, useState } from "react";
import { useStableHandler } from "@/lib/hooks/useStableHandler";

export interface JobContext<P> {
	signal: AbortSignal;
	/** Push a progress value to the UI. Ignored once the job is cancelled. */
	report: (progress: P) => void;
}

export interface Job<R, P> {
	running: boolean;
	progress: P | null;
	result: R | null;
	/** Message from a failed run. Cancelling is not a failure and leaves this null. */
	error: string | null;
	run: () => void;
	cancel: () => void;
}

/** A user-triggered async job that reports progress and can be cancelled -- the
 *  run/cancel/progress/error state every long plugin action was keeping by hand.
 *  Cancelling aborts the signal and stops the UI immediately; nothing the job does
 *  afterwards can write back. Unmounting cancels. `run` while running is a no-op,
 *  so a double-clicked button cannot start two.
 *
 *  For work driven by changing deps rather than a click, use `useAsync`. */
export function useJob<R = void, P = string>(fn: (ctx: JobContext<P>) => Promise<R>): Job<R, P> {
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState<P | null>(null);
	const [result, setResult] = useState<R | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	const body = useStableHandler(fn);

	const cancel = useStableHandler(() => {
		abort.current?.abort();
		abort.current = null;
		setRunning(false);
		setProgress(null);
	});

	const run = useStableHandler(() => {
		if (abort.current) return;
		const ctl = new AbortController();
		abort.current = ctl;
		setRunning(true);
		setProgress(null);
		setResult(null);
		setError(null);

		const live = () => !ctl.signal.aborted;
		body({ signal: ctl.signal, report: (p) => live() && setProgress(p) })
			.then((r) => live() && setResult(r))
			.catch((e) => live() && setError(e instanceof Error ? e.message : String(e)))
			.finally(() => {
				if (!live()) return;
				abort.current = null;
				setRunning(false);
				setProgress(null);
			});
	});

	useEffect(() => cancel, [cancel]);

	return { running, progress, result, error, run, cancel };
}
