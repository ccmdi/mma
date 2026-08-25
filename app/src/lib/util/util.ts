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

/** Split into consecutive slices of at most `n` items. */
export function chunk<T>(arr: readonly T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

/** Compare two dotted version strings (e.g. "0.6.1"). Returns >0 if a > b. */
export function cmpVersion(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
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
