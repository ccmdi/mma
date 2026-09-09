import { emit as emitEvent, subscribe } from "@/lib/events";
import { toast } from "@/lib/util/toast";

/** `map` jobs mutate the open map and are cancelled when it closes; `app` jobs survive. */
export type JobScope = "map" | "app";

export interface JobOpts {
	scope?: JobScope;
	/** Abort the underlying work. Omitted = the tray offers no cancel button. */
	cancel?: () => void;
	/** Reopen the owning UI. Omitted = the tray entry is not clickable. */
	reveal?: () => void;
}

export interface JobEntry {
	id: number;
	label: string;
	scope: JobScope;
	fraction: number;
	detail?: string;
	/** The owning UI is showing its own progress; the tray skips this entry. */
	hidden: boolean;
	cancel?: () => void;
	reveal?: () => void;
}

/** Handle for driving a registered job. All methods are no-ops once the job ended. */
export interface JobHandle {
	/** Set the progress bar fraction (0-1) and optional detail text. */
	update(fraction: number, detail?: string): void;
	setHidden(hidden: boolean): void;
	/** Remove the job, optionally leaving a brief toast. */
	finish(message?: string, duration?: number): void;
	/** Remove the job and leave an error toast. */
	fail(message: string): void;
}

let jobs: JobEntry[] = [];
let nextId = 0;

/** Live jobs, for the tray. Reference changes on every update. @unstable */
export function getJobs(): JobEntry[] {
	return jobs;
}

function patch(id: number, fields: Partial<JobEntry>) {
	jobs = jobs.map((j) => (j.id === id ? { ...j, ...fields } : j));
	emitEvent("jobs:changed");
}

function remove(id: number): boolean {
	const had = jobs.some((j) => j.id === id);
	if (had) {
		jobs = jobs.filter((j) => j.id !== id);
		emitEvent("jobs:changed");
	}
	return had;
}

/** Register a long-running operation with the global job tray. The caller owns the
 *  work; the registry owns only its presentation and the cancel/reveal controls. @unstable */
export function registerJob(label: string, opts: JobOpts = {}): JobHandle {
	const id = nextId++;
	jobs = [
		...jobs,
		{
			id,
			label,
			scope: opts.scope ?? "app",
			fraction: 0,
			hidden: false,
			cancel: opts.cancel,
			reveal: opts.reveal,
		},
	];
	emitEvent("jobs:changed");
	return {
		update(fraction, detail) {
			if (jobs.some((j) => j.id === id)) patch(id, { fraction, detail });
		},
		setHidden(hidden) {
			if (jobs.some((j) => j.id === id)) patch(id, { hidden });
		},
		finish(message, duration) {
			if (remove(id) && message) toast(message, duration);
		},
		fail(message) {
			if (remove(id)) toast(message, 5000);
		},
	};
}

export interface JobRunContext {
	signal: AbortSignal;
	report: (fraction: number, detail?: string) => void;
}

/** Sugar for promise-shaped work: registers a job wired to an AbortController, reports
 *  through the handle, and ends the job however `fn` settles. Cancelling resolves null;
 *  a real failure toasts and rethrows. @unstable */
export function runJob<R>(
	label: string,
	fn: (ctx: JobRunContext) => Promise<R>,
	opts: Omit<JobOpts, "cancel"> = {},
): Promise<R | null> {
	const ctl = new AbortController();
	const handle = registerJob(label, { ...opts, cancel: () => ctl.abort() });
	return fn({ signal: ctl.signal, report: (f, d) => handle.update(f, d) }).then(
		(r) => {
			handle.finish();
			return ctl.signal.aborted ? null : r;
		},
		(e) => {
			if (ctl.signal.aborted) {
				handle.finish();
				return null;
			}
			handle.fail(e instanceof Error ? e.message : String(e));
			throw e;
		},
	);
}

/** Cancel every live job of `scope` that can be cancelled. Owners observe their own
 *  abort and end their jobs; entries without a cancel are removed outright. @unstable */
export function cancelJobs(scope: JobScope): void {
	for (const j of [...jobs]) {
		if (j.scope !== scope) continue;
		if (j.cancel) j.cancel();
		else remove(j.id);
	}
}

subscribe("map:close", () => cancelJobs("map"));
