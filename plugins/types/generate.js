// Bundle the plugin type surface (mma.d.ts) from the app's source.
// Two stages: tsc emits real .d.ts files (JSDoc survives declaration emit),
// then rollup-plugin-dts rolls them into one file.
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const appDir = path.join(repoRoot, "app");
const out = path.resolve(__dirname, "mma.d.ts");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mma-dts-"));
  try {
    execSync(
      `npx tsc -p tsconfig.app.json --declaration --emitDeclarationOnly --noEmit false --rootDir src --outDir "${tmp}"`,
      { cwd: appDir, stdio: "inherit" },
    );

    // Hand-written .d.ts sources (google-maps) are not emitted
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
      external: [/^react/, /^@deck\.gl\//, /^@tauri-apps\//, /^maplibre-gl/],
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

    // rollup-plugin-dts appends $1 to names that collide across modules.
    for (const name of ["Location", "Selection", "Plugin", "MMA", "open"]) {
      content = content.replace(new RegExp(`\\b${name}\\$1\\b`, "g"), name);
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
    content =
      `/// <reference types="google.maps" />\n` +
      `/// <reference path="./google-maps.d.ts" />\n\n` +
      content;
    fs.writeFileSync(out, content);
    propagateUnstable();

    // The google.maps namespace augmentation is ambient (position-independent),
    // so it ships verbatim next to mma.d.ts; only the path alias needs remapping.
    const augment = fs
      .readFileSync(path.join(appDir, "src", "types", "google-maps.d.ts"), "utf-8")
      .replace(/import\("@\/[^"]*"\)/g, 'import("./mma")');
    fs.writeFileSync(path.resolve(__dirname, "google-maps.d.ts"), augment);
    console.log("Generated plugins/types/mma.d.ts + google-maps.d.ts");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// `@unstable` is declared once -- on a surface (`type ReviewApi`) or a namespace (`cmd`) --
// but a plugin author hovers the member, not the surface. Stamp it onto every member the
// tag covers so the warning is visible where the call is written.
function propagateUnstable() {
  const ts = require(path.join(appDir, "node_modules", "typescript"));
  const program = ts.createProgram([out], { skipLibCheck: true, target: ts.ScriptTarget.ESNext });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(out);

  let root = null;
  ts.forEachChild(source, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === "MMA") root = n;
  });
  if (!root) throw new Error("no MMA interface in the bundle");

  const tagged = (sym) => sym.getJsDocTags(checker).some((t) => t.name === "unstable");

  // Where a doc comment can actually go. A symbol's declaration is sometimes the type
  // node (`() => void`), which is not a place a reader would ever look.
  const documentable = (d) => {
    if (ts.isVariableDeclaration(d)) return d.parent && d.parent.parent;
    // A const object's type is an anonymous literal; the tag belongs on the const.
    if (ts.isTypeLiteralNode(d) && d.parent && ts.isVariableDeclaration(d.parent)) {
      return documentable(d.parent);
    }
    return ts.isFunctionDeclaration(d) ||
      ts.isPropertySignature(d) ||
      ts.isMethodSignature(d) ||
      ts.isPropertyAssignment(d) ||
      ts.isInterfaceDeclaration(d) ||
      ts.isTypeAliasDeclaration(d)
      ? d
      : null;
  };
  const targets = new Set();

  // Every member a tagged surface contributes.
  const fromUnstableSurface = new Set();
  for (const clause of root.heritageClauses || []) {
    for (const node of clause.types) {
      const alias = checker.getSymbolAtLocation(node.expression);
      if (!alias || !tagged(alias)) continue;
      for (const prop of checker.getPropertiesOfType(checker.getTypeAtLocation(node))) {
        fromUnstableSurface.add(prop.name);
      }
    }
  }

  const collect = (type, depth, inherited) => {
    for (const prop of checker.getPropertiesOfType(type)) {
      const propType = checker.getTypeOfSymbolAtLocation(prop, root);
      const target = propType.getSymbol();
      const unstable =
        inherited ||
        fromUnstableSurface.has(prop.name) ||
        tagged(prop) ||
        (!!target && tagged(target));
      if (unstable) {
        for (const sym of [prop, target]) {
          for (const d of (sym && sym.declarations) || []) {
            const node = documentable(d);
            if (node && node.getSourceFile() === source) targets.add(node);
          }
        }
      }
      if (depth > 0 && propType.getCallSignatures().length === 0) {
        collect(propType, depth - 1, unstable);
      }
    }
  };
  collect(checker.getTypeAtLocation(root), 1, false);

  // Highest offset first, so earlier edits keep their positions.
  const full = source.getFullText();
  const edits = [];
  for (const node of targets) {
    const docs = node.jsDoc;
    if (docs && docs.length) {
      const last = docs[docs.length - 1];
      const text = last.getText();
      if (text.includes("@unstable")) continue;
      // Just before the closing `*/`. On a multi-line block that spot is the start of the
      // closing line, which needs its own ` *  ` prefix; on a one-liner it is mid-line.
      const at = last.getEnd() - 2;
      const lineStart = full.lastIndexOf("\n", at) + 1;
      const indent = full.slice(lineStart, at);
      edits.push(
        indent.trim() === ""
          ? { at, insert: `*  @unstable
${indent}` }
          : { at, insert: "@unstable " },
      );
    } else {
      const start = node.getStart(source);
      const col = start - source.getLineStarts()[source.getLineAndCharacterOfPosition(start).line];
      edits.push({ at: start, insert: `/** @unstable */
${" ".repeat(col)}` });
    }
  }
  edits.sort((a, b) => b.at - a.at);

  let text = fs.readFileSync(out, "utf-8");
  for (const e of edits) text = text.slice(0, e.at) + e.insert + text.slice(e.at);
  fs.writeFileSync(out, text);
  console.log(`Propagated @unstable to ${edits.length} members`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
