// Copyright year, Run shape. Rows are grouped by panoId, the batch asks the `copyright`
// sidecar to detect once per distinct pano, and each result line fans back out to every
// row sharing that pano.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "mma-plugin-types";

const PLUGIN_ID = "copyright";
const COMMAND = "detect";

/** A sidecar line. Progress lines carry done/total and no panoId. */
interface DetectLine {
	panoId?: string;
	year?: number | null;
	error?: string | null;
}

/** Sidecar stdout is forwarded verbatim, so a line that is not JSON is skipped rather
 *  than killing the batch. */
function parseLine(line: string): DetectLine | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return parsed && typeof parsed === "object" ? (parsed as DetectLine) : null;
	} catch {
		return null;
	}
}

/** Leading integer of a `YYYY-...` string, or -1 when there is none. */
function leadingYear(text: unknown): number {
	const m = typeof text === "string" ? /^\d+/.exec(text) : null;
	return m ? Number(m[0]) : -1;
}

/** A copyright year older than the capture belongs to a different image: Google
 *  re-stamps tiles, so a year behind `extra.imageDate` is a misread, not a fact. */
function yearFitsCapture(extra: Record<string, unknown> | null, year: number): boolean {
	const captured = leadingYear(extra?.imageDate);
	return captured < 0 || captured <= year;
}

export function run(rows: Location[]): Update<LocationPatch>[] {
	if (mma.aborted()) return [];

	const byPano = new Map<string, Location[]>();
	for (const row of rows) {
		if (!row.panoId) continue;
		const group = byPano.get(row.panoId);
		if (group) group.push(row);
		else byPano.set(row.panoId, [row]);
	}
	if (byPano.size === 0) return [];

	const payload = JSON.stringify({ panoIds: [...byPano.keys()] });
	const out: Update<LocationPatch>[] = [];
	mma.sidecar(PLUGIN_ID, COMMAND, payload, (line) => {
		const parsed = parseLine(line);
		const group = parsed?.panoId ? byPano.get(parsed.panoId) : undefined;
		if (!parsed || !group) return;
		for (const row of group) {
			if (parsed.error) mma.fail(row.id);
			else if (typeof parsed.year === "number" && yearFitsCapture(row.extra, parsed.year))
				out.push({ id: row.id, patch: { extra: { copyrightYear: parsed.year } } });
			mma.progress(1);
		}
	});
	return out;
}

/** Read-only entry. `{"op":"label","field":"copyrightYear","values":[..]}` answers with
 *  the display label for each value, aligned to `values`. */
export function query(input: { op?: string; field?: string; values?: string[] }): string[] {
	if (input.op !== "label" || input.field !== "copyrightYear") {
		throw new Error(`copyright: unknown query`);
	}
	return (input.values ?? []).map((v) => `\u00a9 ${v}`);
}
