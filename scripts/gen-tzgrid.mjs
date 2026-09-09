// Packs @photostructure/tz-lookup's coordinate->IANA-zone quadtree into
// app/src-tauri/data/tzgrid.bin, and writes an oracle fixture answered by the JS itself.
// Usage: node scripts/gen-tzgrid.mjs  (reads app/node_modules; tz-lookup is a devDependency)
//
// Layout (little-endian):
//   header 16B: magic "TZGR" | version u32 | zone_count u32 | tree_len u32
//   names_idx  (zone_count + 1) * u32 offsets into the name pool
//   names      utf8 pool
//   tree       tree_len bytes (the decoder's char codes, all ASCII)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "app", "package.json"));
const tzPath = require.resolve("@photostructure/tz-lookup");
const tzlookup = require("@photostructure/tz-lookup");
const src = readFileSync(tzPath, "utf8");

const treeMatch = src.match(/var X="([^"]+)"/);
const namesMatch = src.match(/[,;]T=(\[[^\]]+\])/);
if (!treeMatch || !namesMatch) throw new Error("tz.js shape changed; update the extractor");
const tree = treeMatch[1];
const names = JSON.parse(namesMatch[1]);
for (let i = 0; i < tree.length; i++) {
	const c = tree.charCodeAt(i);
	if (c < 35 || c > 127) throw new Error(`non-ASCII tree byte ${c} at ${i}`);
}

const enc = new TextEncoder();
const namePool = [];
const namesIdx = [0];
let off = 0;
for (const n of names) {
	const b = enc.encode(n);
	namePool.push(b);
	off += b.length;
	namesIdx.push(off);
}
const header = Buffer.alloc(16);
header.write("TZGR", 0, "ascii");
header.writeUInt32LE(1, 4);
header.writeUInt32LE(names.length, 8);
header.writeUInt32LE(tree.length, 12);
const idxBuf = Buffer.alloc(namesIdx.length * 4);
namesIdx.forEach((v, i) => idxBuf.writeUInt32LE(v, i * 4));
const out = Buffer.concat([header, idxBuf, ...namePool, Buffer.from(tree, "ascii")]);
const outFile = join(here, "..", "app", "src-tauri", "data", "tzgrid.bin");
writeFileSync(outFile, out);

// Fixture: seeded uniform coordinates plus grid-boundary probes, answered by the JS.
function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(0x51ab);
const cases = [];
for (let i = 0; i < 5000; i++) cases.push([rand() * 180 - 90, rand() * 360 - 180]);
for (const lat of [-90, -89.9999, 0, 45, 89.9999, 90]) {
	for (const lng of [-180, -179.9999, -90, 0, 90, 179.9999, 180]) {
		cases.push([lat, lng]);
	}
}
// Cell-edge probes: the root grid is 48x24, children split by powers of two.
for (let i = 0; i <= 48; i++) cases.push([12.3456, -180 + (i * 360) / 48]);
for (let i = 0; i <= 24; i++) cases.push([-90 + (i * 180) / 24, 45.6789]);

const zoneId = new Map(names.map((n, i) => [n, i]));
const fix = Buffer.alloc(cases.length * 18);
cases.forEach(([lat, lng], i) => {
	fix.writeDoubleLE(lat, i * 18);
	fix.writeDoubleLE(lng, i * 18 + 8);
	const zone = tzlookup(lat, lng);
	const id = zoneId.get(zone);
	if (id === undefined) throw new Error(`fixture zone not in table: ${zone}`);
	fix.writeUInt16LE(id, i * 18 + 16);
});
const fixFile = join(here, "..", "app", "src-tauri", "crates", "tz", "testdata", "tzgrid-fixture.bin");
writeFileSync(fixFile, fix);
console.log(
	`tzgrid.bin: ${out.length} bytes (${names.length} zones, tree ${tree.length}); fixture: ${cases.length} cases`,
);
