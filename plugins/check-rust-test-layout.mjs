import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function mask(source) {
  const chars = source.split("");
  const blank = (a, b) => {
    for (let i = a; i < b; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  for (let i = 0; i < chars.length;) {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? chars.length : end);
      i = end < 0 ? chars.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1,
        end = i + 2;
      while (end < chars.length && depth) {
        if (source.startsWith("/*", end)) {
          depth++;
          end += 2;
        } else if (source.startsWith("*/", end)) {
          depth--;
          end += 2;
        } else end++;
      }
      blank(i, end);
      i = end;
      continue;
    }
    const raw = source.slice(i).match(/^(?:b|c)?r(#+)?"/);
    if (raw) {
      const close = `"${raw[1] ?? ""}`;
      const at = source.indexOf(close, i + raw[0].length);
      const end = at < 0 ? chars.length : at + close.length;
      blank(i, end);
      i = end;
      continue;
    }
    const prefix = source.startsWith('b"', i) || source.startsWith('c"', i) ? 1 : 0;
    if (source[i + prefix] === '"') {
      let end = i + prefix + 1;
      while (end < chars.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end++] === '"') break;
      }
      blank(i, end);
      i = end;
      continue;
    }
    if (source[i] === "'") {
      const char = source.slice(i).match(/^'(?:\\.|[^'\\\n])'/);
      if (char) {
        blank(i, i + char[0].length);
        i += char[0].length;
        continue;
      }
    }
    i++;
  }
  return chars.join("");
}

export function violations(source) {
  const code = mask(source),
    found = [];
  const lineAt = (index) => source.slice(0, index).split("\n").length;
  for (const pattern of [
    /#\s*\[\s*(?:[A-Za-z_]\w*\s*::\s*)*(?:test|bench|rstest|test_case)\b[^\]]*\]/g,
    /#\s*\[\s*cfg_attr\s*\([^\]]*,\s*(?:[A-Za-z_]\w*\s*::\s*)*(?:test|bench|rstest|test_case)\b[^\]]*\]/g,
  ]) {
    for (const match of code.matchAll(pattern))
      found.push({ line: lineAt(match.index), reason: "test attribute" });
  }
  for (const match of code.matchAll(
    /#\s*\[\s*cfg\s*\((?:test|(?:all)\s*\([^)]*\btest\b[^)]*\))\s*\)\s*\]/g,
  )) {
    let cursor = match.index + match[0].length;
    while (cursor < code.length) {
      while (/\s/.test(code[cursor] ?? "")) cursor++;
      const attr = code.slice(cursor).match(/^#\s*\[[^\]]*\]/);
      if (!attr) break;
      cursor += attr[0].length;
    }
    const declaration = code
      .slice(cursor)
      .match(/^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+[A-Za-z_]\w*\s*([;{])/);
    if (declaration?.[1] === "{")
      found.push({ line: lineAt(match.index), reason: "inline cfg(test) module" });
  }
  return found.sort((a, b) => a.line - b.line);
}

function rustFiles(dir, skipDirs = new Set(["tests", "target", "node_modules"])) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !skipDirs.has(entry.name))
        files.push(...rustFiles(path, skipDirs));
    } else if (
      entry.name.endsWith(".rs") &&
      !entry.name.endsWith(".test.rs") &&
      !entry.name.endsWith(".bench.rs")
    )
      files.push(path);
  }
  return files;
}

function pluginRustFiles() {
  return readdirSync(join(root, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => {
      const dir = join(root, "plugins", entry.name, "sidecar", "src");
      return existsSync(dir) ? rustFiles(dir) : [];
    });
}
function checkedFiles() {
  const crates = join(root, "app", "src-tauri", "crates");
  return [
    ...rustFiles(join(root, "app", "src-tauri", "src")),
    ...rustFiles(crates, new Set(["specta", "tauri-specta", "tests", "target", "node_modules"])),
    ...pluginRustFiles(),
  ];
}

function main() {
  const errors = [];
  for (const file of checkedFiles()) {
    const rel = relative(root, file).replaceAll("\\", "/");
    for (const item of violations(readFileSync(file, "utf8")))
      errors.push(`${rel}:${item.line}: ${item.reason}; move tests to a .test.rs file`);
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Rust test layout ok");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
