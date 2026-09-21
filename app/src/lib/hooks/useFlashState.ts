import { useCallback, useEffect, useRef, useState } from "react";

export type FlashState = "idle" | "busy" | "done";

const DONE_MS = 500;

/** The state of a button that runs async work: busy while `run`'s task runs, done for a
 *  moment after it succeeds, idle otherwise. A failed task returns to idle and rethrows.
 *  A run while another is in flight is ignored. */
export function useFlashState() {
	const [state, setState] = useState<FlashState>("idle");
	const busy = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	const run = useCallback(async (task: () => Promise<unknown>) => {
		if (busy.current) return;
		busy.current = true;
		clearTimeout(timer.current);
		setState("busy");
		try {
			await task();
		} catch (e) {
			setState("idle");
			throw e;
		} finally {
			busy.current = false;
		}
		setState("done");
		timer.current = setTimeout(() => setState("idle"), DONE_MS);
	}, []);

	return [state, run] as const;
}
