import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import type { DeckOverlayHandle, LatLng, SelectorPick } from "mma-plugin-types";
import {
  DEFAULT_GRADIENT_ID,
  isBuiltinGradient,
  newCustomGradient,
  normalizeGradient,
  resolveGradient,
  sampleColorRange,
  type HeatmapGradient,
} from "./gradients";

const { pluginSetting, Scene, Query, MapHost, selectorForPick, on } = MMA;

export interface HeatmapLayerSettings {
  id: string;
  visible: boolean;
  intensity: number;
  radiusPixels: number;
  opacity: number;
  threshold: number;
  gradientId: string;
  source: SelectorPick;
}

export const LAYER_DEFAULTS: Omit<HeatmapLayerSettings, "id" | "source"> = {
  visible: true,
  intensity: 1,
  radiusPixels: 30,
  opacity: 0.6,
  threshold: 0.05,
  gradientId: DEFAULT_GRADIENT_ID,
};

const project = {
  layers: pluginSetting<Partial<HeatmapLayerSettings>[]>("heatmap", "layers", []).perMap(),
  gradients: pluginSetting<HeatmapGradient[]>("heatmap", "gradients", []).perMap(),
};

function defaultSource(): SelectorPick {
  return Scene.selected().size > 0
    ? { pick: "selection" }
    : { pick: "all" };
}

function newLayer(): HeatmapLayerSettings {
  return {
    id: crypto.randomUUID(),
    source: defaultSource(),
    ...LAYER_DEFAULTS,
  };
}

const FIRST_LAYER: HeatmapLayerSettings = {
  id: "first",
  source: { pick: "all" },
  ...LAYER_DEFAULTS,
};

// Pre-1.2 versions stored the source as the old `{ kind }` scope. A saved-selection
// source is no longer offered and falls back to all locations.
function migrateSource(source: unknown): SelectorPick | undefined {
  if (!source || typeof source !== "object") return undefined;
  if ("pick" in source)
    return source.pick === "saved" ? { pick: "all" } : undefined;
  if (!("kind" in source)) return undefined;
  return source.kind === "selected" ? { pick: "selection" } : { pick: "all" };
}

function migrateLayer(stored: Partial<HeatmapLayerSettings>): HeatmapLayerSettings {
  const layer = { ...FIRST_LAYER, ...stored };
  const source = migrateSource(stored.source);
  if (source) layer.source = source;
  return layer;
}

const layersIn = (stored: Partial<HeatmapLayerSettings>[]): HeatmapLayerSettings[] =>
  stored.length ? stored.map(migrateLayer) : [FIRST_LAYER];

const gradientsIn = (stored: HeatmapGradient[]): HeatmapGradient[] =>
  stored.map(normalizeGradient);

const layers = () => layersIn(project.layers.get());
const customGradients = () => gradientsIn(project.gradients.get());

export const useLayers = () => layersIn(project.layers.use()[0]);
export const useCustomGradients = () => gradientsIn(project.gradients.use()[0]);

function editLayers(edit: (layers: HeatmapLayerSettings[]) => HeatmapLayerSettings[]) {
  project.layers.set(edit(layers()));
}

let overlay: DeckOverlayHandle | null = null;

export function updateLayer(id: string, patch: Partial<HeatmapLayerSettings>) {
  editLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
}

export function addLayer() {
  editLayers((ls) => [...ls, newLayer()]);
}

export function removeLayer(id: string) {
  editLayers((ls) => ls.filter((l) => l.id !== id));
}

export function resetProject() {
  project.layers.set([]);
  project.gradients.set([]);
}

/** Adds an editable copy of `from` and points `layerId` at it. Returns the new gradient. */
export function addCustomGradient(
  layerId: string,
  from: HeatmapGradient,
): HeatmapGradient {
  const gradient = newCustomGradient(from);
  project.gradients.set([...customGradients(), gradient]);
  editLayers((ls) =>
    ls.map((l) => (l.id === layerId ? { ...l, gradientId: gradient.id } : l)),
  );
  return gradient;
}

export function updateCustomGradient(
  id: string,
  patch: Partial<Omit<HeatmapGradient, "id">>,
) {
  if (isBuiltinGradient(id)) return;
  project.gradients.set(
    customGradients().map((g) => (g.id === id ? { ...g, ...patch } : g)),
  );
}

export function removeCustomGradient(id: string) {
  project.gradients.set(customGradients().filter((g) => g.id !== id));
  // Layers always point at a gradient that exists, so the swatch grid can't end up
  // with nothing selected.
  editLayers((ls) =>
    ls.map((l) =>
      l.gradientId === id ? { ...l, gradientId: DEFAULT_GRADIENT_ID } : l,
    ),
  );
}

async function sourceData(source: SelectorPick): Promise<LatLng[]> {
  // "all" skips the resolve entirely: no id set means no filtering.
  const ids =
    source.pick === "all"
      ? null
      : new Set(await Query.read(selectorForPick(source), { kind: "ids" }));
  const scene = Scene.positions();
  const out: LatLng[] = [];
  for (let i = 0; i < scene.ids.length; i++) {
    if (ids && !ids.has(scene.ids[i])) continue;
    out.push({ lng: scene.positions[i * 2], lat: scene.positions[i * 2 + 1] });
  }
  return out;
}

let rebuildToken = 0;

async function rebuild() {
  if (!overlay) return;
  const token = ++rebuildToken;

  const visible = layers().filter((l) => l.visible);
  const gradients = customGradients();
  const datas = await Promise.all(visible.map((l) => sourceData(l.source)));
  if (token !== rebuildToken || !overlay) return;

  const deckLayers = visible.map(
    (l, i) =>
      new HeatmapLayer({
        id: `mma-heatmap-${l.id}`,
        data: datas[i],
        getPosition: (d: LatLng) => [d.lng, d.lat],
        getWeight: 1,
        radiusPixels: l.radiusPixels,
        intensity: l.intensity,
        threshold: l.threshold,
        opacity: l.opacity,
        colorRange: sampleColorRange(
          resolveGradient(l.gradientId, gradients).stops,
        ),
        debounceTimeout: 100,
      }),
  );

  overlay.setProps({ layers: deckLayers });
}

export function init(): () => void {
  const host = MapHost.get();
  if (!host) throw new Error("No map instance");

  overlay = host.createDeckOverlay();
  void rebuild();

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const rebuildSoon = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void rebuild(), 100);
  };
  const offs = [
    on("scene:changed", rebuildSoon),
    project.layers.on(() => void rebuild()),
    project.gradients.on(() => void rebuild()),
  ];

  return () => {
    offs.forEach((off) => off());
    clearTimeout(rebuildTimer);
    if (overlay) {
      overlay.finalize();
      overlay = null;
    }
  };
}
