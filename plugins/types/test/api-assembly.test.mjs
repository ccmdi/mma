import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import generator from "../generate.js";
import * as native from "../../../app/scripts/native-ts.mjs";

async function assemble(files) {
 const src = mkdtempSync(join(tmpdir(), "mma-api-"));
 try {
 for (const [file, text] of Object.entries(files)) {
 mkdirSync(dirname(join(src, file)), { recursive: true });
 writeFileSync(join(src, file), text);
 }
 return await generator.assembleApi(native, src);
 } finally {
 rmSync(src, { recursive: true, force: true });
 }
}

test("only tagged exports reach MMA, each under its own name", async () => {
 const api = await assemble({
 "store/tag.ts": "/** Tags. @api */\nexport const Tag = { all: () => [] };\nexport function rename() {}\n",
 "lib/util.ts": "/** Chunks. @api @unstable */\nexport function chunk() {}\n",
 });
 assert.match(api, /import \{ Tag \} from "@\/store\/tag";/);
 assert.match(api, /type UtilApi = \{\s*(?:\/\*\*.*\*\/\s*)?chunk: typeof chunk;\s*\};/);
 assert.doesNotMatch(api, /rename/);
});

test("a member restates its declaration's doc, less the @api tag", async () => {
 const api = await assemble({
 "lib/util.ts": "/** Split into chunks. @api @unstable */\nexport function chunk() {}\n/** @api */\nexport function bare() {}\n",
 });
 assert.match(api, /\/\*\* Split into chunks\. @unstable \*\/\s*chunk: typeof chunk;/);
 assert.match(api, /\{\s*bare: typeof bare;/);
 assert.doesNotMatch(api, /@api \*\/|@api @/);
});

test("a tagged type is exported beside MMA", async () => {
 const api = await assemble({
 "lib/shape.ts": "/** @api */\nexport type Shape = { a: number };\nexport type Hidden = number;\n/** @api */\nexport function shape() {}\n",
 });
 assert.match(api, /export type \{ Shape \} from "@\/lib\/shape";/);
 assert.doesNotMatch(api, /Hidden/);
});

test("a section is its file's name, an index takes its folder's, and a shared name takes folders", async () => {
 const api = await assemble({
 "store/query.ts": "/** @api */\nexport const Query = {};\n",
 "lib/sv/query.ts": "/** @api */\nexport function panosAt() {}\n",
 "types/index.ts": "/** @api */\nexport function createLocation() {}\n",
 });
 assert.match(api, /type Store_QueryApi = \{\s*(?:\/\*\*.*\*\/\s*)?Query: typeof Query;?\s*\};/);
 assert.match(api, /type Sv_QueryApi = \{\s*(?:\/\*\*.*\*\/\s*)?panosAt: typeof panosAt;?\s*\};/);
 assert.match(api, /type TypesApi = \{\s*(?:\/\*\*.*\*\/\s*)?createLocation: typeof createLocation;?\s*\};/);
});

test("two modules putting one name on MMA fail the build", async () => {
 await assert.rejects(
 assemble({
 "a.ts": "/** @api */\nexport function open() {}\n",
 "b.ts": "/** @api */\nexport function open() {}\n",
 }),
 /open is declared by both a and b/,
 );
});

test("the first declaration in a file restates only its own doc, not the comments above it", async () => {
 const api = await assemble({
 "lib/first.ts": "// A file header.\n// Its second line.\n\n/** @api */\nexport const Zed = {};\n/** Alpha. @api */\nexport const Alpha = {};\n",
 });
 assert.doesNotMatch(api, /file header|second line/);
 assert.match(api, /\{\s*\/\*\* Alpha\. \*\/\n\tAlpha: typeof Alpha;\n\tZed: typeof Zed;/);
});
