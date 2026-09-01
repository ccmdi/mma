#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "app/test/perf/results");

const HELP = `compare-parity -- diff a v0.9.2 dump against a current one, row by row.

  node scripts/compare-parity.mjs [old.json] [new.json]

Defaults to app/test/perf/results/parity-v092.json and parity-head.json, which is what
test/e2e/procedure-parity.test.ts writes. Every field of every row is compared; a
difference is either on the intended list below (printed as ACCEPTED) or it is a
divergence nobody signed off on, and the exit code is 1.`;

/**
 * Divergences we chose. Each rule names the fields and row kinds it covers and why;
 * anything it does not cover fails the comparison by definition.
 */
const INTENDED = [
	{
		id: "dead-pano-fails",
		why: "a dead or missing pano now fails the row instead of booking it as a success",
		kinds: ["dead-pano", "dead-pano-pinned", "no-coverage"],
		fields: "*",
	},
	{
		id: "failed-reresolve-unpinned",
		why: "a failed re-resolve leaves the row unpinned rather than pinning the stale pano",
		kinds: ["dead-pano-pinned"],
		fields: ["panoId", "flags"],
	},
	{
		id: "capture-date-off-by-one",
		why: "the capture-date off-by-one fix moves datetime/imageDate by up to a month",
		kinds: "*",
		fields: ["datetime", "imageDate"],
	},
	{
		id: "progress-semantics",
		why: "provider ids and per-provider success/failure counts are reported differently",
		kinds: "*",
		fields: ["__outcomes"],
	},
];

const covers = (rule, kind, field) =>
	(rule.kinds === "*" || rule.kinds.includes(kind)) &&
	(rule.fields === "*" || rule.fields.includes(field));

function load(p) {
	const full = path.isAbsolute(p) ? p : path.join(RESULTS, p);
	if (!fs.existsSync(full)) throw new Error(`no dump at ${full}`);
	return JSON.parse(fs.readFileSync(full, "utf8"));
}

function rowMap(dump) {
	const m = new Map();
	for (const r of dump.rows) m.set(r.key, r);
	return m;
}

const norm = (v) => (v === undefined ? null : v);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

function fieldsOf(row) {
	return [
		...["panoId", "flags", "heading"],
		...Object.keys(row.extra ?? {}).map((k) => `extra.${k}`),
	];
}

function read(row, field) {
	if (field.startsWith("extra.")) return (row.extra ?? {})[field.slice(6)];
	return row[field];
}

function main() {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(HELP);
		return;
	}
	const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
	const oldDump = load(args[0] ?? "parity-v092.json");
	const newDump = load(args[1] ?? "parity-head.json");

	const oldRows = rowMap(oldDump);
	const newRows = rowMap(newDump);
	const keys = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort();

	const kinds = new Map();
	for (const r of [...oldDump.rows, ...newDump.rows]) kinds.set(r.key, r.kind ?? "unknown");

	const accepted = [];
	const divergences = [];

	for (const k of keys) {
		const a = oldRows.get(k);
		const b = newRows.get(k);
		const kind = kinds.get(k) ?? "unknown";
		if (!a || !b) {
			divergences.push({ key: k, kind, field: "__row", old: !!a, new: !!b });
			continue;
		}
		const fields = [...new Set([...fieldsOf(a), ...fieldsOf(b)])];
		for (const f of fields) {
			const av = read(a, f);
			const bv = read(b, f);
			if (same(av, bv)) continue;
			const bare = f.startsWith("extra.") ? f.slice(6) : f;
			const rule = INTENDED.find((r) => covers(r, kind, bare));
			(rule ? accepted : divergences).push({
				key: k,
				kind,
				field: f,
				old: norm(av),
				new: norm(bv),
				rule: rule?.id,
			});
		}
	}

	const outcomeRule = INTENDED.find((r) => covers(r, "*", "__outcomes"));
	const outcomesDiffer =
		JSON.stringify(oldDump.outcomes) !== JSON.stringify(newDump.outcomes);
	if (outcomesDiffer) {
		(outcomeRule ? accepted : divergences).push({
			key: "-",
			kind: "-",
			field: "__outcomes",
			old: oldDump.outcomes,
			new: newDump.outcomes,
			rule: outcomeRule?.id,
		});
	}

	const line = (d) =>
		`  ${String(d.kind).padEnd(20)} ${String(d.field).padEnd(22)} ${JSON.stringify(d.old)} -> ${JSON.stringify(d.new)}`;

	console.log(`rows: ${oldRows.size} (v0.9.2) vs ${newRows.size} (current)\n`);
	console.log(`ACCEPTED (${accepted.length}) -- differences we chose:`);
	for (const r of INTENDED) {
		const hits = accepted.filter((d) => d.rule === r.id);
		if (!hits.length) continue;
		console.log(`\n [${r.id}] ${r.why}`);
		for (const d of hits) console.log(line(d));
	}

	console.log(`\nDIVERGENCES (${divergences.length}) -- nobody signed off on these:`);
	for (const d of divergences) console.log(line(d));

	if (divergences.length) {
		console.log(`\nFAIL: ${divergences.length} unexplained difference(s).`);
		process.exitCode = 1;
	} else {
		console.log("\nPASS: every difference is on the intended list.");
	}
}

main();
