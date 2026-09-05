/**
 * Driver for the Rust procedure engine. A bulk operation is one or more procedures plus
 * a `Selector`: the engine resolves the selector, schedules the dependency waves, pages
 * the locations, calls each procedure and delivers what it answers, as patches or back
 * to the caller. Locations never reach JS.
 */

import type { Location, RowsRun, Selector } from "@/bindings.gen";
import { holdAutosave } from "@/store/useMapStore";
import {
	derivedFrom,
	getProviderForField,
	getProviders,
	type Provider,
	type ProcedureSpec,
} from "@/lib/data/fieldDefs";
import { events } from "@/bindings.gen";
import type { ProcedureProgress, ProcedureResult, ProviderDecl, Sink } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { msg } from "@/lib/i18n";

/** Entry point of a procedure this app bundles. Plugins ship their own paths. */
export const procedureEntry = (name: string) => `res://procedures/${name}.js`;

/** Ask a procedure a read-only question. `input` and the answer are the module's own
 *  contract -- the engine only carries the JSON. Rejects when the module exports no
 *  `query` or the call fails, and with the signal's reason once `signal` aborts, at
 *  which point the engine declines the query's remaining requests. `T` is an unchecked
 *  assertion over that contract: sound for the app's own `res://` modules, which are
 *  pinned by tests. Validate instead of naming a `T` when the module is a plugin's. */
export async function queryProcedure<T = unknown>(
	entry: string,
	input: unknown,
	config?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const raw = await cancellable(signal, (token) =>
		cmd.procedureQuery(
			entry,
			JSON.stringify(input),
			config === undefined ? null : JSON.stringify(config),
			token,
		),
	);
	return JSON.parse(raw) as T;
}

/** An engine call that answers only when it is over, so it is named up front to be
 *  cancellable: the token reaches the engine through `procedureQueryCancel` when
 *  `signal` aborts, and the call rejects with the signal's reason. */
async function cancellable<T>(
	signal: AbortSignal | undefined,
	call: (token: number | null) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted();
	const token = signal ? nextQueryToken++ : null;
	const onAbort = () => {
		if (token !== null) void cmd.procedureQueryCancel(token);
	};
	signal?.addEventListener("abort", onAbort);
	try {
		const out = await call(token);
		signal?.throwIfAborted();
		return out;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

let nextQueryToken = 1;

/** Display labels for a field's partition keys, from the procedure that owns the field.
 *  A module with no `label` query -- or one answering anything but a matching array of
 *  strings -- leaves the keys as they are. */
export async function resolveFieldLabels(field: string, keys: string[]): Promise<string[]> {
	const entry = getProviderForField(field)?.procedure.entry;
	if (!entry || keys.length === 0) return keys;
	try {
		const labels = await queryProcedure<unknown>(entry, { op: "label", field, values: keys });
		if (Array.isArray(labels) && labels.length === keys.length) {
			return labels.map((l, i) => (typeof l === "string" ? l : keys[i]));
		}
	} catch (e) {
		log.debug(`[procedure] ${field}: no label query (${e})`);
	}
	return keys;
}

/** One location's answer from a `collect` run, as its module defines it. */
export interface CollectedEntry<T = unknown> {
	id: number;
	value: T;
}

export interface BatchOutcome {
	/** Rows the procedure worked and did not fail. A count: the engine never ships the
	 *  ids of what went right. */
	succeeded: number;
	/** Rows the procedure failed, by id, so a caller can select them. */
	failed: number[];
}

export interface ProcedureOutcome<TCollected = unknown> extends BatchOutcome {
	/** Answers from a `collect` run, in page order. Absent for a run whose results were
	 *  written as patches. Typed by the spec's declaration, not checked: the value still
	 *  crosses a JSON boundary, so a reader guards it. */
	collected?: CollectedEntry<TCollected>[];
}

/** Every declaration a run scheduled, by provider id. */
export type ProviderOutcomes = Record<string, ProcedureOutcome>;

export const noWork = (): BatchOutcome => ({ succeeded: 0, failed: [] });

/** A collected answer is the module's own JSON; a module that emits something else
 *  loses that entry rather than the run. */
function parseAnswer(providerId: string, json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		log.warn(`[procedure] ${providerId}: answer is not JSON (${json.slice(0, 80)})`);
		return null;
	}
}

/** One wave member's own progress, for a caller that shows the providers of a
 *  multi-provider wave individually. Counts are net of skipped rows. */
export interface PhasePart {
	label: string;
	done: number;
	total: number;
	finished: boolean;
}

export interface RunOpts {
	signal?: AbortSignal;
	force?: boolean;
	/** `label` names the current phase; undefined = no labelled provider is running.
	 *  `done`/`total` are phase-relative and net of skipped rows, so they reset as each
	 *  dependency wave begins. A wave of several providers combines as min/max -- a row
	 *  counts done once its slowest provider has passed it, over the wave's row universe,
	 *  never a per-provider sum -- and `parts` then carries each member's own counts. */
	onProgress?: (done: number, total: number, label?: string, parts?: PhasePart[]) => void;
}

export type BulkOpts = Pick<RunOpts, "signal" | "onProgress">;

/** A provider to run, optionally overriding the config its procedure declares. */
export interface ProviderRun {
	provider: Provider;
	config?: unknown;
	/** Re-derive this provider's fields even on an unforced run. For an operation whose
	 *  point is to recompute one provider rather than fill in what is missing. */
	force?: boolean;
	/** The `fieldDefs` keys to produce; omitted, every key it declares. */
	fields?: string[];
}

/** Drive a set of providers through the engine as one run over `rows`: a selector, which
 *  the engine pages out of the store and writes back into, reporting per-provider
 *  progress that this narrows to the wave in flight for the caller's bar; or locations
 *  handed in, which run in a store of their own and come back as the providers left
 *  them, with nothing reaching the map. Resolves once every declared provider reports
 *  finished, or on abort. */
export async function runProviders(
	items: ProviderRun[],
	rows: Selector,
	opts?: RunOpts,
): Promise<ProviderOutcomes>;
export async function runProviders(
	items: ProviderRun[],
	rows: Location[],
	opts?: RunOpts,
): Promise<RowsRun>;
export async function runProviders(
	items: ProviderRun[],
	rows: Selector | Location[],
	opts: RunOpts = {},
): Promise<ProviderOutcomes | RowsRun> {
	const selector: Selector = Array.isArray(rows) ? { type: "Everything" } : rows;
	// Core columns cannot be nulled through `extra`; a changed core input still cascades
	// into the extra fields derived from it.
	const core = new Set(getProviders().flatMap((p) => p.provides ?? []));
	const decls: ProviderDecl[] = [];
	for (const { provider: p, config, force: providerForce, fields: wanted } of items) {
		const fields = wanted ?? Object.keys(p.fieldDefs ?? {});
		// A provider with `fieldDefs` and no field to produce has nothing to do; one with
		// no `fieldDefs` writes core columns and has nothing to deselect.
		if (p.fieldDefs && fields.length === 0) continue;
		const written = [...fields, ...(p.provides ?? [])];
		const decl = await declare(p.id, p.procedure, selector, {
			label: p.label,
			config,
			force: providerForce,
			fields: written,
			requires: p.requires,
			invalidates: Object.fromEntries(
				written
					.map((f) => [f, [...derivedFrom([f])].filter((k) => !core.has(k))] as const)
					.filter(([, deps]) => deps.length > 0),
			),
		});
		if (decl) decls.push(decl);
	}
	return Array.isArray(rows) ? runRows(decls, rows, opts) : runDecls(decls, opts);
}

/** The engine holds ids as unsigned integers, so a row travels under its position and
 *  comes back under its own id (a virtual location's is negative). */
async function runRows(decls: ProviderDecl[], rows: Location[], opts: RunOpts): Promise<RowsRun> {
	if (decls.length === 0 || rows.length === 0) return { rows, failed: {} };
	const standIns = rows.map((r, i) => ({ ...r, id: i + 1 }));
	const out = await cancellable(opts.signal, (token) =>
		cmd.procedureRunRows(decls, opts.force ?? false, standIns, token),
	);
	const idOf = (standIn: number) => rows[standIn - 1].id;
	return {
		rows: out.rows.map((r) => ({ ...r, id: idOf(r.id) })),
		failed: Object.fromEntries(
			Object.entries(out.failed).map(([provider, ids]) => [provider, ids.map(idOf)]),
		),
	};
}

/** What a run may set on top of what the spec declares. */
interface DeclOpts {
	label?: string;
	/** Replaces the spec's `config`. */
	config?: unknown;
	/** `collect` takes the answers instead of writing them. */
	sink?: Sink;
	/** Re-derive even on an unforced run: recompute rather than fill in what is missing. */
	force?: boolean;
	fields?: string[];
	requires?: string[];
	invalidates?: Record<string, string[]>;
}

/** Null when the spec's `prepare` gate declines, dropping it from the run. */
async function declare(
	id: string,
	spec: ProcedureSpec,
	selector: Selector,
	o: DeclOpts,
): Promise<ProviderDecl | null> {
	if (spec.prepare && !(await spec.prepare())) return null;
	return {
		id,
		label: o.label ?? null,
		entry: spec.entry,
		fields: o.fields ?? [],
		requires: o.requires ?? [],
		invalidates: o.invalidates ?? {},
		select: spec.select ?? selector,
		batch: spec.batch,
		sink: o.sink ?? spec.sink ?? "patch",
		force: o.force ?? null,
		rate: spec.rate ?? null,
		retry: spec.retry ?? null,
		inflight: spec.inflight ?? null,
		instances: spec.instances ?? null,
		config: JSON.stringify(o.config === undefined ? (spec.config ?? null) : o.config),
	};
}

/** Run one procedure over `selector`, on its own. The primitive: a consumer that is not
 *  enrichment (validation, a download resolving pano ids) declares a spec and calls this,
 *  and gets its collected answers typed by the spec. */
export async function runProcedure<T>(
	spec: ProcedureSpec<T>,
	selector: Selector,
	opts: Omit<RunOpts, "force"> & Omit<DeclOpts, "fields" | "requires"> & { id: string },
): Promise<ProcedureOutcome<T>> {
	const { id, label, config, sink, force: specForce, ...run } = opts;
	const decl = await declare(id, spec, selector, { label, config, sink, force: specForce });
	if (!decl) return noWork();
	const result = await runDecls([decl], run);
	return (result[id] as ProcedureOutcome<T> | undefined) ?? noWork();
}

/** Drive declared procedures through the engine as one run and gather what comes back. */
async function runDecls(decls: ProviderDecl[], opts: RunOpts): Promise<ProviderOutcomes> {
	const { signal, force = false, onProgress } = opts;
	const result: ProviderOutcomes = {};
	if (decls.length === 0) return result;
	const labels = new Map(decls.map((d) => [d.id, d.label ?? undefined]));

	const seen = new Map<string, ProcedureProgress>();
	const collected = new Map<string, CollectedEntry[]>();
	let settle = () => {};
	const ended = new Promise<void>((resolve) => {
		settle = resolve;
	});

	// The engine runs providers in sequential dependency waves, so the bar tracks the
	// wave in flight: a provider reporting in after every member of the phase finished
	// opens a new one.
	let phase: string[] = [];

	const handle = (p: ProcedureProgress) => {
		seen.set(p.providerId, p);
		if (!phase.includes(p.providerId)) {
			if (phase.every((id) => seen.get(id)?.finished)) phase = [];
			phase.push(p.providerId);
		}
		// A member that skipped every row carries no work and would pin the min at zero.
		const members = phase
			.map((id) => seen.get(id))
			.filter((s): s is ProcedureProgress => s !== undefined && s.total - s.skipped > 0);
		// A lone member nets skipped rows off both sides; several combine as min/max over
		// the wave's one row universe.
		let done = 0;
		let total = 0;
		if (members.length === 1) {
			done = members[0].done - members[0].skipped;
			total = members[0].total - members[0].skipped;
		} else if (members.length > 1) {
			done = Math.min(...members.map((s) => s.done));
			total = Math.max(...members.map((s) => s.total));
		}
		const labeled = members.filter((s) => labels.get(s.providerId) !== undefined);
		const parts =
			labeled.length > 1
				? labeled.map((s) => ({
						label: labels.get(s.providerId) as string,
						done: s.done - s.skipped,
						total: s.total - s.skipped,
						finished: s.finished,
					}))
				: undefined;
		const running = labeled.filter((s) => !s.finished);
		onProgress?.(
			done,
			total,
			running.length === 1
				? labels.get(running[0].providerId)
				: running.length > 1
					? msg("Enriching fields")
					: undefined,
			parts,
		);
		if (seen.size === decls.length && [...seen.values()].every((s) => s.finished)) settle();
	};

	const failed = new Map<string, number[]>();
	const gather = (r: ProcedureResult) => {
		if (r.entries.length > 0) {
			const into = collected.get(r.providerId) ?? [];
			for (const e of r.entries) into.push({ id: e.id, value: parseAnswer(r.providerId, e.json) });
			collected.set(r.providerId, into);
		}
		if (r.failed.length > 0) {
			const into = failed.get(r.providerId) ?? [];
			into.push(...r.failed);
			failed.set(r.providerId, into);
		}
	};

	// Listen before the run starts, buffering until the id it belongs to is known.
	let runId: number | null = null;
	const pending: ProcedureProgress[] = [];
	const pendingResults: ProcedureResult[] = [];
	const unlisten = await events.procedureProgress.listen((e) => {
		if (runId === null) pending.push(e.payload);
		else if (e.payload.runId === runId) handle(e.payload);
	});
	const unlistenResults = await events.procedureResult.listen((e) => {
		if (runId === null) pendingResults.push(e.payload);
		else if (e.payload.runId === runId) gather(e.payload);
	});

	const onAbort = () => {
		if (runId !== null) void cmd.procedureCancel(runId);
		settle();
	};
	const releaseAutosave = holdAutosave();
	try {
		runId = await cmd.procedureRun(decls, force);
		for (const r of pendingResults) if (r.runId === runId) gather(r);
		for (const p of pending) if (p.runId === runId) handle(p);
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
			// Skipped rows were not work.
			succeeded: Math.max(0, s.done - s.failed - s.skipped),
			failed: failed.get(id) ?? [],
			...(collected.has(id) ? { collected: collected.get(id) } : {}),
		};
	}
	signal?.throwIfAborted();
	return result;
}
