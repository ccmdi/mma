import type { Tag } from "@/bindings.gen";
import type { TagSortMode } from "@/types";
import { colorForName } from "@/lib/util/color";

/** Base URL for a Tauri custom URI scheme. Windows WebView2 uses http://<scheme>.localhost/. */
export function schemeBase(scheme: string): string {
	return navigator.platform.startsWith("Win")
		? `http://${scheme}.localhost/`
		: `${scheme}://localhost/`;
}

/** URL that serves a local file over the `mma-buf://` protocol (binary Rust-to-JS transfers). */
export function mmaBufUrl(path: string): string {
	return schemeBase("mma-buf") + path.replace(/\\/g, "/");
}

/** Message for an unknown thrown value. */
export function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Copy of `set` with `value` toggled, or forced on/off by `on`. */
export function toggleInSet<T>(set: ReadonlySet<T>, value: T, on?: boolean): Set<T> {
	const next = new Set(set);
	if (on ?? !next.has(value)) next.add(value);
	else next.delete(value);
	return next;
}

/** The item `isBetter` prefers over every other, or null when there are none. */
export function bestBy<T>(items: Iterable<T>, isBetter: (a: T, b: T) => boolean): T | null {
	let best: T | null = null;
	for (const item of items) {
		if (best === null || isBetter(item, best)) best = item;
	}
	return best;
}

export function chunk<T>(arr: readonly T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

/** Compare two semver strings (e.g. "0.6.1", "0.7.0-rc.2"). Returns >0 if a > b.
 *  Build metadata is ignored; a pre-release sorts below the release it precedes. */
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

/** `["0.7.0", "rc.2"]` for `"v0.7.0-rc.2+build"`; the pre-release part is `""` when absent. */
export function splitVersion(v: string): [core: string, pre: string] {
	const m = /^v?([^-+]*)(?:-([^+]*))?/.exec(v.trim());
	return [m?.[1] ?? "", m?.[2] ?? ""];
}

/** True when `v` carries a semver pre-release tag, e.g. "1.0.0-beta.1". */
export function isPrereleaseVersion(v: string): boolean {
	return splitVersion(v)[1] !== "";
}

/** True when running under the web-serve bridge (a plain browser, no native shell). */
export function isWeb(): boolean {
	return Boolean(
		(window as { __TAURI_INTERNALS__?: { __webserve?: boolean } }).__TAURI_INTERNALS__?.__webserve,
	);
}

/** Trigger a browser download from an in-memory Blob. */
export function downloadBlob(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	a.click();
	URL.revokeObjectURL(url);
}

/** Copy an image Blob to the clipboard. False when the platform refuses it. */
export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
	try {
		await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
		return true;
	} catch {
		return false;
	}
}

// Order strings with embedded numbers by numeric value, not lexically
export function compareNatural(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

export function sortTagsByMode(
	tags: Tag[],
	mode: TagSortMode,
	counts: Record<number, number>,
): Tag[] {
	const sorted = [...tags];
	if (mode === "name") return sorted.sort((a, b) => a.name.localeCompare(b.name));
	if (mode === "amount") return sorted.sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0));
	return sorted.sort(
		(a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name),
	);
}

/** Color for a tag named `name`. An existing tag uses its stored color. */
export function tagColorFor(name: string, tags: Tag[]): string {
	const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
	return existing?.color ?? colorForName(name);
}

/** Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
 *  canonical casing. Returns the original array unchanged if already present. */
export function appendTagName(pending: string[], name: string, tags: Tag[]): string[] {
	const lower = name.toLowerCase();
	if (pending.some((n) => n.toLowerCase() === lower)) return pending;
	const existing = tags.find((t) => t.name.toLowerCase() === lower);
	return [...pending, existing ? existing.name : name];
}

// FOV (degrees) → zoom level
export function fovToZoom(fov: number): number {
	return -Math.log2((4 / 3) * Math.tan((Math.PI * fov) / 360)) + 1;
}

/** Current time as Unix seconds, the form Location timestamps use. */
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

/** Locations/second averaged over the progress phase in flight. A done that went backward
 *  or a total that grew means a new phase began (a hand-run resets its bar per phase;
 *  within one, done only grows and the total only shrinks as skips are found), so the
 *  average re-anchors there instead of carrying the previous phase's speed. Null until
 *  the phase shows a quarter second of work. */
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
