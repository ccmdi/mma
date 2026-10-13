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

const {
  storage,
  mapStorage,
  Scene,
  resolveIds,
  selectorForPick,
  getScenePositions,
  getMapHost,
  on,
} = MMA;

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

/** The setup every map shares until it saves its own. */
const sharedStore = storage("heatmap");

function project<T>(key: string): T | undefined {
  return mapStorage("heatmap").get<T | undefined>(key, sharedStore.get<T>(key));
}

function saveProject(key: string, value: unknown) {
  void mapStorage("heatmap").set(key, value);
}

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
  const layer = { ...newLayer(), ...stored };
  const source = migrateSource(stored.source);
  if (source) layer.source = source;
  return layer;
}

function loadLayers(): HeatmapLayerSettings[] {
  const stored = project<Partial<HeatmapLayerSettings>[]>("layers");
  if (stored?.length) return stored.map(migrateLayer);
  return [newLayer()];
}

function loadGradients(): HeatmapGradient[] {
  return (project<HeatmapGradient[]>("gradients") ?? []).map(
    normalizeGradient,
  );
}

let overlay: DeckOverlayHandle | null = null;
let layers: HeatmapLayerSettings[] = [];
let customGradients: HeatmapGradient[] = [];
let onSettingsChange: (() => void) | null = null;

export function getLayers(): HeatmapLayerSettings[] {
  return layers;
}

export function getCustomGradients(): HeatmapGradient[] {
  return customGradients;
}

export function setOnSettingsChange(cb: (() => void) | null) {
  onSettingsChange = cb;
}

function commit() {
  saveProject("layers", layers);
  rebuild();
  onSettingsChange?.();
}

export function updateLayer(id: string, patch: Partial<HeatmapLayerSettings>) {
  layers = layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
  commit();
}

export function addLayer() {
  layers = [...layers, newLayer()];
  commit();
}

export function removeLayer(id: string) {
  layers = layers.filter((l) => l.id !== id);
  commit();
}

export function resetProject() {
  layers = [newLayer()];
  customGradients = [];
  commitGradients();
}

function commitGradients() {
  saveProject("gradients", customGradients);
  commit();
}

/** Adds an editable copy of `from` and points `layerId` at it. Returns the new gradient. */
export function addCustomGradient(
  layerId: string,
  from: HeatmapGradient,
): HeatmapGradient {
  const gradient = newCustomGradient(from);
  customGradients = [...customGradients, gradient];
  layers = layers.map((l) =>
    l.id === layerId ? { ...l, gradientId: gradient.id } : l,
  );
  commitGradients();
  return gradient;
}

export function updateCustomGradient(
  id: string,
  patch: Partial<Omit<HeatmapGradient, "id">>,
) {
  if (isBuiltinGradient(id)) return;
  customGradients = customGradients.map((g) =>
    g.id === id ? { ...g, ...patch } : g,
  );
  commitGradients();
}

export function removeCustomGradient(id: string) {
  customGradients = customGradients.filter((g) => g.id !== id);
  // Layers always point at a gradient that exists, so the swatch grid can't end up
  // with nothing selected.
  layers = layers.map((l) =>
    l.gradientId === id ? { ...l, gradientId: DEFAULT_GRADIENT_ID } : l,
  );
  commitGradients();
}

async function sourceData(source: SelectorPick): Promise<LatLng[]> {
  // "all" skips the resolve entirely: no id set means no filtering.
  const ids =
    source.pick === "all"
      ? null
      : new Set(await resolveIds(selectorForPick(source)));
  const scene = getScenePositions();
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

  const visible = layers.filter((l) => l.visible);
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
          resolveGradient(l.gradientId, customGradients).stops,
        ),
        debounceTimeout: 100,
      }),
  );

  overlay.setProps({ layers: deckLayers });
}

export function init(): () => void {
  const host = getMapHost();
  if (!host) throw new Error("No map instance");

  layers = loadLayers();
  customGradients = loadGradients();
  overlay = host.createDeckOverlay();
  void rebuild();
  onSettingsChange?.();

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void rebuild(), 100);
    onSettingsChange?.();
  };
  const unsub = on("scene:changed", onChange);

  return () => {
    unsub();
    clearTimeout(rebuildTimer);
    if (overlay) {
      overlay.finalize();
      overlay = null;
    }
    layers = [];
    customGradients = [];
    onSettingsChange = null;
  };
}
