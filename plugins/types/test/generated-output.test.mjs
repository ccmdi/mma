import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import generatedOutput from "../generated-output.js";
const { generateAndPublish } = generatedOutput;

test("generation failure leaves every published output untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mma-output-test-"));
  try {
    const outputs = ["mma.d.ts", "API.md"].map((name) => ({
      key: name,
      path: path.join(dir, name),
    }));
    for (const output of outputs) fs.writeFileSync(output.path, `before:${output.key}`);
    const before = outputs.map((output) => fs.readFileSync(output.path));

    await assert.rejects(
      generateAndPublish(async () => {
        throw new Error("generation failed");
      }, outputs),
      /generation failed/,
    );

    outputs.forEach((output, i) => assert.deepEqual(fs.readFileSync(output.path), before[i]));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["API.md", "mma.d.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("byte-identical generation leaves published outputs and mtimes unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mma-output-test-"));
  try {
    const outputs = ["mma.d.ts", "API.md"].map((name) => ({
      key: name,
      path: path.join(dir, name),
    }));
    for (const output of outputs) fs.writeFileSync(output.path, `stable:${output.key}`);
    const before = outputs.map((output) => ({
      bytes: fs.readFileSync(output.path),
      mtime: fs.statSync(output.path).mtimeMs,
    }));

    const changed = await generateAndPublish(
      async () => Object.fromEntries(outputs.map((output) => [output.key, `stable:${output.key}`])),
      outputs,
    );

    assert.deepEqual(changed, []);
    outputs.forEach((output, i) => {
      assert.deepEqual(fs.readFileSync(output.path), before[i].bytes);
      assert.equal(fs.statSync(output.path).mtimeMs, before[i].mtime);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changed output replaces the prior file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mma-output-test-"));
  try {
    const output = { key: "mma.d.ts", path: path.join(dir, "mma.d.ts") };
    fs.writeFileSync(output.path, "old declaration");

    const changed = await generateAndPublish(
      async () => ({ [output.key]: "new declaration" }),
      [output],
    );

    assert.deepEqual(changed, [output.path]);
    assert.equal(fs.readFileSync(output.path, "utf-8"), "new declaration");
    assert.deepEqual(fs.readdirSync(dir), ["mma.d.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated deterministic generation publishes the same bytes once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mma-output-test-"));
  try {
    const outputs = ["mma.d.ts", "API.md"].map((name) => ({
      key: name,
      path: path.join(dir, name),
    }));
    const build = async () =>
      Object.fromEntries(outputs.map((output) => [output.key, `generated:${output.key}\n`]));

    const first = await generateAndPublish(build, outputs);
    const bytes = outputs.map((output) => fs.readFileSync(output.path));
    const mtimes = outputs.map((output) => fs.statSync(output.path).mtimeMs);
    const second = await generateAndPublish(build, outputs);

    assert.equal(first.length, 2);
    assert.deepEqual(second, []);
    outputs.forEach((output, i) => {
      assert.deepEqual(fs.readFileSync(output.path), bytes[i]);
      assert.equal(fs.statSync(output.path).mtimeMs, mtimes[i]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("staging failure cleans temporary files before publishing any output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mma-output-test-"));
  try {
    const output = path.join(dir, "mma.d.ts");
    fs.writeFileSync(output, "before");
    await assert.rejects(
      generateAndPublish(
        async () => ({ types: "after", docs: "docs" }),
        [
          { key: "types", path: output },
          { key: "docs", path: path.join(dir, "missing", "API.md") },
        ],
      ),
      /ENOENT/,
    );
    assert.equal(fs.readFileSync(output, "utf8"), "before");
    assert.deepEqual(fs.readdirSync(dir), ["mma.d.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
