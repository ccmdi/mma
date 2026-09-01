// Exact capture timestamp. The month window from `extra.imageDate` is narrowed against
// Google's SingleImageSearch RPC until the first frame of coverage is bracketed to one
// second, and written as `extra.datetime` in unix seconds.
//
// `run` narrows a whole batch as one wavefront: every round issues one probe per cut for
// every row still searching, in a single host call. A round costs one round trip whatever
// the batch size, and the width it runs at is the engine's `inflight` budget rather than
// anything this module decides. `query` answers the same question for a single point.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import type {
	ProcedureRequest,
	ProcedureResponse,
	} from "@/lib/data/procedureHost";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { SIS_NO_IMAGES, timestampSearchRequest } from "@/lib/sv/singleImageSearch";

/** Interior probes per search round, splitting [lo, hi) into BRANCH+1 segments. */
const BRANCH = 4;
const ACCURACY = 1;
const DAY = 86400;

interface Search {
	id: number;
	lat: number;
	lng: number;
	lo: number;
	hi: number;
	hiInit: number;
	cuts: number[];
	/** Set once the row has a verdict; an unsettled row at the end was cut short. */
	settled: boolean;
	ts: number | null;
}

/** A search over the `(lo, hi]` window a `YYYY-MM` capture month spans, or null when the
 *  value is not one. */
function newSearch(id: number, lat: number, lng: number, yearMonth: unknown): Search | null {
	const m = /^(\d{4})-(\d{2})$/.exec(String(yearMonth));
	if (!m) return null;
	const month = Number(m[2]);
	if (month < 1 || month > 12) return null;
	const first = Date.UTC(Number(m[1]), month - 1, 1) / 1000;
	const hi = first + 32 * DAY;
	return { id, lat, lng, lo: first - DAY, hi, hiInit: hi, cuts: [], settled: false, ts: null };
}

const decoder = new TextDecoder();

/** 1 = coverage in (start, end], 0 = none, -1 = request failed. A failure must never
 *  read as "no images": the search treats a negative as evidence. */
function verdict(res: ProcedureResponse | undefined): number {
	if (!res || res.status < 200 || res.status >= 300) return -1;
	return decoder.decode(res.body).includes(SIS_NO_IMAGES) ? 0 : 1;
}

function settle(s: Search, ts: number | null): void {
	s.settled = true;
	s.ts = ts;
}

/** Interior cuts for the round, ordered. Empty only when the window is already at its
 *  floor, which the caller has ruled out. */
function cutsFor(s: Search): number[] {
	const range = s.hi - s.lo;
	const cuts: number[] = [];
	for (let k = 1; k <= BRANCH; k++) {
		const c = s.lo + Math.floor((range * k) / (BRANCH + 1));
		if (c > s.lo && c < s.hi && c !== cuts[cuts.length - 1]) cuts.push(c);
	}
	if (cuts.length === 0) cuts.push(s.lo + Math.floor(range / 2));
	return cuts;
}

/** Narrow to the bracket this round's answers name, and settle the row once the window
 *  is down to ACCURACY. Answers are read in cut order, so the first true ends the scan
 *  exactly as a serial probe sequence would have. */
function absorb(s: Search, results: number[]): void {
	let hit = -1;
	for (let j = 0; j < results.length; j++) {
		if (results[j] < 0) {
			settle(s, null);
			return;
		}
		if (results[j] === 1) {
			hit = j;
			break;
		}
	}
	if (hit < 0) {
		s.lo = s.cuts[s.cuts.length - 1];
	} else {
		s.hi = s.cuts[hit];
		if (hit > 0) s.lo = s.cuts[hit - 1];
	}
	if (s.hi - s.lo > ACCURACY) return;
	const mid = s.lo + Math.floor((s.hi - s.lo) / 2);
	// Landing on the window end means the default pano never moved: not a result.
	settle(s, s.hiInit - mid <= 1 ? null : mid);
}

/** Drive every search to a verdict as one wavefront. Invariant per live row: an image
 *  exists in (lo, hi]. probe(lo, c) is monotone in c, so a round's results are a prefix
 *  of falses then trues.
 *
 *  Every window is the same size, so every surviving row needs the same number of rounds
 *  and they would all finish in the same instant. Progress therefore credits partial work
 *  per round -- a live row `r` rounds into an estimated `est` counts as r/est of a row --
 *  which is what makes the bar ramp instead of cliff. */
function narrow(batch: Search[], counts = true): void {
	if (batch.length === 0 || mma.aborted()) return;

	const range = Math.max(...batch.map((s) => s.hi - s.lo), ACCURACY + 1);
	const est = Math.max(1, Math.ceil(Math.log(range / ACCURACY) / Math.log(BRANCH + 1)));
	let reported = 0;
	const report = (round: number) => {
		const settled = batch.reduce((n, s) => n + (s.settled ? 1 : 0), 0);
		const partial = ((batch.length - settled) * Math.min(round, est - 1)) / est;
		const target = Math.floor(settled + partial);
		if (counts && target > reported) {
			mma.progress(target - reported);
			reported = target;
		}
	};

	// One query over each whole window first: a pano that is not a candidate at all
	// costs one request instead of twenty.
	const seed = mma.fetchMany(
		batch.map((s) => timestampSearchRequest(s.lat, s.lng, SV_SEARCH_RADIUS, s.lo, s.hi)),
	);
	batch.forEach((s, i) => {
		if (verdict(seed[i]) !== 1) settle(s, null);
	});
	report(0);

	let round = 0;
	while (!mma.aborted()) {
		const live = batch.filter((s) => !s.settled);
		if (live.length === 0) break;

		const reqs: ProcedureRequest[] = [];
		for (const s of live) {
			s.cuts = cutsFor(s);
			for (const c of s.cuts) reqs.push(timestampSearchRequest(s.lat, s.lng, SV_SEARCH_RADIUS, s.lo, c));
		}
		const res = mma.fetchMany(reqs);

		let at = 0;
		for (const s of live) {
			const results: number[] = [];
			for (let j = 0; j < s.cuts.length; j++) results.push(verdict(res[at++]));
			absorb(s, results);
		}
		report(++round);
	}
}

export function run(rows: Location[]): Update<LocationPatch>[] {
	const batch: Search[] = [];
	for (const row of rows) {
		const s = newSearch(row.id, row.lat, row.lng, row.extra?.imageDate);
		if (!s) {
			mma.fail(row.id);
			mma.progress(1);
			continue;
		}
		batch.push(s);
	}
	narrow(batch);

	const out: Update<LocationPatch>[] = [];
	for (const s of batch) {
		// A row cut short by an abort is neither a result nor a failure; beyond any
		// partial credit already reported, the engine counts it as untouched.
		if (!s.settled) continue;
		if (s.ts !== null) out.push({ id: s.id, patch: { extra: { datetime: s.ts } } });
		else mma.fail(s.id);
	}
	return out;
}

/** `{op: "resolve", lat, lng, imageDate}` -> the capture time in unix seconds, or null
 *  when the point is not a candidate in that month. */
export function query(input: {
	op: string;
	lat: number;
	lng: number;
	imageDate: string;
}): number | null {
	if (input.op !== "resolve") throw new Error(`exactDate: unknown query op "${input.op}"`);
	const s = newSearch(0, input.lat, input.lng, input.imageDate);
	if (!s) throw new Error(`exactDate: bad imageDate "${input.imageDate}"`);
	narrow([s], false);
	return s.ts;
}
