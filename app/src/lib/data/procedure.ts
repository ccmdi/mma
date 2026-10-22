import { Autosave } from "@/store/autosave";
import type { Selector } from "@/types";
import type {
	BatchMode,
	Location,
	ProcedureDecl,
	ProcedureProgress,
	ProcedureResult,
	ProviderDecl,
	RunItem,
	Target,
} from "@/bindings.gen";
import { events } from "@/bindings.gen";
import type { Sink } from "@/bindings.consts";
import { cmd } from "@/lib/commands";
import { cancellable } from "@/lib/runs";
import { log } from "@/lib/util/log";

/** The declared form of a wire struct: every field optional, absent where the wire says null. */
type Declared<T> = { [K in keyof T]?: NonNullable<T[K]> };

/** A unit of work for the procedure engine: the procedure's own declaration (`ProcedureDecl`,
 *  what a run and a query both read) plus how a run schedules it. */
export interface ProcedureSpec<TCollected = unknown, TConfig = unknown>
	extends
		Declared<Omit<ProcedureDecl, "entry" | "config">>,
		Declared<Pick<ProviderDecl, "select" | "sink" | "instances">> {
	/** Phantom field carrying the `TCollected` type. Never set at runtime. */
	readonly collects?: TCollected;
	/** Module entry point: absolute path, `res://procedures/<name>.js` for built-in
	 *  procedures, or a relative filename (resolved against the plugin's directory). */
	entry: string;
	batch: BatchMode;
	/** The procedure's own configuration, handed to every entry point as `config`. */
	config?: TConfig;
	/** Awaited before the procedure joins a run; returning false excludes it. */
	prepare?: () => Promise<boolean>;
}

/** One location's answer from a `collect` run. */
export interface CollectedEntry<T = unknown> {
	id: number;
	value: T;
}

export interface BatchOutcome {
	/** Count of locations the procedure processed successfully. */
	succeeded: number;
	/** IDs of locations the procedure failed on. */
	failed: number[];
}

export interface ProcedureOutcome<TCollected = unknown> extends BatchOutcome {
	/** Answers from a `collect` run, in page order. Absent when results were written as patches. */
	collected?: CollectedEntry<TCollected>[];
}

/** Every item a run scheduled, by id. */
export type ProcedureOutcomes = Record<string, ProcedureOutcome>;

/** One item's own progress. Counts are net of skipped locations. */
export interface ProcedurePart {
	label: string;
	done: number;
	total: number;
	failed: number;
	finished: boolean;
}

export interface RunOpts {
	signal?: AbortSignal;
	force?: boolean;
	/** Read locations and write results at this target instead of the map. */
	on?: Target;
	/** `done`/`total` reflect the slowest item. `parts` carries each labeled item's own
	 *  counts, ordered as declared. */
	onProgress?: (done: number, total: number, parts: ProcedurePart[]) => void;
	/** Each location as an item finishes with it (locations-only runs). The same location
	 *  arrives again from each later item. */
	onPartial?: (rows: Location[]) => void;
}

export type BulkOpts = Pick<RunOpts, "signal" | "onProgress">;

/** An item for `Procedure.drive`, with the label its progress shows. */
export interface Scheduled {
	id: string;
	label: string | null;
	item: RunItem;
}

/** What a one-off run may set on top of what the spec declares. */
interface RunSettings {
	id: string;
	label?: string;
	/** `collect` takes the answers instead of writing them. */
	sink?: Sink;
	/** Recompute locations that already hold what the procedure writes. */
	force?: boolean;
}

/** A collected answer is the module's own JSON; a module that emits something else
 *  loses that entry rather than the run. */
function parseAnswer(id: string, json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		log.warn(`[procedure] ${id}: answer is not JSON (${json.slice(0, 80)})`);
		return null;
	}
}

/** Procedure modules: ask one a question, or run one over locations. @api */
export const Procedure = {
	/** Entry point of a procedure this app bundles. Plugins ship their own paths. @unstable */
	entry: (name: string): string => `res://procedures/${name}.js`,
	/** The readable name behind an entry point, for surfaces that show one. @unstable */
	name: (entry: string): string => entry.replace(/^res:\/\/procedures\//, "").replace(/\.js$/, ""),
	/** The part of a spec the engine reads for a run and a query alike, with `config` as the
	 *  JSON text the wire carries. @unstable */
	decl: (spec: ProcedureSpec, config: unknown = spec.config): ProcedureDecl => ({
		entry: spec.entry,
		rate: spec.rate ?? null,
		retry: spec.retry ?? null,
		inflight: spec.inflight ?? null,
		config: config === undefined ? null : JSON.stringify(config),
	}),
	/** An outcome for work that never ran. @unstable */
	noWork: (): BatchOutcome => ({ succeeded: 0, failed: [] }),
	/** Ask a procedure a read-only question under its declared network limits. Rejects when it
	 *  exports no `query`, when the call fails, or when `signal` aborts. `onPartial` receives
	 *  pages of answers as they resolve, ahead of the full result; each entry carries the id
	 *  the emitting side chose for it. @unstable */
	query: async <T = unknown, P = unknown>(
		spec: ProcedureSpec,
		input: unknown,
		opts: {
			signal?: AbortSignal;
			onPartial?: (entries: { id: number; value: P }[]) => void;
		} = {},
	): Promise<T> => {
		const { signal, onPartial } = opts;
		let unlisten: (() => void) | undefined;
		const raw = await cancellable(signal, !!onPartial, async (runId) => {
			if (onPartial) {
				unlisten = await events.procedureResult.listen(({ payload }) => {
					if (payload.runId !== runId || payload.entries.length === 0) return;
					onPartial(payload.entries.map((e) => ({ id: e.id, value: JSON.parse(e.json) as P })));
				});
			}
			return cmd.procedureQuery(Procedure.decl(spec), JSON.stringify(input), runId);
		}).finally(() => unlisten?.());
		return JSON.parse(raw) as T;
	},
	/** Run a single procedure over `selector` and return its typed results. @unstable */
	run: async <T, C>(
		spec: ProcedureSpec<T, C>,
		selector: Selector,
		opts: Omit<RunOpts, "force"> & RunSettings & { config?: Partial<NoInfer<C>> },
	): Promise<ProcedureOutcome<T>> => {
		const { id, label, config, sink, force, ...run } = opts;
		if (spec.prepare && !(await spec.prepare())) return Procedure.noWork();
		const decl: ProviderDecl = {
			id,
			label: label ?? null,
			...Procedure.decl(spec, config === undefined ? spec.config : config),
			fields: [],
			requires: [],
			select: spec.select ?? selector,
			batch: spec.batch,
			sink: sink ?? spec.sink ?? "patch",
			force: force ?? false,
			instances: spec.instances ?? null,
		};
		const result = await Procedure.drive(
			[{ id, label: label ?? null, item: { kind: "procedure", ...decl } }],
			run,
		);
		return (result[id] as ProcedureOutcome<T> | undefined) ?? Procedure.noWork();
	},
	/** Drive scheduled items through the engine as one run and gather what comes back. @unstable */
	drive: async (scheduled: Scheduled[], opts: RunOpts): Promise<ProcedureOutcomes> => {
		const { signal, force = false, onProgress } = opts;
		const target = opts.on ?? null;
		const result: ProcedureOutcomes = {};
		if (scheduled.length === 0) return result;

		const seen = new Map<string, ProcedureProgress>();
		const collected = new Map<string, CollectedEntry[]>();
		const { promise: ended, resolve: settle } = Promise.withResolvers<void>();

		const net = (s?: ProcedureProgress) => ({
			done: s ? s.done - s.skipped : 0,
			total: s ? s.total - s.skipped : 0,
			failed: s?.failed ?? 0,
			finished: s?.finished ?? false,
		});
		const partsOf = () =>
			scheduled
				.filter((s) => s.label != null)
				.map((s) => ({ label: s.label as string, ...net(seen.get(s.id)) }));
		// Every scheduled item reports as waiting before the first engine event, so the
		// progress stack renders at its final height instead of popping in row by row.
		onProgress?.(0, 0, partsOf());

		const handle = (p: ProcedureProgress) => {
			seen.set(p.providerId, p);
			const parts = partsOf();
			// Overall is locations finished through every item: the slowest one's count. An
			// item that skipped its whole universe carries no work and counts for nothing.
			const counting = scheduled
				.map((s) => net(seen.get(s.id)))
				.filter((s) => !(s.finished && s.total === 0));
			const done = counting.length > 0 ? Math.min(...counting.map((s) => s.done)) : 0;
			const total = Math.max(0, ...counting.map((s) => s.total));
			onProgress?.(done, total, parts);
			if (seen.size === scheduled.length && seen.values().every((s) => s.finished)) settle();
		};

		const failed = new Map<string, number[]>();
		const gather = (r: ProcedureResult) => {
			if (target && opts.onPartial && r.entries.length > 0) {
				opts.onPartial(r.entries.map((e) => JSON.parse(e.json) as Location));
			}
			if (r.entries.length > 0) {
				const into = collected.get(r.providerId) ?? [];
				for (const e of r.entries)
					into.push({ id: e.id, value: parseAnswer(r.providerId, e.json) });
				collected.set(r.providerId, into);
			}
			if (r.failed.length > 0) {
				const into = failed.get(r.providerId) ?? [];
				into.push(...r.failed);
				failed.set(r.providerId, into);
			}
		};

		const runId = await cmd.runReserve();
		const unlisten = await events.procedureProgress.listen((e) => {
			if (e.payload.runId === runId) handle(e.payload);
		});
		const unlistenResults = await events.procedureResult.listen((e) => {
			if (e.payload.runId === runId) gather(e.payload);
		});

		const onAbort = () => {
			void cmd.runCancel(runId);
			settle();
		};
		const releaseAutosave = Autosave.paused.hold();
		try {
			await cmd.procedureRun(
				// An item that sets no force of its own takes the run's.
				scheduled.map((s) => ({ ...s.item, force: s.item.force ?? force })),
				target,
				runId,
			);
			if (signal?.aborted) onAbort();
			signal?.addEventListener("abort", onAbort);
			await ended;
		} finally {
			releaseAutosave();
			signal?.removeEventListener("abort", onAbort);
			unlisten();
			unlistenResults();
		}

		for (const [id, s] of seen) {
			result[id] = {
				// Skipped locations were not work.
				succeeded: Math.max(0, s.done - s.failed - s.skipped),
				failed: failed.get(id) ?? [],
				...(collected.has(id) ? { collected: collected.get(id) } : {}),
			};
		}
		signal?.throwIfAborted();
		return result;
	},
};
