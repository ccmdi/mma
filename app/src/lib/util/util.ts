/** Base URL for a custom URI scheme, platform-adjusted. */
export function schemeBase(scheme: string): string {
	return navigator.platform.startsWith("Win")
		? `http://${scheme}.localhost/`
		: `${scheme}://localhost/`;
}

/** URL that serves a local file over the `mma-buf://` protocol. @api @unstable */
export function mmaBufUrl(path: string): string {
	return (
		schemeBase("mma-buf") + path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")
	);
}

/** Copy of `set` with `value` toggled, or forced on/off by `on`. @api @unstable */
export function toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean): Set<T> {
	const next = new Set(set);
	if (on ?? !next.has(value)) next.add(value);
	else next.delete(value);
	return next;
}

/** The item `isBetter` prefers over every other, or null when there are none. @api @unstable */
export function bestBy<T>(items: Iterable<T>, isBetter: (a: T, b: T) => boolean): T | null {
	let best: T | null = null;
	for (const item of items) {
		if (best === null || isBetter(item, best)) best = item;
	}
	return best;
}

/** Shuffle `items` in place (Fisher-Yates) and return them. @api @unstable */
export function shuffle<T>(items: T[]): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = (Math.random() * (i + 1)) | 0;
		const tmp = items[i];
		items[i] = items[j];
		items[j] = tmp;
	}
	return items;
}

/** Split `arr` into sub-arrays of at most `n` elements. @api @unstable */
export function chunk<T>(arr: readonly T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

/** One result for one input, a list of results for a list. */
export type Each<I, R> = I extends readonly unknown[] ? R[] : R;

/** Run `many` over `input` as a list, answering in the plurality `input` came in. */
export async function each<T, R, I extends T | readonly T[]>(
	input: I,
	many: (all: T[]) => Promise<R[]>,
): Promise<Each<I, R>> {
	const plural = Array.isArray(input);
	const results = await many(plural ? [...input] : [input as T]);
	return (plural ? results : results[0]) as Each<I, R>;
}

/** Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
 *  Build metadata is ignored; a pre-release sorts below the release it precedes. @api @unstable */
export function cmpVersion(a: string, b: string): number {
	const [coreA, preA] = splitVersion(a);
	const [coreB, preB] = splitVersion(b);
	const na = coreA.split(".").map(Number);
	const nb = coreB.split(".").map(Number);
	for (let i = 0; i < Math.max(na.length, nb.length); i++) {
		const d = (na[i] ?? 0) - (nb[i] ?? 0);
		if (d) return d;
	}
	if (preA === preB) return 0;
	if (!preA || !preB) return preA ? -1 : 1;
	const ia = preA.split(".");
	const ib = preB.split(".");
	for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
		const x = ia[i];
		const y = ib[i];
		if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			if (Number(x) !== Number(y)) return Number(x) - Number(y);
		} else if (nx !== ny) return nx ? -1 : 1;
		else if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/** `["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent. @api @unstable */
export function splitVersion(v: string): [core: string, pre: string] {
	const m = /^v?([^-+]*)(?:-([^+]*))?/.exec(v.trim());
	return [m?.[1] ?? "", m?.[2] ?? ""];
}

/** True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1". @api @unstable */
export function isPrereleaseVersion(v: string): boolean {
	return splitVersion(v)[1] !== "";
}

/** True when the app runs in a browser instead of the desktop app. @api @unstable */
export function isWeb(): boolean {
	return Boolean(
		(window as { __TAURI_INTERNALS__?: { __webserve?: boolean } }).__TAURI_INTERNALS__?.__webserve,
	);
}

/** Prompt for files; resolves empty when the picker is dismissed. @api @unstable */
export function pickFiles(accept: string, opts: { multiple?: boolean } = {}): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = accept;
		input.multiple = opts.multiple ?? false;
		input.onchange = () => resolve([...(input.files ?? [])]);
		input.oncancel = () => resolve([]);
		input.click();
	});
}

/** Copy an image Blob to the clipboard. False when the platform refuses it. @api @unstable */
export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
	try {
		await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
		return true;
	} catch {
		return false;
	}
}

/** Compare strings with natural (numeric-aware) ordering. @api @unstable */
export function compareNatural(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

/** Current time as Unix seconds, the form Location timestamps use. @api @unstable */
export function nowUnix(): number {
	return Math.floor(Date.now() / 1000);
}

/** Rolling anchor for a phase-relative locations/second average. */
export interface PhaseRate {
	t0: number;
	done0: number;
	done: number;
	total: number;
}

/** Compute a locations/second rate for the current progress phase. Re-anchors when a
 *  new phase is detected (done went backward or total grew). Null until a quarter second
 *  of work has elapsed. @api @unstable */
export function phaseRate(
	prev: PhaseRate | null,
	done: number,
	total: number,
	now: number,
): { state: PhaseRate; rate: number | null } {
	const state =
		!prev || done < prev.done || total > prev.total
			? { t0: now, done0: done, done, total }
			: { ...prev, done, total };
	const dt = (now - state.t0) / 1000;
	const dd = state.done - state.done0;
	return { state, rate: dt >= 0.25 && dd > 0 ? dd / dt : null };
}
