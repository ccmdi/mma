/**
 * Driver for the Rust procedure engine. A bulk operation is one or more procedures plus
 * a `Selector`: the engine resolves the selector, schedules the dependency waves, pages
 * the locations, calls each procedure and delivers what it answers, as patches or back
 * to the caller. Locations never reach JS.
 */

import type { Selector } from "@/bindings.gen";
import { holdAutosave } from "@/store/useMapStore";
import {
	getAllEnrichKeys,
	getDefaultEnrichKeys,
	getEnrichmentProviders,
	getProviderForField,
	type EnrichmentProvider,
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
	signal?.throwIfAborted();
	// A query answers only when it is over, so it is named up front to be cancellable.
	const token = signal ? nextQueryToken++ : null;
	const onAbort = () => {
		if (token !== null) void cmd.procedureQueryCancel(token);
	};
	signal?.addEventListener("abort", onAbort);
	try {
		const raw = await cmd.procedureQuery(
			entry,
			JSON.stringify(input),
			config === undefined ? null : JSON.stringify(config),
			token,
		);
		signal?.throwIfAborted();
		return JSON.parse(raw) as T;
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

export interface ResolverOutcome<TCollected = unknown> {
	/** Rows the procedure worked and did not fail. A count: the engine never ships the
	 *  ids of what went right. */
	success: number;
	/** Rows the procedure failed, by id, so a caller can select them. */
	failed: number[];
	/** Answers from a `collect` run, in page order. Absent for a run whose results were
	 *  written as patches. Typed by the spec's declaration, not checked: the value still
	 *  crosses a JSON boundary, so a reader guards it. */
	collected?: CollectedEntry<TCollected>[];
}

/** Whether a pass did anything worth a summary row. */
export function outcomeDidWork(o: ResolverOutcome): boolean {
	return o.success > 0 || o.failed.length > 0;
}
export type SvRunResult = Record<string, ResolverOutcome>;

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

export interface RunOpts {
	signal?: AbortSignal;
	force?: boolean;
	/** The `extra` keys the run should produce; null means the default set. */
	enrichFields?: string[] | null;
	/** `label` names the current phase; undefined = no labelled provider is running.
	 *  `done`/`total` are phase-relative and net of skipped rows, so they reset as each
	 *  dependency wave begins. */
	onProgress?: (done: number, total: number, label?: string) => void;
}

/** A provider to run, optionally overriding the config its procedure declares. */
export interface ProviderRun {
	provider: EnrichmentProvider;
	config?: unknown;
	/** Re-derive this provider's fields even on an unforced run. For an operation whose
	 *  point is to recompute one provider rather than fill in what is missing. */
	force?: boolean;
}

/** Providers `enrichAll` runs implicitly: the ones producing selectable `extra` fields. */
export function enrichFieldProviders(): EnrichmentProvider[] {
	return getEnrichmentProviders().filter((p) => p.fieldDefs);
}

/** Fields a provider should produce in this run: everything it declares, minus the
 *  ones the user deselected. Keys the enrichment UI never offers are always produced. */
function activeProviderFields(
	p: EnrichmentProvider,
	selectable: Set<string>,
	active: Set<string>,
): string[] {
	return Object.keys(p.fieldDefs ?? {}).filter((k) => !selectable.has(k) || active.has(k));
}

/** Drive a set of enrichment providers through the engine as one run.
 *  Locations never reach JS: the engine pages them, calls each procedure and writes the
 *  patches itself, reporting per-provider progress that this narrows to the wave in
 *  flight for the caller's bar. Resolves once every declared provider reports finished,
 *  or on abort. */
export async function runProviders(
	items: ProviderRun[],
	selector: Selector,
	opts: RunOpts = {},
): Promise<SvRunResult> {
	const { enrichFields = null } = opts;
	const selectable = new Set(getAllEnrichKeys());
	const active = new Set(enrichFields ?? getDefaultEnrichKeys());
	const decls: ProviderDecl[] = [];
	for (const { provider: p, config, force: providerForce } of items) {
		const fields = activeProviderFields(p, selectable, active);
		// A provider with `fieldDefs` and no active field was fully deselected; one with
		// no `fieldDefs` writes core columns and has nothing to deselect.
		if (p.fieldDefs && fields.length === 0) continue;
		const spec = p.procedure;
		if (spec.prepare && !(await spec.prepare())) continue;
		decls.push(
			declare(p.id, spec, selector, {
				label: p.label,
				config,
				force: providerForce,
				fields: [...fields, ...(p.provides ?? [])],
				requires: p.requires,
			}),
		);
	}
	return runDecls(decls, opts);
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
}

function declare(
	id: string,
	spec: ProcedureSpec,
	selector: Selector,
	o: DeclOpts,
): ProviderDecl {
	return {
		id,
		label: o.label ?? null,
		entry: spec.entry,
		fields: o.fields ?? [],
		requires: o.requires ?? [],
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
	opts: RunOpts & Omit<DeclOpts, "fields" | "requires"> & { id: string },
): Promise<ResolverOutcome<T>> {
	const { id, label, config, sink, force: specForce, ...run } = opts;
	if (spec.prepare && !(await spec.prepare())) return { success: 0, failed: [] };
	const decl = declare(id, spec, selector, { label, config, sink, force: specForce });
	const result = await runDecls([decl], run);
	return (result[id] as ResolverOutcome<T> | undefined) ?? { success: 0, failed: [] };
}

/** Drive declared procedures through the engine as one run and gather what comes back. */
async function runDecls(decls: ProviderDecl[], opts: RunOpts): Promise<SvRunResult> {
	const { signal, force = false, onProgress } = opts;
	const result: SvRunResult = {};
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
		let done = 0;
		let total = 0;
		const running: string[] = [];
		for (const id of phase) {
			const s = seen.get(id);
			if (!s) continue;
			// Skipped rows were never work, so they leave both sides of the bar. Each page
			// discovers more of them, which is why the denominator shrinks as a run goes.
			done += s.done - s.skipped;
			total += s.total - s.skipped;
			const label = labels.get(id);
			if (!s.finished && label) running.push(label);
		}
		onProgress?.(
			done,
			total,
			running.length === 1 ? running[0] : running.length > 1 ? msg("Enriching fields") : undefined,
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
			// Rows the engine skipped needed nothing; counting them would report work the
			// run never did, and a provider with nothing to do drops out of the summary.
			success: Math.max(0, s.done - s.failed - s.skipped),
			failed: failed.get(id) ?? [],
			...(collected.has(id) ? { collected: collected.get(id) } : {}),
		};
	}
	signal?.throwIfAborted();
	return result;
}

/** Every field-producing provider over a fixed id set, with no progress reporting. */
export async function runProvidersForIds(
	ids: number[],
	opts: {
		enrichFields: string[] | null;
		force?: boolean;
		signal?: AbortSignal;
		excludeIds?: string[];
	},
): Promise<void> {
	const providers = enrichFieldProviders().filter((p) => !opts.excludeIds?.includes(p.id));
	await runProviders(
		providers.map((provider) => ({ provider })),
		{ type: "Locations", locations: ids, name: null },
		{ enrichFields: opts.enrichFields, force: opts.force, signal: opts.signal },
	);
}
