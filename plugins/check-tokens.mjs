// Fail when a plugin's CSS or TSX reads a custom property the app never defines. The
// app's tokens live in the `:root` blocks of app/src/styles.css; an undefined `var(--x)`
// silently renders its fallback. Properties a plugin sets itself are its own business.
// Run: node plugins/check-tokens.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginsDir = dirname(fileURLToPath(import.meta.url));
const stylesheet = join(pluginsDir, "..", "app", "src", "styles.css");

/** Custom properties declared inside any `:root { ... }` block of a stylesheet. */
export function rootTokens(css) {
	const tokens = new Set();
	for (const block of css.matchAll(/(?:^|[}\s]):root\s*\{([^}]*)\}/g)) {
		for (const m of block[1].matchAll(/(--[\w-]+)\s*:/g)) tokens.add(m[1]);
	}
	return tokens;
}

/** Undefined `var(--x)` reads in one source, as `[name, line]` pairs. */
export function undefinedReads(source, defined) {
	const own = new Set([...source.matchAll(/["'\s{;](--[\w-]+)["']?\s*:/g)].map((m) => m[1]));
	const out = [];
	for (const m of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
		if (defined.has(m[1]) || own.has(m[1])) continue;
		out.push([m[1], source.slice(0, m.index).split("\n").length]);
	}
	return out;
}

function sources(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sources(path, out);
		else if (/\.(css|tsx?)$/.test(name)) out.push(path);
	}
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const defined = rootTokens(readFileSync(stylesheet, "utf8"));
	let fail = 0;
	for (const name of readdirSync(pluginsDir).sort()) {
		const src = join(pluginsDir, name, "src");
		if (!existsSync(join(pluginsDir, name, "manifest.json")) || !existsSync(src)) continue;
		const bad = sources(src).flatMap((file) =>
			undefinedReads(readFileSync(file, "utf8"), defined).map(
				([token, line]) => `  ${relative(pluginsDir, file).replaceAll("\\", "/")}:${line} ${token}`,
			),
		);
		if (bad.length) {
			fail = 1;
			console.log(`[${name}] FAIL: not an app token\n${bad.join("\n")}`);
		} else {
			console.log(`[${name}] ok`);
		}
	}
	process.exit(fail);
}
