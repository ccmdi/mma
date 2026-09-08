// Packs the offline reverse-geocoding dataset into app/src-tauri/data/cities.bin.
// Source: the GeoNames cities1000 extract shipped by the `reverse_geocoder` crate
// (lat,lon,name,admin1,admin2,cc; CC BY 4.0 -- attribution in data/README.md).
// Usage: node scripts/gen-cities-bin.mjs <path-to-cities.csv>
//
// Layout (little-endian). Points are unit-sphere vectors in implicit kd-tree order
// (children of node i at 2i+1/2i+2, splitting axis cycles x, y, z with depth).
//
//   magic "MMAC" u32 | version u32 | count u32 | reserved u32
//   names_at u32 | admins_at u32 | admin_count u32 | reserved u32      (32B header)
//   points      count * 20B         -- x,y,z f32 (unit sphere), name u32, admin u16, cc [u8;2]
//   name pool   [u8 len][utf8]...   -- point.name is a byte offset to the length
//   admin index (admin_count + 1) * u32, then the admin1 utf8 bytes

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "app", "src-tauri", "data", "cities.bin");

const csvPath = process.argv[2];
if (!csvPath) {
	console.error("usage: node scripts/gen-cities-bin.mjs <path-to-cities.csv>");
	process.exit(1);
}

const lines = readFileSync(csvPath, "utf8").split("\n");
const header = lines[0].trim();
if (header !== "lat,lon,name,admin1,admin2,cc") throw new Error(`unexpected header: ${header}`);

// RFC4180: some rows carry quoted fields containing commas.
function fields(line) {
	const out = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch !== '"') cur += ch;
			else if (line[i + 1] === '"') (cur += '"'), i++;
			else quoted = false;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") (out.push(cur), (cur = ""));
		else cur += ch;
	}
	out.push(cur);
	return out;
}

const rows = [];
for (let i = 1; i < lines.length; i++) {
	const line = lines[i].trim();
	if (!line) continue;
	const f = fields(line);
	if (f.length !== 6) throw new Error(`row ${i}: expected 6 fields, got ${f.length}`);
	rows.push({ lat: Number(f[0]), lng: Number(f[1]), name: f[2], admin1: f[3], cc: f[5] });
}

for (const r of rows) {
	const latR = (r.lat * Math.PI) / 180;
	const lngR = (r.lng * Math.PI) / 180;
	r.v = [Math.cos(latR) * Math.cos(lngR), Math.cos(latR) * Math.sin(lngR), Math.sin(latR)];
}

/** Nodes in the left subtree of a complete binary tree holding `n` nodes. */
function leftCount(n) {
	if (n <= 1) return 0;
	const h = Math.floor(Math.log2(n));
	const lastLevel = n - (2 ** h - 1);
	return 2 ** (h - 1) - 1 + Math.min(lastLevel, 2 ** (h - 1));
}

/** Partition `src[lo..hi)` about its k-th smallest on `axis` (Hoare quickselect). */
function selectNth(src, lo, hi, k, axis) {
	while (hi - lo > 1) {
		const pivot = src[(lo + hi) >> 1].v[axis];
		let i = lo;
		let j = hi - 1;
		while (i <= j) {
			while (src[i].v[axis] < pivot) i++;
			while (src[j].v[axis] > pivot) j--;
			if (i <= j) ([src[i], src[j]] = [src[j], src[i]]), i++, j--;
		}
		if (k <= j) hi = j + 1;
		else if (k >= i) lo = i;
		else return;
	}
}

const tree = new Array(rows.length);
(function build(lo, hi, node, depth) {
	const n = hi - lo;
	if (n <= 0) return;
	const mid = lo + leftCount(n);
	const axis = depth % 3;
	selectNth(rows, lo, hi, mid, axis);
	tree[node] = rows[mid];
	build(lo, mid, 2 * node + 1, depth + 1);
	build(mid + 1, hi, 2 * node + 2, depth + 1);
})(0, rows.length, 0, 0);
if (tree.some((t) => t === undefined)) throw new Error("kd-tree layout left a hole");

const admins = [...new Set(rows.map((r) => r.admin1))].sort();
const adminId = new Map(admins.map((a, i) => [a, i]));
if (admins.length > 0xffff) throw new Error("admin1 count exceeds u16");

const nameBufs = [];
const nameOffset = new Map();
let namesLen = 0;
for (const r of rows) {
	if (nameOffset.has(r.name)) continue;
	const b = Buffer.from(r.name, "utf8");
	if (b.length > 255) throw new Error(`name too long: ${r.name}`);
	nameOffset.set(r.name, namesLen);
	nameBufs.push(Buffer.from([b.length]), b);
	namesLen += 1 + b.length;
}
const namePool = Buffer.concat(nameBufs);

const adminBufs = admins.map((a) => Buffer.from(a, "utf8"));
const adminBytes = Buffer.concat(adminBufs);
const adminIndex = Buffer.alloc((admins.length + 1) * 4);
let acc = 0;
for (let i = 0; i < admins.length; i++) {
	adminIndex.writeUInt32LE(acc, i * 4);
	acc += adminBufs[i].length;
}
adminIndex.writeUInt32LE(acc, admins.length * 4);

const points = Buffer.alloc(tree.length * 20);
for (let i = 0; i < tree.length; i++) {
	const r = tree[i];
	const at = i * 20;
	points.writeFloatLE(r.v[0], at);
	points.writeFloatLE(r.v[1], at + 4);
	points.writeFloatLE(r.v[2], at + 8);
	points.writeUInt32LE(nameOffset.get(r.name), at + 12);
	points.writeUInt16LE(adminId.get(r.admin1), at + 16);
	points.write(r.cc, at + 18, 2, "latin1");
}

const headerBuf = Buffer.alloc(32);
headerBuf.write("MMAC", 0, 4, "latin1");
headerBuf.writeUInt32LE(3, 4);
headerBuf.writeUInt32LE(rows.length, 8);
const namesAt = 32 + points.length;
headerBuf.writeUInt32LE(namesAt, 16);
headerBuf.writeUInt32LE(namesAt + namePool.length, 20);
headerBuf.writeUInt32LE(admins.length, 24);

const out = Buffer.concat([headerBuf, points, namePool, adminIndex, adminBytes]);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log(
	`cities.bin: ${rows.length.toLocaleString()} rows, ${admins.length.toLocaleString()} admin1, ` +
		`${nameOffset.size.toLocaleString()} distinct names, ${out.length.toLocaleString()} bytes`,
);
