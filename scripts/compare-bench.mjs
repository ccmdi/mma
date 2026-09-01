#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "app/test/perf/results");

const HELP = `compare-bench -- put two exactDate bench reports side by side.

  node scripts/compare-bench.mjs <baseline.json> <candidate.json>

Reports live in app/test/perf/results; names may be given bare.`;

function newest(match) {
	const files = fs
		.readdirSync(RESULTS)
		.filter((f) => f.startsWith("procedure-bench-") && f.includes(match))
		.sort();
	if (!files.length) throw new Error(`no bench report matching "${match}" in ${RESULTS}`);
	return path.join(RESULTS, files[files.length - 1]);
}

const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const ROWS = [
	["rows enriched", (r) => `${r.enrichedRows}/${r.rows}`],
	["duration ms", (r) => r.durationMs],
	["rows/s", (r) => r.rowsPerSecond],
	["requests", (r) => r.net.requests],
	["requests/row", (r) => r.requestsPerRow],
	["served mean", (r) => r.net.meanInflight],
	["served peak", (r) => r.net.peakInflight],
	["offered mean", (r) => r.net.meanOffered],
	["offered peak", (r) => r.net.peakOffered],
	["queue ms/req", (r) => r.net.meanQueueMs],
	["idle %", (r) => r.net.idlePct],
	["latency p50", (r) => r.net.p50Ms],
	["projected rows/s @day", (r) => r.projection.projectedRowsPerSecondAtDay],
];

function main() {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(HELP);
		return;
	}
	const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
	if (args.length < 2) {
		console.log(HELP);
		process.exitCode = 1;
		return;
	}
	const [oldPath, newPath] = args.map((a) => (path.isAbsolute(a) ? a : path.join(RESULTS, a)));
	const a = load(oldPath);
	const b = load(newPath);

	console.log(`baseline : ${path.basename(oldPath)}`);
	console.log(`candidate: ${path.basename(newPath)}\n`);
	console.log(`${"".padEnd(22)}${"baseline".padStart(12)}${"candidate".padStart(12)}${"delta".padStart(12)}`);
	for (const [label, get] of ROWS) {
		const av = get(a);
		const bv = get(b);
		let delta = "";
		if (typeof av === "number" && typeof bv === "number" && av !== 0) {
			const pct = ((bv - av) / av) * 100;
			delta = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
		}
		console.log(
			`${label.padEnd(22)}${String(av).padStart(12)}${String(bv).padStart(12)}${delta.padStart(12)}`,
		);
	}
	const aDates = a.rowDates ?? {};
	const bDates = b.rowDates ?? {};
	const shared = Object.keys(aDates).filter((k) => k in bDates);
	if (shared.length) {
		const day = (t) => Math.floor(t / 86400);
		const sameDay = shared.filter((k) => day(aDates[k]) === day(bDates[k])).length;
		const drift = shared.map((k) => Math.abs(aDates[k] - bDates[k]));
		const meanDrift = Math.round(drift.reduce((x, y) => x + y, 0) / drift.length);
		console.log(
			`\nresolved values: ${shared.length} shared rows, ` +
				`${sameDay} on the same calendar day (${((sameDay / shared.length) * 100).toFixed(1)}%), ` +
				`mean |drift| ${meanDrift}s, max ${Math.max(...drift)}s`,
		);
	}

	console.log(
		`\nserved/offered: baseline ${(a.net.meanInflight / (a.net.meanOffered || 1)).toFixed(2)}, ` +
			`candidate ${(b.net.meanInflight / (b.net.meanOffered || 1)).toFixed(2)} ` +
			`(1.00 = every request the engine offered was being served; lower = queueing)`,
	);
}

main();
