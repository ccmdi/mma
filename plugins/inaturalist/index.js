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

// mma-ext:@deck.gl/layers
var require_layers = __commonJS({
  "mma-ext:@deck.gl/layers"(exports, module) {
    module.exports = globalThis.__mma_require("@deck.gl/layers");
  }
});

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

// inaturalist/src/inat.ts
var import_layers = __toESM(require_layers());
var TILE_TTL = 5 * 60 * 1e3;
var MAX_TILES = 300;
var MAX_RENDER = 5e4;
var tileCache = /* @__PURE__ */ new Map();
var observationsById = /* @__PURE__ */ new Map();
var overlay = null;
var currentTaxonId = null;
var currentTaxonName = null;
var visible = true;
var listeners = [];
var onUpdate = null;
function setOnUpdate(cb) {
  onUpdate = cb;
}
function getObservations() {
  return Array.from(observationsById.values());
}
function getCurrentTaxon() {
  if (!currentTaxonId) return null;
  return { id: currentTaxonId, name: currentTaxonName ?? "Unknown" };
}
function isVisible() {
  return visible;
}
function toggleVisibility() {
  visible = !visible;
  if (visible) render();
  else overlay?.setProps({ layers: [] });
  onUpdate?.();
}
function clearData() {
  observationsById.clear();
  tileCache.clear();
  currentTaxonId = null;
  currentTaxonName = null;
  overlay?.setProps({ layers: [] });
  onUpdate?.();
}
async function searchTaxa(query) {
  const res = await fetch(
    `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(query)}&per_page=20`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    commonName: t.preferred_common_name ?? null,
    rank: t.rank ?? "",
    count: t.observations_count ?? 0,
    photoUrl: t.default_photo?.square_url ?? null
  }));
}
function selectTaxon(taxon) {
  observationsById.clear();
  tileCache.clear();
  currentTaxonId = taxon.id;
  currentTaxonName = taxon.commonName ?? taxon.name;
  loadViewport();
  onUpdate?.();
}
function importToMap() {
  const obs = getObservations();
  if (obs.length === 0) return 0;
  const locs = obs.map(
    (o) => MMA.createLocation({ lat: o.lat, lng: o.lng, extra: { tags: [o.name] } })
  );
  MMA.addLocations(locs);
  return locs.length;
}
async function init() {
  const host = MMA.getMapHost();
  if (!host) throw new Error("No map instance");
  overlay = host.createDeckOverlay();
  const throttled = throttle(() => loadViewport(), 400);
  listeners = [host.on("camera", throttled)];
  return () => {
    for (const un of listeners) un();
    listeners = [];
    if (overlay) {
      overlay.finalize();
      overlay = null;
    }
    observationsById.clear();
    tileCache.clear();
    currentTaxonId = null;
    currentTaxonName = null;
    onUpdate = null;
  };
}
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn();
      }, ms - (now - last));
    }
  };
}
function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}
function lngToTileX(lng, z) {
  return Math.floor((lng + 180) / 360 * (1 << z));
}
function latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
}
function tileToBbox(x, y, z) {
  const n = 1 << z;
  return {
    west: x / n * 360 - 180,
    east: (x + 1) / n * 360 - 180,
    north: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI,
    south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI
  };
}
function computeTileZoom(mapZoom) {
  return Math.max(1, Math.min(10, Math.floor(mapZoom) - 2));
}
async function fetchTile(taxonId, bbox) {
  const url = `https://api.inaturalist.org/v1/observations?taxon_id=${taxonId}&nelat=${bbox.north}&nelng=${bbox.east}&swlat=${bbox.south}&swlng=${bbox.west}&per_page=200&page=1`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results ?? []).map((d) => {
    const geo = d.geojson;
    return {
      id: d.id,
      lat: geo?.coordinates?.[1],
      lng: geo?.coordinates?.[0],
      name: d.species_guess ?? "Unknown",
      photo: (d.observation_photos?.[0]?.photo?.url ?? "").replace("square", "medium") || null,
      observed_at: d.time_observed_at ?? d.observed_on ?? null
    };
  }).filter((o) => o.lat != null && o.lng != null);
}
async function loadViewport() {
  if (!currentTaxonId || !visible) return;
  const host = MMA.getMapHost();
  if (!host) return;
  const bounds = host.getBounds();
  if (!bounds) return;
  const tz = computeTileZoom(host.getZoom());
  const xMin = lngToTileX(bounds.west, tz);
  const xMax = lngToTileX(bounds.east, tz);
  const yMin = latToTileY(bounds.north, tz);
  const yMax = latToTileY(bounds.south, tz);
  const now = Date.now();
  const fetches = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const key = tileKey(tz, x, y);
      const cached = tileCache.get(key);
      if (cached && cached.expiresAt > now) {
        for (const o of cached.data) observationsById.set(o.id, o);
        continue;
      }
      fetches.push(
        fetchTile(currentTaxonId, tileToBbox(x, y, tz)).then((obs) => {
          tileCache.set(key, { data: obs, expiresAt: Date.now() + TILE_TTL });
          if (tileCache.size > MAX_TILES) {
            const oldest = tileCache.keys().next().value;
            tileCache.delete(oldest);
          }
          for (const o of obs) observationsById.set(o.id, o);
        })
      );
    }
  }
  if (fetches.length > 0) await Promise.all(fetches);
  render();
  onUpdate?.();
}
function render() {
  if (!overlay || !visible) return;
  let data = Array.from(observationsById.values());
  if (data.length > MAX_RENDER) {
    const step = Math.ceil(data.length / MAX_RENDER);
    data = data.filter((_, i) => i % step === 0);
  }
  if (data.length === 0) {
    overlay.setProps({ layers: [] });
    return;
  }
  overlay.setProps({
    layers: [
      new import_layers.ScatterplotLayer({
        id: "inat-observations",
        data,
        getPosition: (d) => [d.lng, d.lat],
        getRadius: 5,
        radiusUnits: "pixels",
        getFillColor: [255, 120, 0, 180],
        pickable: true
      })
    ]
  });
}

// inaturalist/src/INatSidebar.tsx
var import_react2 = __toESM(require_react());

// inaturalist/src/TaxonomySorter.tsx
var import_react = __toESM(require_react());

// inaturalist/src/taxonomy.ts
var API_DELAY = 350;
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
var DEEP_RANKS = [
  "kingdom",
  "subkingdom",
  "phylum",
  "subphylum",
  "superclass",
  "class",
  "subclass",
  "infraclass",
  "superorder",
  "order",
  "suborder",
  "infraorder",
  "superfamily",
  "epifamily",
  "family",
  "subfamily",
  "supertribe",
  "tribe",
  "subtribe",
  "genus",
  "genushybrid",
  "subgenus",
  "section",
  "subsection",
  "complex"
];
var FLAT_RANKS = ["order", "family"];
var RANK_RE = new RegExp(`^(${DEEP_RANKS.join("|")})\\s+`, "i");
var EXACT_RANK_RE = new RegExp(`^(${DEEP_RANKS.join("|")})$`, "i");
function cleanRankPrefix(s) {
  return s.trim().replace(RANK_RE, "").trim();
}
function hasNonAscii(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true;
  }
  return false;
}
function extractScientificName(tagName) {
  const cleanTag = tagName.replace(/\[.*?\]/g, "").trim();
  const baseName = cleanTag.replace(/\s+(var\.|ssp\.|subsp\.|f\.|forma)\s+.*$/i, "").trim();
  const match = baseName.match(/^(.*?)\s*\((.*?)\)/);
  if (match) {
    const p1raw = match[1].trim();
    const p2raw = match[2].trim();
    const p1IsRank = EXACT_RANK_RE.test(p1raw);
    const p2IsRank = EXACT_RANK_RE.test(p2raw);
    if (p2IsRank && !p1IsRank) return cleanRankPrefix(p1raw);
    if (p1IsRank && !p2IsRank) return cleanRankPrefix(p2raw);
    const p1 = cleanRankPrefix(p1raw);
    const p2 = cleanRankPrefix(p2raw);
    const isBinomial = (s) => /^[A-Z][a-z-]+[\s×]+[a-z-]+/.test(s);
    if (isBinomial(p2)) return p2;
    if (isBinomial(p1)) return p1;
    if (!hasNonAscii(p2) && hasNonAscii(p1)) return p2;
    if (!hasNonAscii(p1) && hasNonAscii(p2)) return p1;
    return p2.length > 0 ? p2 : p1;
  }
  const noParen = cleanRankPrefix(baseName);
  if (EXACT_RANK_RE.test(noParen)) return "";
  return noParen;
}
function getCandidates(tagName, primary) {
  const parenMatch = tagName.replace(/\[.*?\]/g, "").match(/\(([^)]+)\)/);
  const parenContent = parenMatch ? parenMatch[1].trim() : null;
  const words = primary.split(/\s+/).filter(Boolean);
  const twoWords = words.length >= 2 ? words.slice(0, 2).join(" ") : null;
  const genusOnly = words.length >= 1 ? words[0] : null;
  const seen = /* @__PURE__ */ new Set();
  return [primary, parenContent, twoWords, genusOnly].filter((c) => {
    if (!c || c.length < 2 || seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}
async function fetchTaxaSearch(query, lang) {
  const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(query)}&per_page=1&locale=${lang}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const result = data.results?.[0];
  if (!result?.ancestor_ids) return null;
  return { ancestorIds: result.ancestor_ids };
}
async function fetchTaxonDetails(ids, lang) {
  const out = /* @__PURE__ */ new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const url = `https://api.inaturalist.org/v1/taxa/${chunk.join(",")}?locale=${lang}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const t of data.results ?? []) {
        let common = t.preferred_common_name || t.english_common_name || "";
        if (common) common = common.charAt(0).toUpperCase() + common.slice(1);
        out.set(t.id, { id: t.id, name: t.name, commonName: common, rank: t.rank });
      }
    } catch {
    }
    if (i + 30 < ids.length) await delay(API_DELAY);
  }
  return out;
}
function buildFolderSegment(taxon, useCommon, seenCommons) {
  const rankCap = taxon.rank.charAt(0).toUpperCase() + taxon.rank.slice(1);
  if (useCommon && taxon.commonName) {
    const cl = taxon.commonName.toLowerCase();
    const nl = taxon.name.toLowerCase();
    const rl = rankCap.toLowerCase();
    if (cl === nl || new RegExp("\\b" + rl + "\\b").test(cl) || seenCommons.has(cl)) {
      return `${rankCap} ${taxon.name}`;
    }
    seenCommons.add(cl);
    return `${taxon.commonName} (${rankCap} ${taxon.name})`;
  }
  return `${rankCap} ${taxon.name}`;
}
async function sortTagsByTaxonomy(opts, onProgress, signal) {
  const storage = MMA.storage("inaturalist");
  const tags = MMA.getVisibleTags();
  if (tags.length === 0) return { sorted: 0, skipped: 0, created: 0 };
  const ancestorCacheKey = "taxo_ancestors";
  const detailCacheKey = `taxo_details_${opts.lang}`;
  const ancestorCache = storage.get(ancestorCacheKey, {});
  const detailCache = storage.get(detailCacheKey, {});
  const ranksToUse = new Set(opts.deep ? DEEP_RANKS : FLAT_RANKS);
  const allNeededIds = /* @__PURE__ */ new Set();
  const tagAncestors = /* @__PURE__ */ new Map();
  for (let i = 0; i < tags.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const tag = tags[i];
    const leafName = tag.name.split("/").pop() ?? tag.name;
    const sciName = extractScientificName(leafName);
    if (!sciName) {
      onProgress?.({ phase: "Scanning", current: i + 1, total: tags.length, detail: `Skipped: ${leafName}` });
      continue;
    }
    const candidates = getCandidates(leafName, sciName);
    let found = null;
    for (const c of candidates) {
      if (ancestorCache[c]) {
        found = { ids: ancestorCache[c], resolvedName: c };
        break;
      }
    }
    if (!found) {
      for (const c of candidates) {
        onProgress?.({ phase: "Querying iNaturalist", current: i + 1, total: tags.length, detail: c });
        const result = await fetchTaxaSearch(c, opts.lang);
        if (result) {
          ancestorCache[c] = result.ancestorIds;
          found = { ids: result.ancestorIds, resolvedName: c };
          break;
        }
        await delay(API_DELAY);
      }
    }
    if (found) {
      tagAncestors.set(tag.id, { ancestors: found.ids, resolvedName: found.resolvedName });
      for (const id of found.ids) allNeededIds.add(id);
    } else {
      onProgress?.({ phase: "Scanning", current: i + 1, total: tags.length, detail: `Not found: ${leafName}` });
    }
  }
  storage.set(ancestorCacheKey, ancestorCache);
  const missingDetailIds = [...allNeededIds].filter((id) => !detailCache[String(id)]);
  if (missingDetailIds.length > 0) {
    onProgress?.({ phase: "Fetching taxonomy details", current: 0, total: missingDetailIds.length });
    const details = await fetchTaxonDetails(missingDetailIds, opts.lang);
    for (const [id, info] of details) {
      detailCache[String(id)] = info;
    }
    storage.set(detailCacheKey, detailCache);
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const renames = [];
  let skipped = 0;
  for (const tag of tags) {
    const entry = tagAncestors.get(tag.id);
    if (!entry) {
      skipped++;
      continue;
    }
    const leafName = tag.name.split("/").pop() ?? tag.name;
    const seenCommons = /* @__PURE__ */ new Set();
    const pathSegments = [];
    for (const ancestorId of entry.ancestors) {
      const taxon = detailCache[String(ancestorId)];
      if (!taxon || !ranksToUse.has(taxon.rank)) continue;
      pathSegments.push(buildFolderSegment(taxon, opts.commonNames, seenCommons));
    }
    if (pathSegments.length === 0) {
      pathSegments.push("Unclassified");
    }
    const newName = [...pathSegments, leafName].join("/");
    if (newName !== tag.name) {
      renames.push({ id: tag.id, name: newName });
    }
  }
  if (renames.length > 0) {
    onProgress?.({ phase: "Renaming tags", current: 0, total: renames.length });
    await MMA.updateTags(renames.map((r) => ({ id: r.id, patch: { name: r.name } })));
  }
  return { sorted: renames.length, skipped, created: 0 };
}
function clearTaxonomyCache() {
  const storage = MMA.storage("inaturalist");
  for (const key of storage.keys()) {
    if (key.startsWith("taxo_")) storage.remove(key);
  }
}

// inaturalist/src/TaxonomySorter.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime());
var LANGUAGES = [
  { code: "en", label: "EN" },
  { code: "fr", label: "FR" },
  { code: "es", label: "ES" },
  { code: "de", label: "DE" },
  { code: "ja", label: "JA" }
];
var INFO_PATH = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z";
function Label({ children, info }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
    children,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "svg",
      {
        width: 13,
        height: 13,
        viewBox: "0 0 24 24",
        fill: "currentColor",
        style: { opacity: 0.35, cursor: "help", flexShrink: 0 },
        "aria-label": info,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("title", { children: info }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: INFO_PATH })
        ]
      }
    )
  ] });
}
var { Section, Field, SegmentedControl } = MMA.ui;
function TaxonomySorter() {
  const storage = MMA.storage("inaturalist");
  const [lang, setLang] = (0, import_react.useState)(() => storage.get("taxo_lang", "en"));
  const [deep, setDeep] = (0, import_react.useState)(true);
  const [commonNames, setCommonNames] = (0, import_react.useState)(true);
  const handleLangChange = (0, import_react.useCallback)((code) => {
    setLang(code);
    storage.set("taxo_lang", code);
  }, [storage]);
  const job = MMA.useJob(async ({ signal, report }) => {
    const opts = { lang, deep, commonNames };
    const r = await sortTagsByTaxonomy(opts, report, signal);
    MMA.toast(
      r.sorted > 0 ? `Sorted ${r.sorted} tag${r.sorted === 1 ? "" : "s"} into taxonomy folders` : "No tags needed sorting"
    );
    return r;
  });
  const handleClearCache = (0, import_react.useCallback)(() => {
    clearTaxonomyCache();
    MMA.toast("Taxonomy cache cleared");
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: "Taxonomy Sorter", defaultOpen: false, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "Language", row: true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      SegmentedControl,
      {
        options: LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
        value: lang,
        onChange: handleLangChange
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Label, { info: "Deep = all taxonomic ranks. Flat = order + family only.", children: "Depth" }), row: true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      SegmentedControl,
      {
        options: [
          { value: "deep", label: "\xA0Deep\xA0" },
          { value: "flat", label: "\xA0Flat\xA0" }
        ],
        value: deep ? "deep" : "flat",
        onChange: (v) => setDeep(v === "deep")
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Label, { info: "Include translated common names from iNaturalist", children: "Common names" }), row: true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        type: "checkbox",
        checked: commonNames,
        onChange: (e) => setCommonNames(e.target.checked)
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 6, marginTop: 4 }, children: [
      job.running ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "button button--danger", onClick: job.cancel, style: { flex: 1 }, children: "Cancel" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "button button--primary", onClick: job.run, style: { flex: 1 }, children: "Sort Tags" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          className: "button",
          onClick: handleClearCache,
          disabled: job.running,
          title: "Clear cached API results",
          children: "Clear Cache"
        }
      )
    ] }),
    job.progress && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 11, color: "var(--text-secondary, #999)", marginTop: 6 }, children: [
      job.progress.phase,
      " (",
      job.progress.current,
      "/",
      job.progress.total,
      ")",
      job.progress.detail && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { opacity: 0.7 }, children: job.progress.detail })
    ] }),
    job.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 11, color: "#e55", marginTop: 6 }, children: job.error }),
    job.result && !job.running && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 11, color: "var(--text-secondary, #999)", marginTop: 6 }, children: [
      job.result.sorted,
      " sorted, ",
      job.result.skipped,
      " skipped"
    ] })
  ] });
}

// inaturalist/src/INatSidebar.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
var CSS = `
.inat-sidebar__search { display: flex; gap: 6px; }
.inat-sidebar__results {
  max-height: 300px; overflow-y: auto;
  border: 1px solid var(--color-divider, #333); border-radius: 4px;
  margin-top: 8px;
}
.inat-sidebar__taxon {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  cursor: pointer; border-bottom: 1px solid var(--color-divider, #333);
  font-size: 13px;
}
.inat-sidebar__taxon:last-child { border-bottom: none; }
.inat-sidebar__taxon:hover { background: rgba(255,255,255,0.05); }
.inat-sidebar__taxon-photo {
  width: 32px; height: 32px; border-radius: 4px; object-fit: cover;
  background: #333; flex-shrink: 0;
}
.inat-sidebar__taxon-info { flex: 1; min-width: 0; }
.inat-sidebar__taxon-name {
  font-weight: 600; font-style: italic; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.inat-sidebar__taxon-meta { font-size: 11px; color: var(--text-secondary, #999); }
.inat-sidebar__active {
  margin-top: 8px; padding: 8px; border-radius: 4px;
  background: rgba(255, 120, 0, 0.1); border: 1px solid rgba(255, 120, 0, 0.3);
}
.inat-sidebar__active-name { font-weight: 600; font-size: 13px; color: #ff7800; }
.inat-sidebar__active-count { font-size: 12px; color: var(--text-secondary, #999); margin-top: 2px; }
.inat-sidebar__actions { display: flex; gap: 6px; margin-top: 8px; }
.inat-sidebar__hint { font-size: 12px; color: var(--text-secondary, #999); margin-top: 4px; }
`;
var styleEl = null;
function injectCSS() {
  if (styleEl) return;
  styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}
function removeCSS() {
  if (styleEl) {
    styleEl.remove();
    styleEl = null;
  }
}
var { Sidebar, Section: Section2 } = MMA.ui;
function INatSidebar({ onClose }) {
  const [query, setQuery] = (0, import_react2.useState)("");
  const [results, setResults] = (0, import_react2.useState)([]);
  const [searching, setSearching] = (0, import_react2.useState)(false);
  const [, bump] = (0, import_react2.useState)(0);
  const refresh = (0, import_react2.useCallback)(() => bump((n) => n + 1), []);
  (0, import_react2.useEffect)(() => {
    injectCSS();
    setOnUpdate(refresh);
    return () => {
      setOnUpdate(null);
      removeCSS();
    };
  }, [refresh]);
  const doSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      setResults(await searchTaxa(q));
    } catch {
      MMA.toast("Failed to search iNaturalist");
    }
    setSearching(false);
  };
  const handleSelect = (taxon2) => {
    selectTaxon(taxon2);
    setResults([]);
    setQuery("");
  };
  const handleImport = () => {
    const n = importToMap();
    if (n > 0) MMA.toast(`Imported ${n} observations as locations`);
    else MMA.toast("No observations to import");
  };
  const taxon = getCurrentTaxon();
  const count = getObservations().length;
  const vis = isVisible();
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Sidebar, { title: "iNaturalist", onBack: onClose, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Section2, { title: "Observations", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "inat-sidebar__search", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            className: "input",
            placeholder: "Search species...",
            value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") doSearch();
              e.stopPropagation();
            },
            style: { flex: 1 }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { className: "button", onClick: doSearch, disabled: searching || !query.trim(), children: searching ? "..." : "Search" })
      ] }),
      results.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "inat-sidebar__results", children: results.map((t) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "inat-sidebar__taxon", onClick: () => handleSelect(t), children: [
        t.photoUrl && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("img", { className: "inat-sidebar__taxon-photo", src: t.photoUrl }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "inat-sidebar__taxon-info", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "inat-sidebar__taxon-name", children: t.name }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "inat-sidebar__taxon-meta", children: [
            t.commonName && `${t.commonName} \xB7 `,
            t.rank,
            " \xB7 ",
            t.count.toLocaleString(),
            " obs"
          ] })
        ] })
      ] }, t.id)) }),
      taxon && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "inat-sidebar__active", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "inat-sidebar__active-name", children: taxon.name }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "inat-sidebar__active-count", children: [
          count.toLocaleString(),
          " observations loaded"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "inat-sidebar__actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { className: "button", onClick: toggleVisibility, disabled: !taxon, children: vis ? "Hide" : "Show" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { className: "button button--primary", onClick: handleImport, disabled: count === 0, children: [
          "Import",
          count > 0 ? ` (${count})` : ""
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { className: "button button--danger", onClick: clearData, disabled: !taxon, children: "Clear" })
      ] }),
      !taxon && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "inat-sidebar__hint", children: "Search for a species to visualize observations on the map." })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TaxonomySorter, {})
  ] });
}

// inaturalist/src/index.tsx
MMA.registerPlugin({
  activate() {
    let cancelled = false;
    let teardown = null;
    (async () => {
      if (cancelled) return;
      teardown = await init();
    })();
    return () => {
      cancelled = true;
      teardown?.();
    };
  },
  sidebar: INatSidebar
});
