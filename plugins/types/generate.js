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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
