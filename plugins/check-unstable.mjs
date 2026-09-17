// Report plugin code reaching for `@unstable` API. Advisory: an unstable member is
// reachable and documented, it just carries no promise, so this warns and never fails.
// Run: node plugins/check-unstable.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { surfaceOf, ts } from "./check-legacy.mjs";

const pluginsDir = dirname(fileURLToPath(import.meta.url));
const sdkDts = join(pluginsDir, "types", "mma.d.ts");

/** Member paths a plugin file pulls off `MMA` (`ui.Sidebar`), by destructuring or member access. */
export function usedNames(file) {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const used = new Map();
	const record = (name, node) => {
		if (!used.has(name)) {
			used.set(name, ts.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1);
		}
	};
	const fromPattern = (pattern, prefix) => {
		for (const el of pattern.elements) {
			const key = `${prefix}${(el.propertyName ?? el.name).getText(source)}`;
			record(key, el);
			if (ts.isObjectBindingPattern(el.name)) fromPattern(el.name, `${key}.`);
		}
	};
	const walk = (node) => {
		if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
			const init = node.initializer.getText(source);
			if (init === "MMA" || init === "window.MMA") fromPattern(node.name, "");
		}
		if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "MMA") {
			record(node.name.getText(source), node.name);
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return used;
}

const sources = (dir) => {
	const out = [];
	const walk = (d) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const path = join(d, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.tsx?$/.test(entry.name)) out.push(path);
		}
	};
	walk(dir);
	return out;
};

function main() {
	const surface = surfaceOf(sdkDts);
	const plugins = readdirSync(pluginsDir)
		.map((name) => join(pluginsDir, name))
		.filter((dir) => existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "src")));

	let total = 0;
	for (const dir of plugins) {
		const name = dir.slice(pluginsDir.length + 1);
		const hits = [];
		for (const file of sources(join(dir, "src"))) {
			for (const [member, line] of usedNames(file)) {
				if (surface.get(member)) hits.push(`${relative(pluginsDir, file)}:${line} ${member}`);
			}
		}
		total += hits.length;
		console.log(hits.length ? `[${name}] ${hits.length} unstable:\n  ${hits.join("\n  ")}` : `[${name}] ok`);
	}
	console.log(total ? `\n${total} unstable use(s). No promise is made about these; expect churn.` : "\nNo unstable API in plugin code.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
