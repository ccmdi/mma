// copyright/src/procedure.ts
var PLUGIN_ID = "copyright";
var COMMAND = "detect";
function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function leadingYear(text) {
  const m = typeof text === "string" ? /^\d+/.exec(text) : null;
  return m ? Number(m[0]) : -1;
}
function yearFitsCapture(extra, year) {
  const captured = leadingYear(extra?.imageDate);
  return captured < 0 || captured <= year;
}
function run(rows) {
  if (mma.aborted()) return [];
  const byPano = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (!row.panoId) continue;
    const group = byPano.get(row.panoId);
    if (group) group.push(row);
    else byPano.set(row.panoId, [row]);
  }
  if (byPano.size === 0) return [];
  const payload = JSON.stringify({ panoIds: [...byPano.keys()] });
  const out = [];
  mma.sidecar(PLUGIN_ID, COMMAND, payload, (line) => {
    const parsed = parseLine(line);
    const group = parsed?.panoId ? byPano.get(parsed.panoId) : void 0;
    if (!parsed || !group) return;
    for (const row of group) {
      if (parsed.error) mma.fail(row.id);
      else if (typeof parsed.year === "number" && yearFitsCapture(row.extra, parsed.year))
        out.push({ id: row.id, patch: { extra: { copyrightYear: parsed.year } } });
      mma.progress(1);
    }
  });
  return out;
}
function query(input) {
  if (input.op !== "label" || input.field !== "copyrightYear") {
    throw new Error(`copyright: unknown query`);
  }
  return (input.values ?? []).map((v) => `\xA9 ${v}`);
}
export {
  query,
  run
};
