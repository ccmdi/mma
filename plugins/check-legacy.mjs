// The mirror of check-floors.mjs: that one catches a plugin reaching for an API newer
// than it claims to support, this one catches the app deleting an API that shipped
// plugins still call. Every member the MMA surface shipped stable in any release since
// the support floor must still exist today.
//
// Stable  -> a rename or removal needs a shim in app/src/legacy.ts.
// @unstable -> reachable and documented, but no guarantee; delete it freely.
//
// Run: node plugins/check-legacy.mjs
import { execSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// How far back the promise reaches: the first release whose mma.d.ts carries @unstable
// tags. Every release from here to HEAD is checked -- an API that shipped stable in any
// of them is a promise. Raising the floor ages out every older guarantee at once.
const SUPPORT_FLOOR = "0.10.2";

const pluginsDir = dirname(fileURLToPath(import.meta.url));
const typesDir = join(pluginsDir, "types");
const sdkDts = join(typesDir, "mma.d.ts");
// Resolution is by bare specifier, so any path inside types/ works.
const floorDts = join(typesDir, ".floor.d.ts");

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
			if (propType.getCallSignatures().length === 0 && checker.getPropertiesOfType(propType).length) {
				walk(propType, path, depth - 1, unstable);
			}
		}
	};
	walk(checker.getTypeAtLocation(root), "", 1, false);
	return surface;
}

const tags = supportedTags();
if (!tags.length) {
	console.log(`Support floor v${SUPPORT_FLOOR} is unreleased -- nothing to compare against yet.`);
	process.exit(0);
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
let head;
try {
	head = surfaceOf(sdkDts);
	for (const [blob, tag] of blobTags) {
		writeFileSync(floorDts, spawnSync("git", ["show", blob], { cwd: pluginsDir }).stdout);
		for (const [p, unstable] of surfaceOf(floorDts)) {
			const prev = promised.get(p);
			if (prev && !prev.unstable) continue;
			promised.set(p, { unstable, tag });
		}
	}
} finally {
	rmSync(floorDts, { force: true });
}

const gone = [...promised.keys()].filter((p) => !head.has(p));
// A removed namespace implies its members; reporting both is noise.
const removed = gone.filter((p) => !p.includes(".") || !gone.includes(p.slice(0, p.lastIndexOf("."))));
const broken = removed.filter((p) => !promised.get(p).unstable).sort();

const stableCount = [...promised.values()].filter((v) => !v.unstable).length;
console.log(
	`Support window ${tags[0]}..${tags[tags.length - 1]}: ${tags.length} release(s), ` +
		`${blobTags.size} distinct surface(s), ${promised.size} members (${promised.size - stableCount} unstable), ` +
		`${head.size} today, ${removed.length} removed.`,
);

if (broken.length) {
	console.error(
		`\nFAIL: ${broken.length} stable API member(s) shipped plugins can still call were removed:\n` +
			broken.map((p) => `  MMA.${p} (stable since ${promised.get(p).tag})`).join("\n") +
			`\n\nAdd a shim in app/src/legacy.ts, or mark it @unstable before removing it.`,
	);
	process.exit(1);
}
console.log("ok");
