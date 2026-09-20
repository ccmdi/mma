import { Worker } from "node:worker_threads";

export interface CompareJob {
	before: string;
	after: string;
	/** Where the pair is written, for a surface whose imports resolve against a real directory. */
	dir?: string;
}

export interface CompareResult {
	missing: string[];
	broken: string[];
}

/** The pool oversubscribes a machine vitest has already saturated, so it stays small:
 *  past this, threads spend longer warming their own lib cache than they save. */
const WORKERS = 4;

const size = (j: CompareJob) => j.before.length + j.after.length;

/** Every comparison builds its own TypeScript programs, so the set of them is the slowest
 *  thing in this suite and a file is all vitest will parallelise. Threads carry the fan-out
 *  a single spec file cannot; each warms its own lib cache, so jobs are dealt out to
 *  whichever thread is free rather than split up front. */
export function compareAll(jobs: CompareJob[]): Promise<CompareResult[]> {
	const results: CompareResult[] = new Array(jobs.length);
	// Longest first: a big surface dealt last would still be running after every thread
	// beside it had gone idle.
	const order = jobs.map((_, i) => i).sort((a, b) => size(jobs[b]) - size(jobs[a]));
	let next = 0;

	const run = () =>
		new Promise<void>((resolve, reject) => {
			const worker = new Worker(new URL("./legacyCompare.worker.mjs", import.meta.url), {
				execArgv: [],
			});
			const deal = () => {
				if (next >= order.length) {
					void worker.terminate();
					resolve();
					return;
				}
				const i = order[next++];
				worker.postMessage({ i, job: jobs[i] });
			};
			worker.on("message", (m: { i: number; result?: CompareResult; error?: string }) => {
				if (m.error) {
					void worker.terminate();
					reject(new Error(m.error));
					return;
				}
				results[m.i] = m.result!;
				deal();
			});
			worker.on("error", reject);
			deal();
		});

	return Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, run)).then(
		() => results,
	);
}
