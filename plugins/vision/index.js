var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// mma-ext:react
var require_react = __commonJS({
  "mma-ext:react"(exports, module) {
    module.exports = globalThis.__mma_require("react");
  }
});

// mma-ext:react/jsx-runtime
var require_jsx_runtime = __commonJS({
  "mma-ext:react/jsx-runtime"(exports, module) {
    module.exports = globalThis.__mma_require("react/jsx-runtime");
  }
});

// vision/src/VisionSidebar.tsx
var import_react = __toESM(require_react());

// vision/src/sidecar.ts
var { svMetadata, sidecar } = MMA;
async function resolveWorldSizes(panoIds, onProgress) {
  const BATCH = 200;
  const entries = [];
  for (let i = 0; i < panoIds.length; i += BATCH) {
    const batch = panoIds.slice(i, i + BATCH);
    const metas = await svMetadata(batch);
    for (let j = 0; j < batch.length; j++) {
      const ws = metas[j]?.worldSize;
      entries.push({
        panoId: batch[j],
        worldWidth: ws?.width ?? 6656,
        worldHeight: ws?.height ?? 3328
      });
    }
    onProgress?.(Math.min(i + BATCH, panoIds.length), panoIds.length);
  }
  return entries;
}
async function listCached() {
  const ids = await sidecar.request("vision", "list-cached");
  return new Set(ids ?? []);
}
async function embed(panoIds, opts = {}) {
  opts.onStatus?.("Checking cache...");
  const cached = await listCached();
  const uncached = panoIds.filter((id) => !cached.has(id));
  if (uncached.length === 0) {
    opts.onStatus?.(`All ${panoIds.length} panos cached`);
    return;
  }
  opts.onStatus?.(`Fetching metadata for ${uncached.length} uncached panos...`);
  const panos = await resolveWorldSizes(uncached, (done, total) => {
    opts.onStatus?.(`Metadata: ${done}/${total}`);
  });
  await sidecar.request(
    "vision",
    "embed",
    { panos },
    {
      signal: opts.signal,
      onLog: (line) => {
        if (line.startsWith("[vision]")) opts.onStatus?.(line);
        else opts.onDiagnostic?.(line);
      },
      onLine: (s) => {
        if (s.status === "error") opts.onFailed?.(s.panoId, s.error);
        else opts.onUnit?.(s.status === "cache_hit" ? s.done ?? 1 : 1);
      }
    }
  );
}
async function searchText(query, k, threshold, signal, onDiagnostic) {
  const res = await sidecar.request(
    "vision",
    "search-text",
    { query, k, threshold },
    {
      signal,
      onLog: (line) => {
        if (!line.startsWith("[vision]")) onDiagnostic?.(line);
      }
    }
  );
  return res?.results ?? [];
}
async function searchImage(panoId, k, threshold, signal) {
  const res = await sidecar.request(
    "vision",
    "search-image",
    { panoId, k, threshold },
    { signal }
  );
  return res?.results ?? [];
}

// vision/src/VisionSidebar.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime());
var { ui: { Sidebar, Field, TextInput, Button }, useJob, fetchAllLocations, addSelections } = MMA;
var MAX_SCORE = 0.3;
var CSS = `
.vision-sidebar__body { padding: 8px 12px; display: flex; flex-direction: column; gap: 10px; }
.vision-sidebar__progress { font-size: 12px; color: var(--text-secondary, #999); padding: 4px 0; }
.vision-sidebar__error { font-size: 12px; color: #e55; padding: 4px 0; }
.vision-sidebar__actions { display: flex; gap: 6px; margin-top: 4px; }

.vision-result { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px; background: var(--surface-1, #2d2d28); }
.vision-result__headline { font-size: 13px; }
.vision-result__count { font-size: 15px; font-weight: 600; }
.vision-result__note { font-size: 11px; color: var(--text-secondary, #999); }
.vision-result__warn { font-size: 11px; color: #eaa; }
.vision-meter { position: relative; height: 6px; border-radius: 3px; background: var(--surface-3, #403f38); }
.vision-meter__fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--accent, #1098ad); }
.vision-meter__cut { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--text-1, #f4f3ef); }
.vision-scale { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-secondary, #999); }
`;
function panoIdToLocId(locs, panoId) {
  const loc = locs.find((l) => l.panoId === panoId);
  return loc?.id ?? null;
}
var pct = (v) => `${Math.min(100, v / MAX_SCORE * 100)}%`;
function ScoreMeter({ top, cut }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "vision-meter", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-meter__fill", style: { width: pct(top) } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-meter__cut", style: { left: pct(cut) } })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "vision-scale", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
        "best ",
        top.toFixed(3)
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
        "cut ",
        cut.toFixed(3)
      ] })
    ] })
  ] });
}
function Result({ outcome }) {
  const { selected, elsewhere, top, cut, failed, notes } = outcome;
  const belowCut = top !== null && top < cut;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "vision-result", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-result__headline", children: selected > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "vision-result__count", children: selected }),
      " location",
      selected === 1 ? "" : "s",
      " selected"
    ] }) : top === null ? "Nothing in the corpus scored against that" : belowCut ? "No matches above the threshold" : "No matches in this map" }),
    top !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScoreMeter, { top, cut }),
    elsewhere > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "vision-result__note", children: [
      elsewhere,
      " match",
      elsewhere === 1 ? "" : "es",
      " in other maps -- the embed cache spans every map"
    ] }),
    selected === 0 && belowCut && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-result__note", children: "Lower the threshold to reach it." }),
    failed > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "vision-result__warn", children: [
      failed,
      " pano",
      failed === 1 ? "" : "s",
      " failed to embed and are not in the search"
    ] }),
    notes.map((n) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-result__warn", children: n }, n))
  ] });
}
function VisionSidebar({ onClose }) {
  const [query, setQuery] = (0, import_react.useState)("");
  const [threshold, setThreshold] = (0, import_react.useState)(0.01);
  const job = useJob(async ({ signal, report }) => {
    const q = query.trim();
    const cut = threshold;
    const locs = await fetchAllLocations();
    signal.throwIfAborted();
    const panoIds = locs.filter((l) => l.panoId).map((l) => l.panoId);
    if (panoIds.length === 0) throw new Error("No locations with pano IDs");
    let embedded = 0;
    let failed = 0;
    const notes = [];
    const note = (line) => {
      if (!notes.includes(line)) notes.push(line);
    };
    const start = Date.now();
    await embed(panoIds, {
      signal,
      onStatus: report,
      onUnit: (count) => {
        embedded += count;
        const elapsed = (Date.now() - start) / 1e3;
        const rate = elapsed > 0.5 ? (embedded / elapsed).toFixed(1) : "--";
        report(`Embedding: ${embedded}/${panoIds.length} (${rate} panos/s)`);
      },
      onFailed: () => failed++,
      onDiagnostic: note
    });
    signal.throwIfAborted();
    report(`Searching for "${q}"...`);
    const results = await searchText(q, null, cut, signal, note);
    const matchedIds = results.map((r) => panoIdToLocId(locs, r.panoId)).filter((id) => id != null);
    if (matchedIds.length > 0) {
      await addSelections([
        { type: "Locations", locations: matchedIds, name: `Vision: "${q}"` }
      ]);
    }
    const top = results[0]?.score ?? (await searchText(q, 1, null, signal, note))[0]?.score ?? null;
    return {
      selected: matchedIds.length,
      elsewhere: results.length - matchedIds.length,
      top,
      cut,
      failed,
      notes
    };
  });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Sidebar, { title: "Vision", onBack: onClose, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: CSS }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "vision-sidebar__body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "Search for", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        TextInput,
        {
          placeholder: "cars, snow, indoor...",
          value: query,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && !job.running && query.trim()) job.run();
          }
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: `Min confidence: ${threshold.toFixed(3)}`, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "range",
          min: 0,
          max: MAX_SCORE,
          step: 5e-3,
          value: threshold,
          onChange: (e) => setThreshold(Number(e.target.value)),
          style: { width: "100%" }
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-sidebar__actions", children: !job.running ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { variant: "primary", disabled: !query.trim(), onClick: job.run, children: "Search" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { onClick: job.cancel, children: "Cancel" }) }),
      job.progress && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-sidebar__progress", children: job.progress }),
      job.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "vision-sidebar__error", children: job.error }),
      job.result !== null && !job.running && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Result, { outcome: job.result })
    ] })
  ] });
}

// vision/src/FindSimilarButton.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
var { ui: { Button: Button2 }, getMapState, useJob: useJob2, fetchAllLocations: fetchAllLocations2, addSelections: addSelections2 } = MMA;
var SIMILARITY_THRESHOLD = 0.85;
var statusStyle = { fontSize: 12, color: "var(--text-secondary, #999)", padding: "4px 0" };
function FindSimilarButton() {
  const active = getMapState().activeLocation;
  const panoId = active?.panoId;
  const job = useJob2(async ({ signal, report }) => {
    const locs = await fetchAllLocations2();
    signal.throwIfAborted();
    const panoIds = locs.filter((l) => l.panoId).map((l) => l.panoId);
    let embedded = 0;
    let failed = 0;
    const start = Date.now();
    await embed(panoIds, {
      signal,
      onStatus: report,
      onUnit: (count) => {
        embedded += count;
        const elapsed = (Date.now() - start) / 1e3;
        const rate = elapsed > 0.5 ? (embedded / elapsed).toFixed(1) : "--";
        report(`Embedding: ${embedded}/${panoIds.length} (${rate} panos/s)`);
      },
      onFailed: () => failed++
    });
    signal.throwIfAborted();
    report(
      failed > 0 ? `Comparing... (${failed} pano${failed === 1 ? "" : "s"} failed to embed)` : "Comparing..."
    );
    const results = await searchImage(panoId, null, SIMILARITY_THRESHOLD);
    const matchedIds = results.map((r) => locs.find((l) => l.panoId === r.panoId)?.id).filter((id) => id != null);
    if (matchedIds.length > 0) {
      await addSelections2([
        {
          type: "Locations",
          locations: matchedIds,
          name: `Similar to ${panoId.slice(0, 8)}...`
        }
      ]);
    }
    return matchedIds.length;
  });
  if (!panoId) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      Button2,
      {
        small: true,
        style: { width: "100%" },
        onClick: job.running ? job.cancel : job.run,
        children: job.running ? "Cancel" : "Find similar panos"
      }
    ),
    job.progress && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: statusStyle, children: job.progress }),
    job.error && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...statusStyle, color: "#e55" }, children: job.error }),
    job.result !== null && !job.running && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: statusStyle, children: job.result > 0 ? `${job.result} similar` : "No similar panos found" })
  ] });
}

// vision/src/index.tsx
var { registerPlugin } = MMA;
registerPlugin({
  activate() {
  },
  sidebar: VisionSidebar,
  locationPanel: FindSimilarButton,
  comingSoon: true
});
