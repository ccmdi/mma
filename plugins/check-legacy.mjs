// The mirror of check-floors.mjs: that one catches a plugin reaching for an API newer
// than it claims to support, this one catches the app deleting an API that shipped
// plugins still call. Every member the MMA surface shipped stable in any release since
// the support floor must still exist today, and every exported type it shipped stable must
// still accept the shape it had then.
//
// Stable  -> a rename or removal needs a shim in app/src/legacy.ts.
// @unstable -> reachable and documented, but no guarantee; delete it freely.
//
// Run: node plugins/check-legacy.mjs
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// How far back the promise reaches: the first release whose mma.d.ts carries @unstable
// tags. Every release from here to HEAD is checked -- an API that shipped stable in any
// of them is a promise. Raising the floor ages out every older guarantee at once.
const SUPPORT_FLOOR = "0.10.3";

const pluginsDir = dirname(fileURLToPath(import.meta.url));
const typesDir = join(pluginsDir, "types");
const sdkDts = join(typesDir, "mma.d.ts");
// Resolution is by bare specifier, so any path inside types/ works.
const floorDts = join(typesDir, ".floor.d.ts");
const headDts = join(typesDir, ".head.d.ts");

if (!existsSync(join(typesDir, "node_modules"))) {
	console.log("[types] npm ci");
	execSync("npm ci", { cwd: typesDir, stdio: "inherit" });
}
const ts = createRequire(join(typesDir, "package.json"))("typescript");

const gitOk = (args) => {
	const r = spawnSync("git", args, { cwd: pluginsDir, encoding: "utf-8" });
	return r.status === 0 ? r.stdout.trim() : null;
};

const cmpVer = (a, b) => {
	const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
	for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
	return 0;
};

/** Release tags (vX.Y.Z) at or above the floor, oldest first. */
function supportedTags() {
	return (gitOk(["tag", "--list", "v*"]) || "")
		.split("\n")
		.filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
		.filter((t) => cmpVer(t.slice(1), SUPPORT_FLOOR) >= 0)
		.sort((a, b) => cmpVer(a.slice(1), b.slice(1)));
}

/** Every dotted member path on the `MMA` interface (`sidecar.request`), mapped to whether
 *  it is unstable. The tag inherits: one `@unstable` on `cmd` covers every command under
 *  it. Nested namespaces are plain object literals, so one level of recursion covers them;
 *  deeper would walk into data types (Location, MapMeta) that are not API surface. */
function surfaceOf(dtsPath) {
	const program = ts.createProgram([dtsPath], {
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(dtsPath);
	if (!source) throw new Error(`could not load ${dtsPath}`);

	let root = null;
	ts.forEachChild(source, (node) => {
		if (ts.isInterfaceDeclaration(node) && node.name.text === "MMA") root = node;
	});
	if (!root) throw new Error(`no MMA interface in ${dtsPath}`);

	const isUnstable = (sym) => sym.getJsDocTags(checker).some((t) => t.name === "unstable");

	// A whole surface can be tagged at its declaration (`@unstable type ReviewApi = ...`),
	// which covers everything it contributes. Per-member tags are for mixed modules.
	const fromUnstableSurface = new Set();
	for (const clause of root.heritageClauses ?? []) {
		for (const node of clause.types) {
			const alias = checker.getSymbolAtLocation(node.expression);
			if (!alias || !isUnstable(alias)) continue;
			for (const prop of checker.getPropertiesOfType(checker.getTypeAtLocation(node))) {
				fromUnstableSurface.add(prop.name);
			}
		}
	}

	const surface = new Map();
	const walk = (type, prefix, depth, inherited) => {
		for (const prop of checker.getPropertiesOfType(type)) {
			const path = prefix ? `${prefix}.${prop.name}` : prop.name;
			// Members spread from a module land as `name: typeof name`, which carries no
			// JSDoc of its own -- the tag is on what it points at.
			const target = checker.getTypeOfSymbolAtLocation(prop, root).getSymbol();
			const unstable =
				inherited ||
				fromUnstableSurface.has(path) ||
				isUnstable(prop) ||
				(!!target && isUnstable(target));
			surface.set(path, unstable);
			if (depth === 0) continue;
			const propType = checker.getTypeOfSymbolAtLocation(prop, root);
			if (
				propType.getCallSignatures().length === 0 &&
				checker.getPropertiesOfType(propType).length
			) {
				walk(propType, path, depth - 1, unstable);
			}
		}
	};
	walk(checker.getTypeAtLocation(root), "", 1, false);
	return surface;
}

/** Both copies of the SDK live in one program, so the two `declare global` blocks would
 *  collide, and a private class member would make two copies of one class nominally
 *  unrelated. Neither is plugin-visible surface. */
export const prepare = (text) =>
	text
		.replace(/^declare global \{[\s\S]*?^\}\n?/gm, "")
		.replace(/^\s*(private|protected)\s.*\n/gm, "");

const PROBE_OPTS = {
	noEmit: true,
	skipLibCheck: true,
	strict: true,
	// Parameter bivariance: a widened parameter is additive, and a narrowed one is already
	// caught where the type it narrowed to is compared.
	strictFunctionTypes: false,
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
};

/** Every exported declaration, with its unstable tag and how to name it in a type position. */
function exportedTypes(checker, source) {
	const mod = checker.getSymbolAtLocation(source);
	if (!mod) return [];
	const unstable = (sym) => sym.getJsDocTags(checker).some((t) => t.name === "unstable");
	const out = [];
	// `api.ts` names one alias per spread module (StoreApi, SettingsApi, ...). They are
	// how the surface is assembled, not something a plugin can write, so a member moving
	// between them is invisible to callers and must not read as a break.
	const machinery = (name) => /Api$/.test(name) && name !== "MMAApi";
	for (const exp of checker.getExportsOfModule(mod)) {
		if (machinery(exp.name)) continue;
		const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
		const decl = sym.declarations?.[0];
		if (!decl) continue;
		const asType = !!(
			sym.flags &
			(ts.SymbolFlags.Interface |
				ts.SymbolFlags.TypeAlias |
				ts.SymbolFlags.Class |
				ts.SymbolFlags.Enum)
		);
		const arity = asType ? (decl.typeParameters?.length ?? 0) : 0;
		const type = asType
			? checker.getDeclaredTypeOfSymbol(sym)
			: checker.getTypeOfSymbolAtLocation(sym, decl);
		// A generic signature cannot be related across two copies of the SDK (its indexed and
		// conditional types defer on the type parameter), so only its presence is checked.
		const opaque = (p) =>
			unstable(p) ||
			checker
				.getTypeOfSymbol(p)
				.getCallSignatures()
				.some((sig) => (sig.typeParameters ?? []).length > 0);
		const props = checker.getPropertiesOfType(type);
		out.push({
			name: exp.name,
			unstable: unstable(exp) || unstable(sym),
			callable: type.getCallSignatures().length > 0,
			// An array or tuple is compared by element, so appending to a const tuple is additive.
			elements: checker.isArrayLikeType(type),
			objectLike: !!(type.flags & ts.TypeFlags.Object),
			members: props.map((p) => p.name),
			promised: props.filter((p) => !unstable(p)).map((p) => p.name),
			skip: props.filter(opaque).map((p) => JSON.stringify(p.name)),
			ref: (ns) =>
				asType
					? `${ns}.${exp.name}${arity ? `<${Array(arity).fill("any").join(", ")}>` : ""}`
					: `typeof ${ns}.${exp.name}`,
		});
	}
	return out;
}

/** The last two links of a diagnostic chain name the member and the mismatch. */
const leaf = (d) => {
	const chain = [];
	for (let m = d.messageText; m; m = typeof m === "string" ? undefined : m.next?.[0]) {
		chain.push(typeof m === "string" ? m : m.messageText);
	}
	return chain.slice(-2).join(" ");
};

/** Compare the exported type surface of two SDK d.ts files, which must sit in one directory.
 *  Removed exports and removed members are found structurally; compatibility over the members
 *  both sides have is decided by the compiler, on a generated probe file of assignability
 *  assertions, so the rule is TypeScript's own and not a hand-rolled differ. Additions,
 *  optionalisation and widening pass; a narrowed member fails. `@unstable` members are
 *  excluded on both sides. */
export function compareTypes(oldPath, newPath) {
	const dir = dirname(newPath);
	const spec = (p) => `./${basename(p).replace(/\.(d\.)?ts$/, "")}`;
	const read = ts.createProgram([oldPath, newPath], PROBE_OPTS);
	const checker = read.getTypeChecker();
	const oldExports = exportedTypes(checker, read.getSourceFile(oldPath));
	const newExports = new Map(
		exportedTypes(checker, read.getSourceFile(newPath)).map((e) => [e.name, e]),
	);

	const missing = [];
	const broken = new Map();
	const lines = [
		`import type * as Old from "${spec(oldPath)}";`,
		`import type * as New from "${spec(newPath)}";`,
		"type Assert<A extends B, B> = A;",
	];
	const lineOwner = new Map();
	for (const e of oldExports) {
		if (e.unstable) continue;
		const now = newExports.get(e.name);
		if (!now) {
			missing.push(e.name);
			continue;
		}
		const removed = e.promised.filter((m) => !now.members.includes(m));
		if (removed.length) {
			// Recorded, then the assignability probe still runs: a member that kept its name
			// and changed shape is a break of its own, and reporting only the removals would
			// hide it until a plugin silently misbehaves.
			broken.set(e.name, `member(s) removed: ${removed.join(", ")}`);
		}
		const [o, n] = [e.ref("Old"), e.ref("New")];
		const skip = e.skip.length ? e.skip.join(" | ") : "never";
		lineOwner.set(lines.length, e.name);
		lines.push(
			e.elements
				? `type _${lines.length} = Assert<(${o})[number], (${n})[number]>;`
				: e.objectLike && !e.callable
					? `type _${lines.length} = Assert<Omit<${o}, ${skip}>, Pick<${n}, Extract<Exclude<keyof ${o}, ${skip}>, keyof ${n}>>>;`
					: `type _${lines.length} = Assert<${o}, ${n}>;`,
		);
	}

	const probePath = join(dir, ".probe.ts");
	try {
		writeFileSync(probePath, lines.join("\n"));
		const program = ts.createProgram([probePath], PROBE_OPTS);
		const source = program.getSourceFile(probePath);
		for (const d of program.getSemanticDiagnostics(source)) {
			const name = lineOwner.get(source.getLineAndCharacterOfPosition(d.start ?? 0).line);
			if (!name) continue;
			const prior = broken.get(name);
			// A removal is already recorded for this type; keep it and add the first shape
			// break beside it rather than letting either hide the other.
			if (!prior) broken.set(name, leaf(d));
			else if (!prior.includes(" | ")) broken.set(name, `${prior} | ${leaf(d)}`);
		}
	} finally {
		rmSync(probePath, { force: true });
	}
	return {
		missing,
		broken: [...broken].map(([name, message]) => ({ name, message })),
	};
}

function main() {
	const tags = supportedTags();
	if (!tags.length) {
		console.log(`Support floor v${SUPPORT_FLOOR} is unreleased -- nothing to compare against yet.`);
		return 0;
	}

	// Most releases do not touch the API, so their mma.d.ts blob is identical to the
	// previous tag's -- parse each distinct blob once, attributed to its oldest tag.
	const blobTags = new Map();
	for (const tag of tags) {
		const blob = gitOk(["rev-parse", `${tag}:plugins/types/mma.d.ts`]);
		if (blob && !blobTags.has(blob)) blobTags.set(blob, tag);
	}

	// A member is promised when any release in the window shipped it stable; `tag` is the
	// oldest release that did.
	const promised = new Map();
	const typeBreaks = new Map();
	let head;
	try {
		head = surfaceOf(sdkDts);
		writeFileSync(headDts, prepare(readFileSync(sdkDts, "utf-8")));
		for (const [blob, tag] of blobTags) {
			const text = spawnSync("git", ["show", blob], {
				cwd: pluginsDir,
				encoding: "utf-8",
			}).stdout;
			writeFileSync(floorDts, prepare(text));
			for (const [p, unstable] of surfaceOf(floorDts)) {
				const prev = promised.get(p);
				if (prev && !prev.unstable) continue;
				promised.set(p, { unstable, tag });
			}
			const { missing, broken } = compareTypes(floorDts, headDts);
			for (const name of missing) {
				if (!typeBreaks.has(name)) typeBreaks.set(name, { tag, message: "no longer exported" });
			}
			for (const { name, message } of broken) {
				if (!typeBreaks.has(name)) typeBreaks.set(name, { tag, message });
			}
		}
	} finally {
		rmSync(floorDts, { force: true });
		rmSync(headDts, { force: true });
	}

	const gone = [...promised.keys()].filter((p) => !head.has(p));
	// A removed namespace implies its members; reporting both is noise.
	const removed = gone.filter(
		(p) => !p.includes(".") || !gone.includes(p.slice(0, p.lastIndexOf("."))),
	);
	const broken = removed.filter((p) => !promised.get(p).unstable).sort();

	const stableCount = [...promised.values()].filter((v) => !v.unstable).length;
	console.log(
		`Support window ${tags[0]}..${tags[tags.length - 1]}: ${tags.length} release(s), ` +
			`${blobTags.size} distinct surface(s), ${promised.size} members (${promised.size - stableCount} unstable), ` +
			`${head.size} today, ${removed.length} removed, ${typeBreaks.size} type break(s).`,
	);

	if (broken.length) {
		console.error(
			`\nFAIL: ${broken.length} stable API member(s) shipped plugins can still call were removed:\n` +
				broken.map((p) => `  MMA.${p} (stable since ${promised.get(p).tag})`).join("\n") +
				`\n\nAdd a shim in app/src/legacy.ts, or mark it @unstable before removing it.`,
		);
	}
	if (typeBreaks.size) {
		console.error(
			`\nFAIL: ${typeBreaks.size} stable exported type(s) shipped plugins compile against changed incompatibly:\n` +
				[...typeBreaks]
					.sort()
					.map(([name, b]) => `  ${name} (stable since ${b.tag}): ${b.message}`)
					.join("\n") +
				`\n\nKeep the old shape, or mark the declaration @unstable before changing it.`,
		);
	}
	if (broken.length || typeBreaks.size) return 1;
	console.log("ok");
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exit(main());
}
