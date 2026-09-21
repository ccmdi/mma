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

// mma-ext:@deck.gl/layers
var require_layers = __commonJS({
  "mma-ext:@deck.gl/layers"(exports, module) {
    module.exports = globalThis.__mma_require("@deck.gl/layers");
  }
});

// mma-ext:react/jsx-runtime
var require_jsx_runtime = __commonJS({
  "mma-ext:react/jsx-runtime"(exports, module) {
    module.exports = globalThis.__mma_require("react/jsx-runtime");
  }
});

// sunPosition/src/index.tsx
var import_react = __toESM(require_react());
var import_layers = __toESM(require_layers());
var import_jsx_runtime = __toESM(require_jsx_runtime());
var {
  registerPlugin,
  registerProvider,
  waitForMapHost,
  fetchColumns,
  on,
  storage,
  usePluginState,
  ui: { Sidebar, Section, SwitchRow, Field, Slider, ColorPicker }
} = MMA;
var PLUGIN_ID = "sunPosition";
var RAYS_KEY = "showRays";
var LENGTH_KEY = "rayLength";
var COLOR_KEY = "rayColor";
var DEFAULT_LENGTH = 28;
var LENGTH_RANGE = { min: 8, max: 96 };
var DEFAULT_COLOR = [255, 179, 0];
var WORLD_PX = 256;
var RAD = Math.PI / 180;
var FIELDS = {
  sunAzimuth: {
    type: "number",
    label: "Sun azimuth",
    values: null,
    comparison: { type: "circular", period: 360 }
  },
  sunAltitude: {
    type: "number",
    label: "Sun altitude",
    values: null,
    comparison: null
  }
};
var ENRICHED = { type: "Filter", field: "sunAzimuth", test: { op: "has" } };
function sunIsUp(altitude) {
  return typeof altitude === "number" && altitude > 0;
}
function rayLength(value) {
  const px = Math.round(Number(value));
  return Number.isFinite(px) && px > 0 ? px : DEFAULT_LENGTH;
}
function isRgb(value) {
  return Array.isArray(value) && value.length === 3 && value.every((c) => Number.isInteger(c) && c >= 0 && c <= 255);
}
function rayColor(value) {
  return isRgb(value) ? value : DEFAULT_COLOR;
}
var NO_RAYS = { source: new Float64Array(0), bearing: new Float64Array(0) };
function daylightRays(lats, lngs, azimuths, altitudes) {
  const source = new Float64Array(lats.length * 2);
  const bearing = new Float64Array(lats.length);
  let n = 0;
  for (let i = 0; i < lats.length; i++) {
    const lat = lats[i];
    const lng = lngs[i];
    const azimuth = azimuths[i];
    if (typeof lat !== "number" || typeof lng !== "number" || typeof azimuth !== "number") continue;
    if (!sunIsUp(altitudes[i])) continue;
    source[n * 2] = lng;
    source[n * 2 + 1] = lat;
    bearing[n] = azimuth;
    n++;
  }
  return { source: source.subarray(0, n * 2), bearing: bearing.subarray(0, n) };
}
function rayTargets(rays2, lengthPx, zoom) {
  const world = WORLD_PX * 2 ** zoom;
  const target = new Float64Array(rays2.source.length);
  for (let i = 0; i < rays2.bearing.length; i++) {
    const lng = rays2.source[i * 2];
    const sin = Math.sin(rays2.source[i * 2 + 1] * RAD);
    const theta = rays2.bearing[i] * RAD;
    const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) - lengthPx * Math.cos(theta) / world;
    target[i * 2] = lng + 360 * lengthPx * Math.sin(theta) / world;
    target[i * 2 + 1] = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;
  }
  return target;
}
var overlay = null;
var rays = NO_RAYS;
function draw(host) {
  const stored = storage(PLUGIN_ID);
  const color = [...rayColor(stored.get(COLOR_KEY)), 255];
  overlay?.setProps({
    layers: [
      new import_layers.LineLayer({
        id: `${PLUGIN_ID}-rays`,
        data: {
          length: rays.bearing.length,
          attributes: {
            getSourcePosition: { value: rays.source, size: 2 },
            getTargetPosition: {
              value: rayTargets(rays, rayLength(stored.get(LENGTH_KEY)), host.getZoom()),
              size: 2
            }
          }
        },
        getColor: color,
        getWidth: 2,
        widthUnits: "pixels"
      })
    ]
  });
}
var redraw = null;
var loadToken = 0;
async function load(host) {
  const token = ++loadToken;
  const [lats, lngs, azimuths, altitudes] = await fetchColumns(ENRICHED, [
    "lat",
    "lng",
    "sunAzimuth",
    "sunAltitude"
  ]);
  if (token !== loadToken || !overlay) return;
  rays = daylightRays(lats, lngs, azimuths, altitudes);
  draw(host);
}
var DATA_EVENTS = [
  "location:add",
  "location:remove",
  "location:update",
  "location:invalidate"
];
function start(host) {
  overlay = host.createDeckOverlay();
  void load(host);
  let reloadTimer;
  const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load(host), 100);
  };
  redraw = () => draw(host);
  const unsubs = [...DATA_EVENTS.map((event) => on(event, reload)), host.on("zoom", redraw)];
  return () => {
    for (const unsub of unsubs) unsub();
    clearTimeout(reloadTimer);
    overlay?.finalize();
    overlay = null;
    redraw = null;
    rays = NO_RAYS;
  };
}
var showing = false;
var stop = null;
function showRays(visible) {
  if (visible === showing) return;
  showing = visible;
  if (!visible) {
    stop?.();
    stop = null;
    return;
  }
  void waitForMapHost().then((host) => {
    if (showing && !stop) stop = start(host);
  });
}
function useRayStyle(key, parse) {
  const [value, setValue] = (0, import_react.useState)(() => parse(storage(PLUGIN_ID).get(key)));
  const set = (next) => {
    setValue(next);
    storage(PLUGIN_ID).set(key, next);
    redraw?.();
  };
  return [value, set];
}
function SunSidebar({ onClose }) {
  const [visible, setVisible] = usePluginState(PLUGIN_ID, RAYS_KEY, false);
  const [length, setLength] = useRayStyle(LENGTH_KEY, rayLength);
  const [color, setColor] = useRayStyle(COLOR_KEY, rayColor);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Sidebar, { title: "Sun Position", onBack: onClose, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: "Overlay", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      SwitchRow,
      {
        label: "Sun rays",
        checked: visible,
        onChange: (value) => {
          setVisible(value);
          showRays(value);
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "Length", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Slider,
      {
        min: LENGTH_RANGE.min,
        max: LENGTH_RANGE.max,
        value: length,
        onChange: (e) => setLength(rayLength(e.target.value)),
        format: (v) => `${v}px`
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "Color", row: true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ColorPicker, { color, onChange: setColor, ariaLabel: "Ray color" }) })
  ] }) });
}
registerPlugin({
  sidebar: SunSidebar,
  activate() {
    registerProvider({
      id: PLUGIN_ID,
      label: "Sun position",
      fieldDefs: FIELDS,
      requires: ["datetime"],
      procedure: {
        entry: "procedure.js",
        batch: { mode: "chunk", size: 1e4 }
      }
    });
    showRays(storage(PLUGIN_ID).get(RAYS_KEY, false));
    return () => showRays(false);
  }
});
export {
  daylightRays,
  rayColor,
  rayLength,
  rayTargets,
  showRays,
  sunIsUp
};
