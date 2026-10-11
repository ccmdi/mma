const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

async function generateAndPublish(generate, outputs) {
  const contents = await generate();
  const staged = [];
  try {
    for (const output of outputs) {
      const content = contents[output.key];
      const current = fs.existsSync(output.path) ? fs.readFileSync(output.path) : null;
      if (current && current.equals(Buffer.from(content))) continue;

      const temp = path.join(
        path.dirname(output.path),
        `.${path.basename(output.path)}.${crypto.randomUUID()}.tmp`,
      );
      staged.push({ path: output.path, temp });
      fs.writeFileSync(temp, content);
    }

    for (const file of staged) fs.renameSync(file.temp, file.path);
    return staged.map((file) => file.path);
  } finally {
    for (const file of staged) {
      if (fs.existsSync(file.temp)) fs.rmSync(file.temp, { force: true });
    }
  }
}

module.exports = { generateAndPublish };
