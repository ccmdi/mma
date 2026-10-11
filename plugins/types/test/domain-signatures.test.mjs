import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as native from "../../../app/scripts/native-ts.mjs";

const probe = fileURLToPath(new URL("../.domain-signatures.ts", import.meta.url));
const text = `
import type { MMA, Location, Tag, History, Mutation } from "./mma";
declare const mma: MMA;
declare const location: Location;
declare const tag: Tag;
declare const history: History;
declare const mutation: Mutation<Location>;
const locationId: number = location.id;
const tagId: number = tag.id;
const canUndo: boolean = history.undo;
const version: number = mutation.version;
const counted: Promise<number> = mma.Query.read({ type: "Everything" }, { kind: "count" });
const opening: Promise<void> = mma.Maps.open("map-id");
const editing: Promise<void> = mma.Editor.open(42);
const names = mma.Tag.names;
const named: string[] = names([1, 2]);
const removed: Promise<void> = mma.Field.remove("extra");
const count: number | undefined = mma.Tag.get(1)?.id;
const oldEdit: typeof mma.Edit = mma.edit;
const oldAutosave: typeof mma.Autosave = mma.autosave;
const oldAdd: typeof mma.Location.add = mma.addLocations;
const oldRead: typeof mma.Store.get = mma.getMapState;
const snapshot = mma.Store.get();
// @ts-expect-error Internal state patches are not exposed to plugins.
mma.Store.patch({});
// @ts-expect-error Internal derived merges are not exposed to plugins.
mma.Store.merge({});
// @ts-expect-error Internal resets are not exposed to plugins.
mma.Store.resetDerived();
const oldOpen: typeof mma.Editor.open = mma.openLocation;
// @ts-expect-error Map identity is a string, distinct from a location id.
mma.Maps.open(42);
// @ts-expect-error Editor identity is a location or a numeric id.
mma.Editor.open("map-id");
// @ts-expect-error Tag ids must be numbers.
mma.Tag.names(["1"]);
// @ts-expect-error Tag lookups return records, not strings or any.
const invalid: string = mma.Tag.get(1);
`;

test("generated objects keep distinct signatures, callback types and flat compatibility calls", () => {
 native.withProgram([probe], { noEmit: true, strict: true, skipLibCheck: false, types: [], module: "esnext", target: "esnext", moduleResolution: "bundler" }, ({ program }) => {
  const errors = program.getSemanticDiagnostics();
  assert.deepEqual(errors, []);
 }, new Map([[probe, text]]));
});
