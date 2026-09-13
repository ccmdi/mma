import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emit } from "@/lib/events";
import { getJobs } from "@/lib/jobs";

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

/** A map-scoped job system, driven the way a user drives it. Every call a run makes parks on
 *  the `Work` handed to `describeJobContract`'s factory. */
export interface JobSystem {
	/** Start a run from the system's own entry point. */
	start(): void;
	/** What the system's runs have written so far. */
	effects(): number;
	/** A second start while a run is live is refused rather than run beside it. */
	singleRun: boolean;
}

const TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;
const FRAMES = ["requestAnimationFrame", "cancelAnimationFrame"] as const;

function cancelEverything(): void {
	for (const job of getJobs()) job.cancel?.();
}

/** What every cancellable job promises, whatever runs it: a cancel reaches the work in flight,
 *  nothing is written or asked after it, and no run outlives its tray entry. `source` names the
 *  module that registers the job, which is how the coverage test finds it. */
export function describeJobContract(
	name: string,
	source: string,
	make: (work: Work) => JobSystem,
): void {
	describe(`${name} keeps the job contract (${source})`, () => {
		let work: Work;
		let system: JobSystem;

		beforeEach(() => {
			vi.useFakeTimers({
				toFake: typeof requestAnimationFrame === "function" ? [...TIMERS, ...FRAMES] : [...TIMERS],
			});
			work = new Work();
			system = make(work);
		});

		afterEach(async () => {
			cancelEverything();
			for (let i = 0; i < 3; i++) await work.answer();
			vi.useRealTimers();
		});

		/** However the work still in flight answers, nothing is written, nothing new is asked,
		 *  and no tray entry is left behind. */
		async function expectSilence(): Promise<void> {
			const effects = system.effects();
			const issued = work.issued;
			for (let i = 0; i < 4; i++) await work.answer({ honorAbort: false });
			expect(system.effects()).toBe(effects);
			expect(work.issued).toBe(issued);
			expect(getJobs()).toEqual([]);
		}

		it("works while live", async () => {
			system.start();
			for (let i = 0; i < 3; i++) await work.answer();
			expect(system.effects()).toBeGreaterThan(0);
			expect(getJobs()).toHaveLength(1);
		});

		it("stops for good when cancelled from the tray", async () => {
			system.start();
			await work.answer();
			cancelEverything();
			await expectSilence();
		});

		it("aborts the work in flight when cancelled", async () => {
			system.start();
			await work.answer();
			const inFlight = work.pendingSignals();
			expect(inFlight.length).toBeGreaterThan(0);
			cancelEverything();
			expect(inFlight.every((signal) => signal?.aborted)).toBe(true);
		});

		it("leaves nothing running once a double start is cancelled", async () => {
			system.start();
			system.start();
			expect(getJobs()).toHaveLength(system.singleRun ? 1 : 2);
			await work.answer();
			cancelEverything();
			await expectSilence();
		});

		it("keeps a run started after a cancel reachable while the cancelled run's work lands", async () => {
			system.start();
			await work.answer();
			cancelEverything();
			system.start();
			await work.answer({ honorAbort: false });
			// A system may refuse to start until the cancelled run has settled.
			if (getJobs().length === 0) system.start();
			expect(getJobs()).toHaveLength(1);

			cancelEverything();
			await expectSilence();
		});

		it("stops for good when the map closes", async () => {
			system.start();
			await work.answer();
			emit("map:close");
			await expectSilence();
		});
	});
}
