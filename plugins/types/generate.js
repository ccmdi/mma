const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const out = path.resolve(__dirname, "mma.d.ts");

execSync(
  `npx dts-bundle-generator --project app/tsconfig.app.json --no-check --external-inlines @tauri-apps/api @tauri-apps/plugin-shell @tauri-apps/plugin-dialog --external-imports react -o "${out}" plugins/types/entrypoint.ts`,
  { cwd: path.resolve(__dirname, "../.."), stdio: "inherit" }
);

let content = fs.readFileSync(out, "utf-8");
content += `\ndeclare global {\n\tconst MMA: typeof mma;\n}\n`;
fs.writeFileSync(out, content);

console.log("Generated plugins/types/mma.d.ts");
