// Extracts every translatable message into src/locales/en.json and derives the en-XA
// pseudolocale from it. en.json is generated -- edit the source strings, not the catalog.
//
//   node scripts/i18n-extract.mjs             rewrite en.json + en-XA.json
//   node scripts/i18n-extract.mjs --check     exit 1 if either is stale (CI gate)
//   node scripts/i18n-extract.mjs --audit     list user-visible strings still not wrapped
//   node scripts/i18n-extract.mjs --missing   per-locale untranslated keys; --write emits gap files
//
// Recognised call shapes:
//   t("Street View")            msg("Moving")            <Trans msg="Open {name}" />
//   t({ one: "{n} tag", other: "{n} tags" }, { n })      <Trans msg={{ one: …, other: … }} />

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const LOCALES = path.join(SRC, "locales");

function sourceFiles(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== "locales") sourceFiles(p, out);
		} else if (/\.tsx?$/.test(e.name) && !/^bindings\.|\.(gen|d)\.tsx?$/.test(e.name)) {
			out.push(p);
		}
	}
	return out;
}

const literal = (n) =>
	n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

/** `{ one: "…", other: "…" }` written at a call site, or null if `n` is not that shape. */
function pluralForms(n) {
	if (!n || !ts.isObjectLiteralExpression(n)) return null;
	const forms = {};
	for (const p of n.properties) {
		if (!ts.isPropertyAssignment(p)) return null;
		const text = literal(p.initializer);
		if (text === null) return null;
		forms[p.name.getText().replace(/["']/g, "")] = text;
	}
	return forms.one !== undefined && forms.other !== undefined ? forms : null;
}

// `t`/`msg` come from the runtime; `Trans` is a component and lives with the other primitives.
const I18N_MODULES = /(^|\/)(lib\/i18n|primitives\/Trans)$/;

/** Local names bound to i18n's `t`/`msg`/`Trans` in this file. Extraction keys off these rather
 *  than off bare identifiers, so an unrelated local `const t = trace(…)` is never mistaken for a
 *  message. Returns null when the file imports nothing from i18n. */
function i18nBindings(sf) {
	const bound = { t: null, msg: null, Trans: null };
	let found = false;
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st)) continue;
		const from = literal(st.moduleSpecifier);
		if (!from || !I18N_MODULES.test(from)) continue;
		const named = st.importClause?.namedBindings;
		if (!named || !ts.isNamedImports(named)) continue;
		for (const el of named.elements) {
			const imported = (el.propertyName ?? el.name).text;
			if (imported in bound) {
				bound[imported] = el.name.text;
				found = true;
			}
		}
	}
	return found ? bound : null;
}

/** Message sources keyed by catalog key, plus the files each was seen in (for error messages). */
export function extract(files) {
	const messages = new Map();
	const seenIn = new Map();

	const record = (key, value, file) => {
		const prev = messages.get(key);
		if (prev && JSON.stringify(prev) !== JSON.stringify(value)) {
			throw new Error(
				`Message "${key}" is declared with conflicting plural forms:\n` +
					`  ${JSON.stringify(prev)} in ${seenIn.get(key)}\n` +
					`  ${JSON.stringify(value)} in ${file}`,
			);
		}
		messages.set(key, value);
		if (!seenIn.has(key)) seenIn.set(key, file);
	};

	for (const file of files) {
		const rel = path.relative(ROOT, file).replace(/\\/g, "/");
		const sf = ts.createSourceFile(
			file,
			fs.readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);

		const bound = i18nBindings(sf);
		if (!bound) continue;

		const take = (node) => {
			const text = literal(node);
			if (text !== null) return record(text, text, rel);
			const forms = pluralForms(node);
			if (forms) return record(forms.other, forms, rel);
		};

		// JsxAttribute -> JsxAttributes -> JsxOpeningElement | JsxSelfClosingElement
		const isTransElement = (n) =>
			bound.Trans !== null && n.parent?.parent?.tagName?.getText?.() === bound.Trans;

		const visit = (n) => {
			if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
				const fn = n.expression.text;
				if (fn === bound.t || fn === bound.msg) take(n.arguments[0]);
			} else if (ts.isJsxAttribute(n) && n.name.getText() === "msg" && isTransElement(n)) {
				const init = n.initializer;
				if (init && ts.isJsxExpression(init)) take(init.expression);
				else take(init);
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return messages;
}

/** Field and enum labels defined on the Rust side reach the UI through the generated
 *  bindings, so extraction reads them from there -- the bindings stay the single source. */
function bindingLabels() {
	const file = path.join(SRC, "bindings.consts.ts");
	const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const labels = [];
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		for (const decl of st.declarationList.declarations) {
			const name = decl.name.getText();
			if (name !== "BUILTIN_FIELDS" && name !== "KNOWN_FIELDS") continue;
			const init = ts.isAsExpression(decl.initializer)
				? decl.initializer.expression
				: decl.initializer;
			// The file is prettier-formatted, so its literals are JS objects, not JSON.
			for (const f of new Function(`return ${init.getText(sf)}`)()) {
				if (f.label) labels.push(f.label);
				for (const [, label] of f.labels ?? []) labels.push(label);
			}
		}
	}
	return labels;
}

const ACCENTS = {
	a: "å", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ǧ", h: "ĥ", i: "î", j: "ĵ",
	k: "ķ", l: "ĺ", m: "ɱ", n: "ñ", o: "ö", p: "ƥ", q: "ǫ", r: "ŕ", s: "ş", t: "ţ",
	u: "ü", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
};
const PAD = "åéîöü";

/** Accents letters and pads ~40% so a real translation's length is visible, leaving {params}
 *  untouched. Plain ASCII in a pseudolocalised build means a string escaped extraction. */
export function pseudo(text) {
	const accented = text
		.split(/(\{\w+\})/)
		.map((part, i) =>
			i % 2
				? part
				: part.replace(/[a-z]/gi, (c) => {
						const low = ACCENTS[c.toLowerCase()] ?? c;
						return c === c.toLowerCase() ? low : low.toUpperCase();
					}),
		)
		.join("");
	const extra = Math.ceil(text.replace(/\{\w+\}/g, "").length * 0.4);
	const tail = extra > 0 ? " " + PAD.repeat(Math.ceil(extra / PAD.length)).slice(0, extra) : "";
	return `[${accented}${tail}]`;
}

function build(messages) {
	const en = {};
	const xa = {};
	for (const key of [...messages.keys()].sort()) {
		const value = messages.get(key);
		if (typeof value === "string") {
			en[key] = value;
			xa[key] = pseudo(value);
		} else {
			en[key] = { ...value };
			xa[key] = Object.fromEntries(Object.entries(value).map(([c, s]) => [c, pseudo(s)]));
		}
	}
	return { en, xa };
}

// Props whose string value is read by a user. `name`/`type`/`id` are deliberately absent -- they
// are identity far more often than they are copy.
const DISPLAY_PROPS = new Set([
	"title", "placeholder", "aria-label", "ariaLabel", "label", "description", "confirmLabel",
	"cancelLabel", "emptyText", "hint", "summary", "alt", "tooltip", "heading", "subtitle", "caption",
	"content",
]);

/** Rough "is this English copy" test, matching the one used to size the migration. */
function looksLikeCopy(s) {
	const text = s.replace(/\s+/g, " ").trim();
	if (text.length < 2 || text.length > 300) return false;
	if (!/[a-zA-Z]/.test(text)) return false;
	if (/^[a-z0-9_\-.:/#]+$/.test(text)) return false; // ids, kebab, paths, hex
	if (/^[A-Z0-9_]+$/.test(text)) return false; // SCREAMING_CASE
	if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(text)) return false; // camelCase
	if (/^https?:|^\/|^\.\//.test(text)) return false;
	return /\s/.test(text) || /^[A-Z]/.test(text);
}

// Call channels whose first argument is user-visible copy.
const COPY_CALLS = new Set(["toast"]);

/** User-visible string literals that are NOT inside a t()/msg()/<Trans> call, per file. Drives the
 *  coverage gate: once a file reads zero here, it cannot silently regain a hardcoded string. */
export function auditUnwrapped(files) {
	const perFile = new Map();
	for (const file of files) {
		const rel = path.relative(ROOT, file).replace(/\\/g, "/");
		const sf = ts.createSourceFile(
			file,
			fs.readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		const hits = [];
		// A migrated string is no longer a bare literal here: JSX text becomes `{t("…")}` (an
		// expression, not JsxText), `title="…"` becomes `title={t("…")}`, and `label: "…"` becomes
		// `label: t("…")` or `msg("…")` -- all calls, not literals. So anything still matching
		// below is genuinely unwrapped. Object properties are covered too: inline
		// `options={[{ label: "Gen 1" }]}` arrays are display text the JSX walk alone would miss.

		/** String leaves of a rendering expression: literals, ternary arms, `||`/`??`/`&&`
		 *  fallbacks, concatenation, and template spans. */
		const leaves = (expr, kind) => {
			if (!expr) return;
			if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
				if (looksLikeCopy(expr.text)) hits.push({ kind, text: expr.text, node: expr });
			} else if (ts.isTemplateExpression(expr)) {
				for (const part of [expr.head, ...expr.templateSpans.map((s) => s.literal)]) {
					if (looksLikeCopy(part.text)) hits.push({ kind, text: part.text, node: part });
				}
			} else if (ts.isConditionalExpression(expr)) {
				leaves(expr.whenTrue, kind);
				leaves(expr.whenFalse, kind);
			} else if (ts.isParenthesizedExpression(expr)) {
				leaves(expr.expression, kind);
			} else if (
				ts.isBinaryExpression(expr) &&
				["||", "??", "&&", "+"].includes(expr.operatorToken.getText())
			) {
				leaves(expr.left, kind);
				leaves(expr.right, kind);
			}
		};
		const visit = (n) => {
			if (ts.isJsxText(n)) {
				const text = n.text.replace(/\s+/g, " ").trim();
				if (looksLikeCopy(text)) hits.push({ kind: "text", text, node: n });
			} else if (
				ts.isJsxExpression(n) &&
				(ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
			) {
				leaves(n.expression, "text");
			} else if (ts.isJsxAttribute(n) && DISPLAY_PROPS.has(n.name.getText()) && n.initializer) {
				const init = n.initializer;
				if (ts.isJsxExpression(init)) leaves(init.expression, "attr");
				else leaves(init, "attr");
			} else if (ts.isPropertyAssignment(n)) {
				const key = n.name.getText().replace(/["']/g, "");
				if (DISPLAY_PROPS.has(key)) leaves(n.initializer, "prop");
			} else if (
				ts.isCallExpression(n) &&
				ts.isIdentifier(n.expression) &&
				COPY_CALLS.has(n.expression.text)
			) {
				leaves(n.arguments[0], "call");
			} else if (
				(ts.isParameter(n) || ts.isBindingElement(n)) &&
				n.initializer &&
				ts.isIdentifier(n.name) &&
				DISPLAY_PROPS.has(n.name.text)
			) {
				leaves(n.initializer, "prop");
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
		if (hits.length) perFile.set(rel, hits);
	}
	return perFile;
}

const serialise = (obj) => JSON.stringify(obj, null, "\t") + "\n";

/** The catalogs the current source tree should produce, as `[path, contents]`. */
export function catalogTargets() {
	const files = sourceFiles(SRC);
	const messages = extract(files);
	for (const label of bindingLabels()) if (!messages.has(label)) messages.set(label, label);
	const { en, xa } = build(messages);
	return {
		files,
		count: Object.keys(en).length,
		targets: [
			[path.join(LOCALES, "en.json"), serialise(en)],
			[path.join(LOCALES, "en-XA.json"), serialise(xa)],
		],
	};
}

/** Catalog files that differ from what the source tree would produce. */
export function staleCatalogs() {
	return catalogTargets().targets.filter(([file, want]) => {
		const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
		return have !== want;
	});
}

/** Keys present in en but absent (or stale) in each other locale, plus orphans it should drop. */
export function localeGaps() {
	const en = JSON.parse(fs.readFileSync(path.join(LOCALES, "en.json"), "utf8"));
	return fs
		.readdirSync(LOCALES)
		.filter((f) => f.endsWith(".json") && f !== "en.json" && f !== "en-XA.json")
		.map((f) => {
			const code = f.replace(/\.json$/, "");
			const catalog = JSON.parse(fs.readFileSync(path.join(LOCALES, f), "utf8"));
			const missing = Object.fromEntries(
				Object.entries(en).filter(([k]) => !(k in catalog)),
			);
			const orphans = Object.keys(catalog).filter((k) => !(k in en));
			return { code, total: Object.keys(en).length, missing, orphans };
		});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { files, count, targets } = catalogTargets();
	if (process.argv.includes("--missing")) {
		const write = process.argv.includes("--write");
		let clean = true;
		for (const { code, total, missing, orphans } of localeGaps()) {
			const n = Object.keys(missing).length;
			if (!n && !orphans.length) {
				console.log(`${code}: complete (${total})`);
				continue;
			}
			clean = false;
			console.log(`${code}: ${total - n}/${total} translated, ${n} missing, ${orphans.length} orphaned`);
			for (const k of Object.keys(missing).slice(0, 10)) console.log(`    + ${JSON.stringify(k)}`);
			if (n > 10) console.log(`    ... and ${n - 10} more`);
			for (const k of orphans.slice(0, 5)) console.log(`    - ${JSON.stringify(k)} (no longer in en)`);
			if (write && n) {
				const out = path.join(LOCALES, `${code}.missing.json`);
				fs.writeFileSync(out, JSON.stringify(missing, null, "\t") + "\n");
				console.log(`    -> wrote ${path.basename(out)} for translation`);
			}
		}
		if (clean) console.log("\nall locales in step with en");
	} else if (process.argv.includes("--audit")) {
		// `--audit <substring>` narrows to matching paths and lists the actual strings, so a
		// single file can be driven to zero without reading anyone else's in-flight edits.
		const filter = process.argv[process.argv.indexOf("--audit") + 1];
		const scoped = filter ? files.filter((f) => f.replace(/\\/g, "/").includes(filter)) : files;
		const perFile = auditUnwrapped(scoped);
		const total = [...perFile.values()].reduce((a, h) => a + h.length, 0);
		const byKind = { text: 0, attr: 0, prop: 0, call: 0 };
		for (const [file, hits] of [...perFile].sort((a, b) => b[1].length - a[1].length)) {
			console.log(String(hits.length).padStart(4), file);
			for (const h of hits) {
				byKind[h.kind]++;
				if (filter) console.log(`       [${h.kind}] ${JSON.stringify(h.text)}`);
			}
		}
		console.log(`\n${total} unwrapped strings across ${perFile.size} of ${scoped.length} files`);
		console.log(
			`  jsx text ${byKind.text} | attributes ${byKind.attr} | object props ${byKind.prop} | calls ${byKind.call}`,
		);
	} else if (process.argv.includes("--check")) {
		const stale = targets.filter(([file, want]) => {
			const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
			return have !== want;
		});
		if (stale.length) {
			console.error(
				`i18n catalogs are stale: ${stale.map(([f]) => path.basename(f)).join(", ")}\n` +
					"Run `npm run i18n:extract` and commit the result.",
			);
			process.exit(1);
		}
		console.log(`i18n catalogs up to date (${count} messages)`);
	} else {
		fs.mkdirSync(LOCALES, { recursive: true });
		for (const [file, contents] of targets) fs.writeFileSync(file, contents);
		console.log(`Extracted ${count} messages from ${files.length} files -> en.json, en-XA.json`);
	}
}
