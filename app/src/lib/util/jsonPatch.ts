import type { PatchOp } from "@/bindings.gen";

type Container = Record<string, unknown> | unknown[];

const isContainer = (value: unknown): value is Container =>
	typeof value === "object" && value !== null;

/** The reference tokens of a JSON Pointer (RFC 6901). */
function tokens(pointer: string): string[] {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) throw new Error(`not a JSON Pointer: ${pointer}`);
	return pointer
		.slice(1)
		.split("/")
		.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function index(token: string, end: number): number {
	if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) > end)
		throw new Error(`no array element ${token}`);
	return Number(token);
}

function has(parent: Container, token: string): boolean {
	return Array.isArray(parent)
		? /^(0|[1-9][0-9]*)$/.test(token) && Number(token) < parent.length
		: Object.hasOwn(parent, token);
}

function get(doc: unknown, path: string[]): unknown {
	return path.reduce((at, token) => {
		if (!isContainer(at) || !has(at, token)) throw new Error(`nothing at /${path.join("/")}`);
		return Array.isArray(at) ? at[Number(token)] : at[token];
	}, doc);
}

/** `doc` with the member `path` names rewritten by `edit`, copying only the containers on
 *  the way there, so everything else keeps its identity. */
function update(doc: unknown, path: string[], edit: (parent: Container, token: string) => void) {
	const [token, ...rest] = path;
	if (!isContainer(doc)) throw new Error(`nothing to hold /${path.join("/")}`);
	const copy: Container = Array.isArray(doc) ? [...doc] : { ...doc };
	if (rest.length === 0) edit(copy, token);
	else if (!has(copy, token)) throw new Error(`nothing at ${token}`);
	else if (Array.isArray(copy)) copy[Number(token)] = update(copy[Number(token)], rest, edit);
	else copy[token] = update(copy[token], rest, edit);
	return copy;
}

function add(doc: unknown, path: string[], value: unknown): unknown {
	if (path.length === 0) return value;
	return update(doc, path, (parent, token) => {
		if (!Array.isArray(parent)) parent[token] = value;
		else if (token === "-") parent.push(value);
		else parent.splice(index(token, parent.length), 0, value);
	});
}

function replace(doc: unknown, path: string[], value: unknown): unknown {
	if (path.length === 0) return value;
	return update(doc, path, (parent, token) => {
		if (!has(parent, token)) throw new Error(`nothing at /${path.join("/")}`);
		if (Array.isArray(parent)) parent[Number(token)] = value;
		else parent[token] = value;
	});
}

function remove(doc: unknown, path: string[]): unknown {
	if (path.length === 0) throw new Error("cannot remove the whole document");
	return update(doc, path, (parent, token) => {
		if (!has(parent, token)) throw new Error(`nothing at /${path.join("/")}`);
		if (Array.isArray(parent)) parent.splice(Number(token), 1);
		else delete parent[token];
	});
}

function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!isContainer(a) || !isContainer(b) || Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && equal(a[key as never], b[key as never]))
	);
}

function step(doc: unknown, op: PatchOp): unknown {
	const path = tokens(op.path);
	switch (op.op) {
		case "add":
			return add(doc, path, op.value);
		case "remove":
			return remove(doc, path);
		case "replace":
			return replace(doc, path, op.value);
		case "move": {
			const from = tokens(op.from);
			if (from.length < path.length && from.every((token, i) => token === path[i]))
				throw new Error(`cannot move ${op.from} into itself`);
			return add(remove(doc, from), path, get(doc, from));
		}
		case "copy":
			return add(doc, path, get(doc, tokens(op.from)));
		case "test":
			if (!equal(get(doc, path), op.value)) throw new Error(`test failed at ${op.path}`);
			return doc;
	}
}

/** `doc` with `patch` applied (RFC 6902). All or nothing: a failing operation throws and
 *  `doc` is left as it was. */
export function applyPatch<T>(doc: T, patch: PatchOp[]): T {
	return patch.reduce(step, doc) as T;
}

/** Whether `patch` changes anything at, under, or above `pointer`. */
export function touches(patch: PatchOp[], pointer: string): boolean {
	return patch.some(
		({ path }) =>
			path === pointer || path.startsWith(`${pointer}/`) || pointer.startsWith(`${path}/`),
	);
}
