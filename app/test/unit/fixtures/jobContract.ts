import { vi } from "vitest";

interface Parked {
	signal: AbortSignal | undefined;
	answer: (honorAbort: boolean) => void;
}

/** In-flight work a job issues. Every call parks until the test answers it, so a test
 *  decides exactly when a lookup lands relative to a stop. Needs fake timers. */
export class Work {
	private parked = new Set<Parked>();
	/** Calls issued so far. */
	issued = 0;

	park<T>(answer: () => T, signal?: AbortSignal): Promise<T> {
		this.issued++;
		return new Promise<T>((resolve, reject) => {
			const call: Parked = {
				signal,
				answer: (honorAbort) => {
					this.parked.delete(call);
					if (honorAbort && signal?.aborted) reject(signal.reason);
					else resolve(answer());
				},
			};
			this.parked.add(call);
		});
	}

	/** Signals of the calls still waiting for an answer. */
	pendingSignals(): (AbortSignal | undefined)[] {
		return [...this.parked].map((c) => c.signal);
	}

	/** Answer every call parked right now, then let timers and frames run. With `honorAbort`
	 *  off, a cancelled call answers with data anyway, like a lookup that landed too late. */
	async answer({ honorAbort = true } = {}): Promise<void> {
		for (const call of [...this.parked]) call.answer(honorAbort);
		await vi.advanceTimersByTimeAsync(1100);
	}
}
