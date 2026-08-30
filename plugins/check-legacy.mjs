// The mirror of check-floors.mjs: that one catches a plugin reaching for an API newer
// than it claims to support, this one catches the app deleting an API that shipped
// plugins still call. Every member of the MMA surface at the support floor must still
// exist today, unless it was marked `@unstable` back then.
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
// tags. Raising it ages out every older guarantee at once.
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

/** `mma.d.ts` as committed at tag `v<version>`, or null when no such tag exists. */
function sdkAt(version) {
	const r = spawnSync("git", ["show", `v${version}:plugins/types/mma.d.ts`], { cwd: pluginsDir });
	return r.status === 0 ? r.stdout : null;
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

const floorSrc = sdkAt(SUPPORT_FLOOR);
if (!floorSrc) {
	console.log(`Support floor v${SUPPORT_FLOOR} is unreleased -- nothing to compare against yet.`);
	process.exit(0);
}

let head, floor;
try {
	writeFileSync(floorDts, floorSrc);
	head = surfaceOf(sdkDts);
	floor = surfaceOf(floorDts);
} finally {
	rmSync(floorDts, { force: true });
}

const gone = [...floor.keys()].filter((p) => !head.has(p));
// A removed namespace implies its members; reporting both is noise.
const removed = gone.filter((p) => !p.includes(".") || !gone.includes(p.slice(0, p.lastIndexOf("."))));
const broken = removed.filter((p) => !floor.get(p)).sort();

const unstableCount = [...floor.values()].filter(Boolean).length;
console.log(
	`Support floor v${SUPPORT_FLOOR}: ${floor.size} members (${unstableCount} unstable), ` +
		`${head.size} today, ${removed.length} removed.`,
);

if (broken.length) {
	console.error(
		`\nFAIL: ${broken.length} stable API member(s) plugins built against v${SUPPORT_FLOOR} can still call were removed:\n` +
			broken.map((p) => `  MMA.${p}`).join("\n") +
			`\n\nAdd a shim in app/src/legacy.ts, or mark it @unstable before removing it.`,
	);
	process.exit(1);
}
console.log("ok");
