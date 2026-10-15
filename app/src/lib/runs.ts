import { cmd } from "@/lib/commands";

/** A backend call that answers only when it is over, so when it streams or can be
 *  aborted it reserves its run id up front: the id tells its streamed results apart and
 *  cancels it when `signal` aborts, and the call rejects with the signal's reason. */
export async function cancellable<T>(
	signal: AbortSignal | undefined,
	streams: boolean,
	call: (runId: number | null) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted();
	if (!signal && !streams) return call(null);
	const runId = await cmd.procedureReserveRun();
	const onAbort = () => {
		void cmd.procedureCancel(runId);
	};
	signal?.addEventListener("abort", onAbort);
	try {
		signal?.throwIfAborted();
		const out = await call(runId);
		signal?.throwIfAborted();
		return out;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
