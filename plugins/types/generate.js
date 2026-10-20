// Assemble the plugin surface (api.ts) from the app's `@api` tags, then bundle its types
// (mma.d.ts): tsc emits real .d.ts files (JSDoc survives declaration emit), then
// rollup-plugin-dts rolls them into one file.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { generateAndPublish } = require("./generated-output.js");

const repoRoot = path.resolve(__dirname, "../..");
const appDir = path.join(repoRoot, "app");
const out = path.resolve(__dirname, "mma.d.ts");
const apiPath = path.join(appDir, "src", "api.ts");

async function main() {
  const native = await import(pathToFileURL(path.join(appDir, "scripts", "native-ts.mjs")).href);
  const api = await assembleApi(native, path.join(appDir, "src"));
  await generateAndPublish(async () => ({ api }), [{ key: "api", path: apiPath }]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mma-dts-"));
  try {
    const tsc = path.join(appDir, "node_modules", "@typescript", "native", "bin", "tsc");
    execFileSync(
      process.execPath,
      [tsc, "-p", "tsconfig.app.json", "--declaration", "--emitDeclarationOnly", "--noEmit", "false", "--rootDir", "src", "--outDir", tmp],
      { cwd: appDir, stdio: "inherit" },
    );

    // Hand-written .d.ts sources are not emitted
    // by tsc - copy them in so imports resolve.
    const copyDts = (dir, rel = "") => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) copyDts(dir, r);
        else if (e.name.endsWith(".d.ts")) {
          fs.mkdirSync(path.dirname(path.join(tmp, r)), { recursive: true });
          fs.copyFileSync(path.join(dir, r), path.join(tmp, r));
        }
      }
    };
    copyDts(path.join(appDir, "src"));

    // Junction so bare imports (@tauri-apps/...) resolve for inlining.
    fs.symlinkSync(path.join(appDir, "node_modules"), path.join(tmp, "node_modules"), "junction");

    // Mirror entrypoint.ts against the emitted tree ("../../app/src/X" -> "./X").
    const entrySrc = fs
      .readFileSync(path.join(__dirname, "entrypoint.ts"), "utf-8")
      .replace(/(["'])\.\.\/\.\.\/app\/src\//g, "$1./");
    const entry = path.join(tmp, "entrypoint.d.ts");
    fs.writeFileSync(entry, entrySrc);

    const { rollup } = require(path.join(appDir, "node_modules", "rollup"));
    const dts = require(path.join(appDir, "node_modules", "rollup-plugin-dts")).default;

    const bundle = await rollup({
      input: entry,
      external: [/^react/, /^@deck\.gl\//, /^@tauri-apps\//, /^maplibre-gl/, /^@base-ui-components\//],
      plugins: [
        dts({
          respectExternal: true,
          compilerOptions: {
            baseUrl: tmp,
            paths: { "@/*": ["./*"] },
          },
        }),
      ],
      onwarn(warning, warn) {
        if (warning.code === "EMPTY_BUNDLE" || warning.code === "UNUSED_EXTERNAL_IMPORT") return;
        warn(warning);
      },
    });
    const { output } = await bundle.generate({ format: "es" });
    await bundle.close();
    let content = output[0].code;

    // The SDK ships no JavaScript, so nothing it exports is a value: the bundler's final
    // `export { ... }` becomes `export type { ... }`, and a plugin that imports a runtime
    // member from the SDK fails to typecheck instead of failing to bundle. Values live on
    // `MMA`.
    content = content.replace(/^export \{ /m, "export type { ");

    // rollup-plugin-dts appends $1 to names that collide across modules.
    for (const name of ["Selection", "Plugin", "MMA"]) {
      content = content.replace(new RegExp(`\\b${name}\\$1\\b`, "g"), name);
    }
    // A store companion re-declares its type as `type X = X$1`; give the original its name back.
    for (const [line, name] of content.matchAll(/^(?:export )?type (\w+)(?:<[^>]*>)? = \1\$1(?:<[^>]*>)?;\n/gm)) {
      content = content.replace(line, "").replace(new RegExp(`\\b${name}\\$1\\b`, "g"), name);
    }

    const alreadyExported = new Set();
    for (const m of content.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const part of m[1].split(",")) {
        const asMatch = part.match(/\bas\s+(\w+)/);
        alreadyExported.add(asMatch ? asMatch[1] : part.trim());
      }
    }
    content = content.replace(/^(interface|type) (\w+)/gm, (line, kind, name) =>
      alreadyExported.has(name) ? line : `export ${kind} ${name}`,
    );

    // api.ts's `declare global` (window.MMA + bare MMA) survives the bundle,
    // so no appended global block is needed.
    content = `/// <reference types="google.maps" />\n\n` + content;
    content = stripInternal(native, content);
    rejectBackendSpelling(content);
    content = propagateUnstable(native, content);
    content = stampUnpromisedExports(native, content);
    const markdown = await generateApiMarkdown(native, content);
    const markdownPath = path.resolve(__dirname, "API.md");
    await generateAndPublish(async () => ({ [out]: content, [markdownPath]: markdown }), [
      { key: out, path: out },
      { key: markdownPath, path: markdownPath },
    ]);
    console.log("Generated plugins/types/mma.d.ts");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Every exported declaration whose doc carries `@api`, by the module that declares it. A value
// lands on `MMA` under its own name; a type is exported beside it.
function apiDeclarations({ ts, withProgram }, srcDir) {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") && p !== apiPath) files.push(p);
    }
  };
  walk(srcDir);
  const options = { noResolve: true, noLib: true, types: [], jsx: "preserve" };
  return withProgram(files, options, ({ program }) => files.flatMap((file) => {
    const source = program.getSourceFile(file);
    const types = [];
    const values = [];
    for (const node of source.statements) {
      if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (!jsDocTagNames(ts, node).includes("api")) continue;
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) types.push(node.name.text);
      else if (ts.isVariableStatement(node)) values.push(...node.declarationList.declarations.map((d) => d.name.text));
      else if (node.name) values.push(node.name.text);
    }
    if (values.length === 0 && types.length === 0) return [];
    const module = path.relative(srcDir, file).replace(/\\/g, "/").replace(/\.tsx?$/, "");
    return [{ module, values: values.sort(), types: types.sort() }];
  }));
}

// A module's section is its file name, or its folder's for an index. Two modules that would
// share a title each take parent folders until they differ.
function sectionNames(modules) {
  const parts = modules.map((m) => {
    const segments = m.split("/");
    if (segments.length > 1 && segments[segments.length - 1] === "index") segments.pop();
    return segments;
  });
  const depth = parts.map(() => 1);
  const title = (i) => parts[i].slice(-depth[i]).join("/");
  for (;;) {
    const byTitle = new Map();
    parts.forEach((_, i) => byTitle.set(title(i), [...(byTitle.get(title(i)) ?? []), i]));
    const clashing = [...byTitle.values()].filter((is) => is.length > 1).flat();
    if (clashing.length === 0) break;
    for (const i of clashing) {
      if (depth[i] === parts[i].length) throw new Error(`api: no folder tells ${modules[i]} apart`);
      depth[i]++;
    }
  }
  const pascal = (segment) =>
    segment.split(".").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return parts.map((_, i) => parts[i].slice(-depth[i]).map(pascal).join("_"));
}

// The module that puts every `@api` value on `MMA` and exports every `@api` type.
async function assembleApi(native, srcDir) {
  const declared = apiDeclarations(native, srcDir);
  for (const kind of ["values", "types"]) {
    const owner = new Map();
    for (const d of declared) {
      for (const name of d[kind]) {
        if (owner.has(name)) throw new Error(`api: ${name} is declared by both ${owner.get(name)} and ${d.module}`);
        owner.set(name, d.module);
      }
    }
  }
  const sections = sectionNames(declared.map((d) => d.module));
  const modules = declared
    .map((d, i) => ({ ...d, section: sections[i] }))
    .sort((a, b) => a.section.localeCompare(b.section));
  const withValues = modules.filter((m) => m.values.length > 0);
  const text = [
    "// Generated by `npm run gen:plugin-types` from the `@api` tags. Do not edit.",
    'export type * from "@/bindings.gen";',
    ...modules
      .filter((m) => m.types.length > 0)
      .map((m) => `export type { ${m.types.join(", ")} } from "@/${m.module}";`),
    ...withValues.map((m) => `import { ${m.values.join(", ")} } from "@/${m.module}";`),
    "",
    ...withValues.map((m) => `type ${m.section}Api = { ${m.values.map((v) => `${v}: typeof ${v}`).join("; ")} };`),
    "",
    "/** The global `MMA` object (also `window.MMA`). */",
    `export interface MMA extends ${withValues.map((m) => `${m.section}Api`).join(", ")} {}`,
    "",
    "export type { MMA as MMAApi };",
    "",
    "const mma: MMA = {",
    ...withValues.flatMap((m) => m.values.map((v) => `${v},`)),
    "};",
    "",
    "declare global {",
    "interface Window {",
    "MMA: MMA;",
    "}",
    "const MMA: MMA;",
    "}",
    "",
    "window.MMA = mma;",
    "",
    "export default mma;",
    "",
  ].join("\n");
  const { format } = await import(pathToFileURL(path.join(appDir, "node_modules", "oxfmt", "dist", "index.js")).href);
  const { $schema, ignorePatterns, ...config } = JSON.parse(fs.readFileSync(path.join(appDir, ".oxfmtrc.json"), "utf-8"));
  const { code, errors } = await format("api.ts", text, config);
  if (errors.length > 0) throw new Error(`api.ts failed to format: ${errors[0].message}`);
  console.log(`Assembled api.ts (${withValues.reduce((n, m) => n + m.values.length, 0)} values from ${withValues.length} modules)`);
  return code;
}

// Doc comments are what a plugin author reads, so they name things the way the SDK spells
// them: `null`, camelCase members, no rustdoc links. A snake_case name is allowed only when
// the SDK itself declares it.
function rejectBackendSpelling(content) {
  const docs = [...content.matchAll(/(\/\*\*[\s\S]*?\*\/)\s*([^\n]*)/g)];
  const code = content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const declared = new Set(code.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g));
  const problems = [];
  for (const [, block, following] of docs) {
    const found = [
      ...[...block.matchAll(/`(None|Some)\b[^`]*`|\bSome\(/g)].map((m) => m[0]),
      ...[...block.matchAll(/\[`[\w:]+`\]/g)].map((m) => m[0]),
      ...[...block.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)]
        .filter((m) => !declared.has(m[1]))
        .map((m) => m[0]),
    ];
    if (found.length) problems.push(`  ${following.trim()}: ${found.join(", ")}`);
  }
  if (problems.length) {
    throw new Error(`Doc comments use backend spelling (say null, camelCase, no [links]):\n${problems.join("\n")}`);
  }
}

// One program over the staged bundle at its final virtual path, with its `MMA` interface.
function withBundle({ ts, withProgram }, text, use) {
  const options = { skipLibCheck: true, target: "esnext" };
  return withProgram([out], options, ({ checker, program }) => {
    const source = program.getSourceFile(out);
    const root = source.statements.find((n) => ts.isInterfaceDeclaration(n) && n.name.text === "MMA");
    if (!root) throw new Error("no MMA interface in the bundle");
    return use({ checker, source, root });
  }, new Map([[out, text]]));
}

// The tag names on a node's own doc comment. A variable's comment sits on its statement.
const jsDocTagNames = (ts, node) =>
  ((ts.isVariableDeclaration(node) ? node.parent.parent : node).jsDoc || []).flatMap((doc) =>
    (doc.tags || []).map((t) => t.tagName.text),
  );

// The declarations of `sym` in `source`, as nodes.
const declarationsIn = (source, sym) =>
  ((sym && sym.declarations) || []).filter((d) => d.path === source.path).map((d) => d.resolve());

const callSignatures = (ts, checker, type) => checker.getSignaturesOfType(type, ts.SignatureKind.Call);

// A member reaches its const through `name: typeof name`, an export alias and, when the
// bundler renamed it, a `typeof` const. Every hop is a declaration a reader can hover.
function declarationHops(ts, checker) {
  return (sym) => {
    const hops = [];
    for (let s = sym, i = 0; s && i < 4; i++) {
      const next = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : null;
      const decl = (next || s).declarations?.[0]?.resolve();
      const query = decl && (ts.isVariableDeclaration(decl) || ts.isPropertySignatureDeclaration(decl)) && decl.type && ts.isTypeQueryNode(decl.type)
        ? checker.getSymbolAtLocation(decl.type.exprName)
        : null;
      if (next) hops.push(next);
      if (query) hops.push(query);
      s = query || (next && next.id !== s.id ? next : null);
    }
    return hops;
  };
}

// Whether a member is `@unstable`, read off the declarations it reaches. A bundler alias
// merges a const with a same-named type, so a hop's tag is its value declaration's alone.
function memberUnstable(ts, checker) {
  const hopsOf = declarationHops(ts, checker);
  const tagged = (sym) =>
    sym.valueDeclaration
      ? jsDocTagNames(ts, sym.valueDeclaration.resolve()).includes("unstable")
      : sym.getJsDocTags(checker).some((t) => t.name === "unstable");
  return (prop, target) => [prop, target, ...hopsOf(prop)].some((s) => s && tagged(s));
}

// `@unstable` is declared once -- on a declaration or a namespace (`cmd`) -- but a plugin
// author hovers the member, not where it was declared. Stamp it onto every member the tag
// covers so the warning is visible where the call is written.
function propagateUnstable(native, text) {
  const { ts } = native;
  const edits = withBundle(native, text, ({ checker, source, root }) => {
    const unstableMember = memberUnstable(ts, checker);

    // Where a doc comment can actually go. A symbol's declaration is sometimes the type
    // node (`() => void`), which is not a place a reader would ever look.
    const documentable = (d) => {
      if (ts.isVariableDeclaration(d)) return d.parent && d.parent.parent;
      // A const's type is often an anonymous literal or function type; the tag belongs on the const.
      if (d.parent && ts.isVariableDeclaration(d.parent) && d.parent.type === d) {
        return documentable(d.parent);
      }
      return ts.isFunctionDeclaration(d) ||
        ts.isPropertySignatureDeclaration(d) ||
        ts.isMethodSignatureDeclaration(d) ||
        ts.isPropertyAssignment(d) ||
        ts.isInterfaceDeclaration(d) ||
        ts.isTypeAliasDeclaration(d)
        ? d
        : null;
    };
    const targets = new Set();
    const declaredThrough = declarationHops(ts, checker);

    const collect = (type, depth, inherited) => {
      for (const prop of checker.getPropertiesOfType(type)) {
        const propType = checker.getTypeOfSymbolAtLocation(prop, root);
        const target = propType.getSymbol();
        const unstable = inherited || unstableMember(prop, target);
        if (unstable) {
          for (const sym of [prop, target, ...declaredThrough(prop)]) {
            for (const d of declarationsIn(source, sym)) {
              const node = documentable(d);
              if (node) targets.add(node);
            }
          }
        }
        if (depth > 0 && callSignatures(ts, checker, propType).length === 0) {
          collect(propType, depth - 1, unstable);
        }
      }
    };
    collect(checker.getTypeAtLocation(root), 1, false);
    return stampEdits(source, targets);
  });

  const result = applyEdits(edits, text);
  console.log(`Propagated @unstable to ${result.count} members`);
  return result.text;
}

// A member tagged `@internal` is the app's own plumbing on an object plugins can reach. It is
// left out of the plugin types, so no plugin is written against it.
function stripInternal(native, text) {
  const { ts } = native;
  const ranges = withBundle(native, text, ({ source }) => {
    const found = [];
    const visit = (node) => {
      if ((ts.isPropertySignatureDeclaration(node) || ts.isMethodSignatureDeclaration(node)) && jsDocTagNames(ts, node).includes("internal")) {
        found.push({ start: node.pos, end: node.end });
        return;
      }
      node.forEachChild(visit);
    };
    visit(source);
    return found;
  });
  ranges.sort((a, b) => b.start - a.start);
  for (const { start, end } of ranges) text = text.slice(0, start) + text.slice(end);
  console.log(`Stripped ${ranges.length} @internal members`);
  return text;
}

// The edits that add `@unstable` to the doc comment of each node, or give it one.
function stampEdits(source, nodes) {
  const full = source.text;
  const edits = [];
  for (const node of nodes) {
    const docs = node.jsDoc;
    if (docs && docs.length) {
      const last = docs[docs.length - 1];
      const text = last.getText(source);
      if (text.includes("@unstable")) continue;
      // Just before the closing `*/`. On a multi-line block that spot is the start of the
      // closing line, which needs its own ` *  ` prefix; on a one-liner it is mid-line.
      const at = last.getEnd() - 2;
      const lineStart = full.lastIndexOf("\n", at) + 1;
      const indent = full.slice(lineStart, at);
      edits.push(
        indent.trim() === ""
          ? { at, insert: `*  @unstable\n${indent}` }
          : { at, insert: "@unstable " },
      );
    } else {
      const start = node.getStart(source);
      const col = start - source.getLineStarts()[source.getLineAndCharacterOfPosition(start).line];
      edits.push({ at: start, insert: `/** @unstable */\n${" ".repeat(col)}` });
    }
  }
  return edits;
}

// Rewrites the d.ts with `edits`, highest offset first so earlier edits keep their positions.
function applyEdits(edits, text) {
  edits.sort((a, b) => b.at - a.at);
  for (const e of edits) text = text.slice(0, e.at) + e.insert + text.slice(e.at);
  return { text, count: edits.length };
}

// A type is promised only while a stable member's signature can reach it. Everything else
// the bundle exports -- a command's result, a settings shape, a bundler namespace alias --
// is stamped `@unstable`, so the type gate in check-legacy holds exactly what plugins can
// get their hands on through the stable surface.
function stampUnpromisedExports(native, text) {
  const { ts } = native;
  const edits = withBundle(native, text, ({ checker, source, root }) => {
    const taggedNode = (n) => jsDocTagNames(ts, n).includes("unstable");
    const unstableMember = memberUnstable(ts, checker);
    const resolve = (sym) => (sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);

    const reached = new Set([root]);
    const visit = (sym) => {
      for (const d of declarationsIn(source, resolve(sym))) {
        if (reached.has(d) || taggedNode(d)) continue;
        reached.add(d);
        walk(d);
      }
    };
    const walk = (node) => {
      if (node !== root && node.parent && taggedNode(node) && !ts.isVariableDeclaration(node)) return;
      if (ts.isTypeReferenceNode(node)) visit(checker.getSymbolAtLocation(node.typeName));
      else if (ts.isExpressionWithTypeArguments(node)) visit(checker.getSymbolAtLocation(node.expression));
      else if (ts.isTypeQueryNode(node)) visit(checker.getSymbolAtLocation(node.exprName));
      else if (ts.isExportSpecifier(node)) visit(checker.getExportSpecifierLocalTargetSymbol(node));
      node.forEachChild(walk);
    };

    for (const prop of checker.getPropertiesOfType(checker.getTypeAtLocation(root))) {
      if (unstableMember(prop, checker.getTypeOfSymbolAtLocation(prop, root).getSymbol())) continue;
      visit(prop);
    }

    const documentable = (d) =>
      ts.isVariableDeclaration(d) ? d.parent && d.parent.parent : d;
    // rollup-plugin-dts names a module's members `module_Name` inside its namespace. The alias
    // is how the bundle is assembled, not a name a plugin should import.
    const bundlerAlias = (name, decls) =>
      decls.every((d) => {
        const ref = ts.isTypeAliasDeclaration(d) && ts.isTypeReferenceNode(d.type) ? d.type.typeName
          : ts.isVariableDeclaration(d) && d.type && ts.isTypeQueryNode(d.type) ? d.type.exprName
          : null;
        return !!ref && ts.isIdentifier(ref) && name.endsWith(`_${ref.text}`);
      });
    const unpromised = new Set();
    for (const exp of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) {
      // The per-module aliases api.ts assembles MMA from carry the surface tags themselves.
      if (/Api$/.test(exp.name)) continue;
      const decls = declarationsIn(source, resolve(exp));
      if (decls.length === 0 || (decls.some((d) => reached.has(d)) && !bundlerAlias(exp.name, decls))) continue;
      for (const d of decls) unpromised.add(documentable(d));
    }
    return stampEdits(source, unpromised);
  });
  const result = applyEdits(edits, text);
  console.log(`Stamped @unstable on ${result.count} exports no stable member reaches`);
  return result.text;
}

// The release each member path (`addLocations`, `ui.Sidebar`) first shipped in, read from the
// `mma.d.ts` at every release tag, with `current` standing in for app/package.json's version
// until that version is tagged. Names only: no libraries resolve, so each release parses in
// milliseconds. Empty without tags (a shallow clone), and the reference then omits "since".
function firstReleases(native, current, root = repoRoot) {
  const git = (args, input) => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        input,
        encoding: "utf-8",
        maxBuffer: 1 << 30,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  };
  const cmpVer = (a, b) => {
    const [x, y] = [a.slice(1).split(".").map(Number), b.slice(1).split(".").map(Number)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  const tags = git(["tag", "--list", "v*"])
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort(cmpVer);
  if (tags.length === 0) return new Map();
  const version = `v${JSON.parse(fs.readFileSync(path.join(root, "app", "package.json"), "utf-8")).version}`;
  const untagged = !tags.includes(version);

  const spec = (tag) => `${tag}:plugins/types/mma.d.ts`;
  const blobOf = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], tags.map(spec).join("\n") + "\n")
    .split("\n")
    .slice(0, tags.length)
    .map((line) => (line.endsWith(" blob") ? line.split(" ")[0] : null));
  const distinct = [...new Set(blobOf.filter(Boolean))];
  const contents = git(["cat-file", "--batch"], distinct.join("\n") + "\n");

  // `--batch` prints `<sha> blob <size>` then exactly <size> bytes per object.
  const files = new Map();
  const bytes = Buffer.from(contents, "utf-8");
  let at = 0;
  for (const sha of distinct) {
    const eol = bytes.indexOf(10, at);
    const size = Number(bytes.subarray(at, eol).toString().split(" ")[2]);
    files.set(path.join(__dirname, `.release-${sha}.d.ts`), bytes.subarray(eol + 1, eol + 1 + size).toString("utf-8"));
    at = eol + 1 + size + 1;
  }
  if (untagged) files.set(path.join(__dirname, ".release-current.d.ts"), current);
  const names = memberNames(native, files);
  const namesByBlob = new Map(distinct.map((sha, i) => [sha, names[i]]));

  const first = new Map();
  tags.forEach((tag, i) => {
    for (const name of namesByBlob.get(blobOf[i]) ?? []) if (!first.has(name)) first.set(name, tag);
  });
  if (untagged) for (const name of names[distinct.length]) if (!first.has(name)) first.set(name, version);
  return first;
}

// Each release's member paths, in the order of `files`.
function memberNames({ ts, withProgram }, files) {
  const options = { noLib: true, noResolve: true, types: [] };
  return withProgram([...files.keys()], options, ({ checker, program }) => [...files.keys()].map((file) => {
    const source = program.getSourceFile(file);
    // Older releases spell the surface `type MMA = typeof mma` or `type MMAApi = typeof mmaApi`.
    let root = null;
    for (const n of source.statements) {
      const named = ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n);
      if (named && /^MMA(\$1|Api)?$/.test(n.name.text) && (!root || n.name.text === "MMA")) root = n;
    }
    const names = new Set();
    if (!root) return names;
    const surface = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(root.name));
    const props = checker.getPropertiesOfType(surface);
    const types = checker.getTypeOfSymbol(props);
    props.forEach((prop, i) => {
      names.add(prop.name);
      const inner = checker.getPropertiesOfType(types[i]);
      if (inner.length === 0 || callSignatures(ts, checker, types[i]).length > 0) return;
      for (const p of inner) names.add(`${prop.name}.${p.name}`);
    });
    return names;
  }), files);
}

// The human-readable companion to mma.d.ts: one section per module on the MMA interface,
// each member with its badges, signature and doc. Stable sections come first.
// Output-only -- regenerated with the d.ts, never hand-edited.
async function generateApiMarkdown(native, text, since = firstReleases(native, text)) {
  const { ts } = native;
  const { format } = await import(pathToFileURL(path.join(appDir, "node_modules", "oxfmt", "dist", "index.js")).href);
  const flags = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope;
  const NL = "\n";

  // Every code block is formatted in one oxfmt pass. Each is a declaration of a placeholder
  // name (a dotted path like `ui.Button` would not parse), preceded by a marker comment.
  const blocks = [];
  const block = (name, declaration) => {
    const slot = { name, declaration, text: declaration };
    blocks.push(slot);
    return slot;
  };
  const formatBlocks = async () => {
    const marker = "// @@block";
    const joined = blocks.map((b) => marker + NL + b.declaration).join(NL);
    const { code: formatted, errors } = await format("api.ts", joined, { printWidth: 88 });
    if (errors.length > 0) throw new Error(`API.md code blocks failed to format: ${errors[0].message}`);
    const chunks = formatted.split(marker + NL).slice(1);
    if (chunks.length !== blocks.length) throw new Error("API.md code blocks lost their markers");
    blocks.forEach((b, i) => {
      b.text = chunks[i]
        .trim()
        .replace(/;$/gm, (semi, offset, all) => (all.startsWith("declare ", offset + 2) || offset === all.length - 1 ? "" : semi))
        .replace(/^declare (function|const) __member/gm, b.name);
    });
  };
  const key = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

  const badges = (path, { unstable, deprecated }) =>
    [
      unstable ? "`unstable`" : "`stable`",
      deprecated !== null ? "`deprecated`" : null,
      since.get(path) ? `since ${since.get(path)}` : since.size ? "unreleased" : null,
    ]
      .filter(Boolean)
      .join(" · ");

  const header = (level, path, info) => [`${"#".repeat(level)} ${path}`, "", badges(path, info), ""];
  const prose = (info) => [
    ...(info.deprecated !== null
      ? [info.deprecated.replace(/^(v\d+\.\d+\.\d+)\.?\s*/, "**Deprecated in $1.** ") || "**Deprecated.**", ""]
      : []),
    ...(info.doc ? [info.doc, ""] : []),
  ];

  const surfaces = withBundle(native, text, ({ checker, source, root }) => {
    const unstableMember = memberUnstable(ts, checker);
    const hopsOf = declarationHops(ts, checker);
    const typeText = (type) => checker.typeToString(type, root, flags);

    // Doc and tags can live on any declaration the member reaches rather than the property symbol.
    const describe = (prop, propType) => {
      const symbols = [prop, propType.getSymbol(), ...hopsOf(prop)].filter(Boolean);
      const doc = symbols.map((s) => s.getDocumentationComment(checker).trim()).find(Boolean);
      const deprecated = symbols
        .flatMap((s) => s.getJsDocTags(checker))
        .find((t) => t.name === "deprecated");
      return {
        doc: doc || "",
        unstable: unstableMember(prop, propType.getSymbol()),
        deprecated: deprecated ? (deprecated.text || "").trim() : null,
      };
    };

    // A destructured parameter prints as its whole binding pattern; `props` reads better.
    // Types are printed as declared, so a named type (`AppSettings`) is not expanded in place.
    const parameter = (p) => {
      const decl = p.valueDeclaration?.resolve();
      if (!decl || !ts.isParameterDeclaration(decl)) return `${p.name}: ${typeText(checker.getTypeOfSymbolAtLocation(p, root))}`;
      const rest = decl.dotDotDotToken ? "..." : "";
      const name = ts.isIdentifier(decl.name) ? p.name : "props";
      const optional = decl.questionToken ? "?" : "";
      const type = decl.type ? decl.type.getText() : typeText(checker.getTypeOfSymbolAtLocation(p, root));
      return `${rest}${name}${optional}: ${type}`;
    };
    const signature = (name, type) => {
      const sigs = callSignatures(ts, checker, type);
      if (!sigs.length && type.flags & ts.TypeFlags.Any)
        throw new Error(
          `${name} resolved to any: a type it imports did not resolve. Install plugins/types' dependencies (node plugins/build-all.mjs --install).`,
        );
      const declaration = sigs.length
        ? sigs
            .map((sig) => {
              const decl = sig.declaration?.resolve();
              const typeParams = decl?.typeParameters?.length
                ? `<${decl.typeParameters.map((tp) => tp.getText()).join(", ")}>`
                : "";
              const params = sig.getParameters().map(parameter).join(", ");
              const returns = decl?.type
                ? decl.type.getText()
                : typeText(checker.getReturnTypeOfSignature(sig));
              return `declare function __member${typeParams}(${params}): ${returns};`;
            })
            .join(NL)
        : `declare const __member: ${typeText(type)};`;
      return block(name, declaration);
    };

    // An object of plain values (an enum-like const, a defaults table) reads best whole.
    const valueTable = (name, props) => {
      const body = props
        .map((p) => {
          const type = checker.getTypeOfSymbolAtLocation(p, root);
          const { doc } = describe(p, type);
          const comment = doc ? `/** ${doc.replace(/\s*\n\s*/g, " ")} */${NL}` : "";
          return `${comment}${key(p.name)}: ${typeText(type)};`;
        })
        .join(NL);
      return block(name, `declare const __member: {${NL}${body}${NL}};`);
    };

    const entry = (path, prop, propType, level, inheritedUnstable = false) => {
      const info = describe(prop, propType);
      info.unstable ||= inheritedUnstable;
      return {
        lines: [...header(level, path, info), signature(path, propType), "", ...prose(info)],
        unstable: info.unstable,
      };
    };

    // One section per module: api.ts names its alias after the module's file (`PluginStorageApi`),
    // with an underscore where a folder tells two files apart (`Store_QueryApi`).
    const sentence = (word) => word.split(/(?=[A-Z])/).map((w, i) => (i ? w.toLowerCase() : w)).join(" ");
    const groups = [];
    for (const clause of root.heritageClauses || []) {
      for (const node of clause.types) {
        const alias = checker.getSymbolAtLocation(node.expression);
        if (alias) groups.push({
          name: alias.name.replace(/Api$/, "").split("_").map(sentence).join(" / "),
          props: [...checker.getPropertiesOfType(checker.getTypeAtLocation(node))],
        });
      }
    }
    const surfaces = [];
    for (const group of groups) {
      const members = [];
      const props = group.props;
      for (const prop of props.sort((a, b) => a.name.localeCompare(b.name))) {
        const propType = checker.getTypeOfSymbolAtLocation(prop, root);
        // A namespace-like member (e.g. `cmd`) gets its members as sub-entries. Only
        // properties declared in this bundle count -- an array or other lib-typed value
        // must not have its built-in methods enumerated.
        let inner = [];
        if (callSignatures(ts, checker, propType).length === 0 && !checker.isArrayLikeType(propType)) {
          const ownProp = (p) => (p.declarations || []).some((d) => d.path === source.path);
          inner = checker.getPropertiesOfType(propType).filter(ownProp);
        }
        const innerType = (p) => checker.getTypeOfSymbolAtLocation(p, root);
        const info = describe(prop, propType);
        if (inner.length > 0 && inner.some((p) => callSignatures(ts, checker, innerType(p)).length > 0)) {
          members.push({ lines: [...header(3, prop.name, info), ...prose(info)], unstable: info.unstable });
          for (const p of inner.sort((a, b) => a.name.localeCompare(b.name))) {
            members.push(entry(`${prop.name}.${p.name}`, p, innerType(p), 4, info.unstable));
          }
        } else if (inner.length > 3) {
          members.push({
            lines: [...header(3, prop.name, info), valueTable(prop.name, inner), "", ...prose(info)],
            unstable: info.unstable,
          });
        } else {
          members.push(entry(prop.name, prop, propType, 3));
        }
      }
      if (members.length === 0) continue;
      surfaces.push({
        name: group.name,
        members,
        unstable: members.every((m) => m.unstable),
      });
    }
    return surfaces;
  });

  await formatBlocks();
  const render = (line) => (typeof line === "string" ? line : ["```ts", line.text, "```"].join(NL));
  const anchor = (s) => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
  const stable = surfaces.filter((s) => !s.unstable);
  const unstable = surfaces.filter((s) => s.unstable);
  const toc = (list) => list.map((s) => `- [${s.name}](#${anchor(s.name)})`);
  const section = (s) => [
    `## ${s.name}`,
    "",
    ...s.members.flatMap((m) => m.lines.map(render)),
  ];
  const md = [
    "# MMA API reference",
    "",
    "Every member of the global `MMA` object (also `window.MMA`), grouped by the file that declares it.",
    "",
    "- `stable` members keep working across releases. A rename or removal ships with a shim.",
    "- `unstable` members are documented but can change or disappear in any release.",
    "- `since` is the first release a member shipped in: the `minAppVersion` a plugin using it needs.",
    "",
    "## Contents",
    "",
    "**Stable surfaces**",
    "",
    ...toc(stable),
    "",
    "**Unstable surfaces**",
    "",
    ...toc(unstable),
    "",
    ...stable.flatMap(section),
    "# Unstable surfaces",
    "",
    "Everything below can change in any release.",
    "",
    ...unstable.flatMap(section),
  ].join(NL);
  console.log(`Generated plugins/types/API.md (${stable.length} stable, ${unstable.length} unstable surfaces)`);
  return md;
}

module.exports = { assembleApi, firstReleases, generateApiMarkdown, propagateUnstable, stripInternal };
if (require.main === module) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
