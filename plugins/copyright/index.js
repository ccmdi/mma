// copyright/src/index.ts
var BINARY_NAME = "mma-copyright";
var IS_WIN = navigator.userAgent.includes("Windows");
var SEP = IS_WIN ? "\\" : "/";
var _pluginDir = null;
async function pluginDir() {
  if (!_pluginDir) {
    const appData = await MMA.cmd.getAppDataDir();
    _pluginDir = `${appData}${SEP}plugins${SEP}copyright`;
  }
  return _pluginDir;
}
async function modelDir() {
  return `${await pluginDir()}${SEP}sidecar${SEP}models`;
}
var tempCounter = 0;
async function writeInputFile(data) {
  const name = `mma_copyright_${Date.now()}_${tempCounter++}.json`;
  return MMA.cmd.writeTempFile(name, JSON.stringify(data));
}
var FIELD_DEFS = {
  copyrightYear: { type: "number", label: "Copyright year" }
};
function fieldRequested(enrichFields) {
  return !enrichFields || enrichFields.includes("copyrightYear");
}
function usableLocations(locations, enrichFields, force) {
  if (!fieldRequested(enrichFields)) return [];
  return locations.filter(
    (l) => typeof l.panoId === "string" && l.panoId.length > 0 && (force || l.extra?.copyrightYear == null)
  );
}
async function enrich(locations, enrichFields, ctx) {
  const patches = /* @__PURE__ */ new Map();
  const usable = usableLocations(locations, enrichFields, ctx?.force);
  if (usable.length === 0 || ctx?.signal?.aborted) return patches;
  const idsByPano = /* @__PURE__ */ new Map();
  for (const loc of usable) {
    const panoId = loc.panoId;
    const ids = idsByPano.get(panoId);
    if (ids) ids.push(loc.id);
    else idsByPano.set(panoId, [loc.id]);
  }
  const panoIds = Array.from(idsByPano.keys());
  const inputPath = await writeInputFile({ panoIds });
  const md = await modelDir();
  const proc = await MMA.sidecar.spawn("copyright", BINARY_NAME, [
    "detect",
    "--input",
    inputPath,
    "--model-dir",
    md
  ]);
  const abortHandler = () => proc.kill();
  ctx?.signal?.addEventListener("abort", abortHandler);
  proc.onStderr((line) => console.error("[copyright]", line));
  proc.onLine((line) => {
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      return;
    }
    const ids = idsByPano.get(result.panoId);
    if (!ids) return;
    for (const id of ids) {
      if (result.error) {
        ctx?.onFail?.(id);
      } else if (result.year != null) {
        patches.set(id, { copyrightYear: result.year });
      }
      ctx?.onUnit?.();
    }
  });
  await new Promise((resolve) => proc.onExit(() => resolve()));
  ctx?.signal?.removeEventListener("abort", abortHandler);
  return patches;
}
MMA.registerPlugin({
  activate() {
    MMA.registerEnrichFields([
      { key: "copyrightYear", label: "Copyright year" }
    ]);
    MMA.registerEnrichmentProvider({
      id: "copyright",
      label: "Copyright year",
      enrich,
      fieldDefs: FIELD_DEFS,
      units: (locations, enrichFields, force) => usableLocations(locations, enrichFields, force).length,
      transform(_field, value, loc) {
        if (loc.extra?.imageDate && Number(loc.extra.imageDate.slice(0, 4)) > Number(value)) return null;
        return `\xA9 ${value}`;
      }
    });
  },
  comingSoon: true
});
