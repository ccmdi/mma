import assert from "node:assert/strict";
import test from "node:test";
import generator from "../generate.js";
import * as native from "../../../app/scripts/native-ts.mjs";

const fixture = `
/** Move a tag to another name. */
declare function rename(ids: number[], name: string): Promise<void>;
/** Remove a tag from its locations. */
declare function remove(ids: number[]): Promise<void>;
declare const tag: { rename: typeof rename; remove: typeof remove };
declare const history: { undo(): Promise<void>; redo(): Promise<void> };
type HelpersApi = { helper(value: string): number };
type TagApi = {
 /** Manage tag records. */
 tag: typeof tag;
};
type Store_HistoryApi = { history: typeof history; ids: number[]; enabled: boolean };
export interface MMA extends HelpersApi, TagApi, Store_HistoryApi {}
`;

test("direct objects and two-method objects get individual signatures alongside plain helpers", async () => {
 const markdown = await generator.generateApiMarkdown(native, fixture, new Map());
 for (const name of ["helper", "tag.rename", "tag.remove", "history.undo", "history.redo", "ids", "enabled"]) assert.match(markdown, new RegExp(`^#{3,4} ${name.replaceAll(".", "\\.")}$`, "m"));
 assert.match(markdown, /tag\.rename\(ids: number\[\], name: string\): Promise<void>/);
 assert.match(markdown, /Move a tag to another name/);
 assert.doesNotMatch(markdown, /^#{3,4} ids\.(map|push|length)/m);
});

test("each section is titled by its module's file, with the folders that tell two apart", async () => {
 const markdown = await generator.generateApiMarkdown(native, fixture, new Map());
 for (const title of ["Helpers", "Tag", "Store / History"]) assert.match(markdown, new RegExp(`^## ${title}$`, "m"));
});

test("direct object stability and deprecation tags reach individual methods", async () => {
 const text = fixture.replace(" /** Manage tag records. */", " /** Manage tag records. @unstable */").replace("Remove a tag from its locations.", "Remove a tag from its locations. @deprecated Use assignment instead.");
 const markdown = await generator.generateApiMarkdown(native, text, new Map([["tag.rename", "0.12.0"]]));
 assert.match(markdown, /#### tag\.rename\n\n`unstable` · since 0\.12\.0/);
 assert.match(markdown, /tag\.remove[\s\S]*?`deprecated`/);
});

test("an unstable flat method does not stamp a same-named stable domain method", async () => {
 const text = `
 type InternalApi = {
 /** @unstable */
 all: () => void;
 };
 declare const tag: { all(): string[] };
 type TagApi = { tag: typeof tag };
 export interface MMA extends InternalApi, TagApi {}
 `;
 const stamped = generator.propagateUnstable(native, text);
 const markdown = await generator.generateApiMarkdown(native, stamped, new Map());
 assert.match(markdown, /#### tag\.all\n\n`stable`/);
 assert.match(markdown, /### all\n\n`unstable`/);
});

test("a member tagged @internal is left out of the plugin types", () => {
 const text = `
 declare const store: {
 /** Read the state. */
 get: () => number;
 /** Replace the state. @internal */
 patch: (value: number) => void;
 };
 type StoreApi = { store: typeof store };
 export interface MMA extends StoreApi {}
 `;
 const stripped = generator.stripInternal(native, text);
 assert.match(stripped, /get: \(\) => number;/);
 assert.doesNotMatch(stripped, /patch/);
});
