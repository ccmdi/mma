// Packs the offline reverse-geocoding dataset into app/src-tauri/data/cities.bin.
// Source: the GeoNames cities1000 extract shipped by the `reverse_geocoder` crate
// (lat,lon,name,admin1,admin2,cc; CC BY 4.0 -- attribution in data/README.md).
// Usage: node scripts/gen-cities-bin.mjs <path-to-cities.csv>
//
// Layout (little-endian). Points are unit-sphere vectors in implicit kd-tree order
// (children of node i at 2i+1/2i+2, splitting axis cycles x, y, z with depth). Names are
// front-coded in sorted order with a restart every NAME_BLOCK entries.
//
//   header 48B: magic "MMAC" | version | count | admin_count | cc_count
//               xyz_at | payload_at | names_at | admins_at | ccs_at | 2 reserved
//   xyz       count * 12B    -- f32 x, y, z on the unit sphere
//   payload   count * 6B     -- name u24, admin u16, cc u8 (parallel to xyz)
//   names     restart u32 count, (restarts + 1) * u32 offsets, then front-coded entries:
//             shared u8, suffix_len u8, suffix bytes
//   admins    (admin_count + 1) * u32 offsets, then the admin1 utf8 bytes
//   ccs       cc_count * 2B  -- ISO 3166-1 alpha-2, fixed width

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

const NAME_BLOCK = 16;

const admins = [...new Set(rows.map((r) => r.admin1))].sort();
const adminId = new Map(admins.map((a, i) => [a, i]));
if (admins.length > 0xffff) throw new Error("admin1 count exceeds u16");

const ccs = [...new Set(rows.map((r) => r.cc))].sort();
const ccId = new Map(ccs.map((c, i) => [c, i]));
if (ccs.length > 0xff) throw new Error("country count exceeds u8");

const names = [...new Set(rows.map((r) => r.name))].sort();
const nameId = new Map(names.map((n, i) => [n, i]));
if (names.length > 0xffffff) throw new Error("name count exceeds u24");

const restarts = [];
const nameChunks = [];
let namesLen = 0;
let prev = Buffer.alloc(0);
names.forEach((n, i) => {
	const b = Buffer.from(n, "utf8");
	if (b.length > 255) throw new Error(`name too long: ${n}`);
	let shared = 0;
	if (i % NAME_BLOCK === 0) restarts.push(namesLen);
	else while (shared < Math.min(b.length, prev.length, 255) && b[shared] === prev[shared]) shared++;
	nameChunks.push(Buffer.from([shared, b.length - shared]), b.subarray(shared));
	namesLen += 2 + b.length - shared;
	prev = b;
});
const nameIndex = Buffer.alloc(4 + (restarts.length + 1) * 4);
nameIndex.writeUInt32LE(restarts.length, 0);
restarts.forEach((off, i) => nameIndex.writeUInt32LE(off, 4 + i * 4));
nameIndex.writeUInt32LE(namesLen, 4 + restarts.length * 4);
const namePool = Buffer.concat([nameIndex, ...nameChunks]);

const adminBufs = admins.map((a) => Buffer.from(a, "utf8"));
const adminBytes = Buffer.concat(adminBufs);
const adminIndex = Buffer.alloc((admins.length + 1) * 4);
let acc = 0;
for (let i = 0; i < admins.length; i++) {
	adminIndex.writeUInt32LE(acc, i * 4);
	acc += adminBufs[i].length;
}
adminIndex.writeUInt32LE(acc, admins.length * 4);
const adminPool = Buffer.concat([adminIndex, adminBytes]);

const ccPool = Buffer.alloc(ccs.length * 2);
ccs.forEach((c, i) => ccPool.write(c, i * 2, 2, "latin1"));

const xyz = Buffer.alloc(tree.length * 12);
const payload = Buffer.alloc(tree.length * 6);
for (let i = 0; i < tree.length; i++) {
	const r = tree[i];
	xyz.writeFloatLE(r.v[0], i * 12);
	xyz.writeFloatLE(r.v[1], i * 12 + 4);
	xyz.writeFloatLE(r.v[2], i * 12 + 8);
	payload.writeUIntLE(nameId.get(r.name), i * 6, 3);
	payload.writeUInt16LE(adminId.get(r.admin1), i * 6 + 3);
	payload.writeUInt8(ccId.get(r.cc), i * 6 + 5);
}

const headerBuf = Buffer.alloc(48);
headerBuf.write("MMAC", 0, 4, "latin1");
headerBuf.writeUInt32LE(4, 4);
headerBuf.writeUInt32LE(tree.length, 8);
headerBuf.writeUInt32LE(admins.length, 12);
headerBuf.writeUInt32LE(ccs.length, 16);
const xyzAt = 48;
const payloadAt = xyzAt + xyz.length;
const namesAt = payloadAt + payload.length;
const adminsAt = namesAt + namePool.length;
const ccsAt = adminsAt + adminPool.length;
headerBuf.writeUInt32LE(xyzAt, 20);
headerBuf.writeUInt32LE(payloadAt, 24);
headerBuf.writeUInt32LE(namesAt, 28);
headerBuf.writeUInt32LE(adminsAt, 32);
headerBuf.writeUInt32LE(ccsAt, 36);

const out = Buffer.concat([headerBuf, xyz, payload, namePool, adminPool, ccPool]);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log(
	`cities.bin: ${rows.length.toLocaleString()} rows, ${names.length.toLocaleString()} names ` +
		`(${namePool.length.toLocaleString()} B front-coded), ${admins.length.toLocaleString()} admin1, ` +
		`${ccs.length} countries -> ${out.length.toLocaleString()} bytes`,
);
