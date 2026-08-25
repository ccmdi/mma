export type RGB = [number, number, number];

/** A colour pinned to a point on the ramp. `pos` is 0..1, stops kept sorted by it. */
export interface GradientStop {
  color: RGB;
  pos: number;
}

export interface HeatmapGradient {
  id: string;
  name: string;
  stops: GradientStop[];
}

export const MIN_STOPS = 2;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function evenStops(colors: RGB[]): GradientStop[] {
  if (colors.length === 1) return [{ color: colors[0], pos: 0 }];
  return colors.map((color, i) => ({ color, pos: i / (colors.length - 1) }));
}

const BUILTIN_COLORS: { id: string; name: string; colors: RGB[] }[] = [
  // deck.gl's built-in default colorRange (6-step ColorBrewer YlOrRd) — the original look.
  {
    id: "classic",
    name: "Classic",
    colors: [
      [255, 255, 178],
      [254, 217, 118],
      [254, 178, 76],
      [253, 141, 60],
      [240, 59, 32],
      [189, 0, 38],
    ],
  },
  {
    id: "viridis",
    name: "Viridis",
    colors: [
      [68, 1, 84],
      [59, 82, 139],
      [33, 145, 140],
      [94, 201, 98],
      [253, 231, 37],
    ],
  },
  {
    id: "inferno",
    name: "Inferno",
    colors: [
      [0, 0, 4],
      [87, 16, 110],
      [188, 55, 84],
      [249, 142, 9],
      [252, 255, 164],
    ],
  },
  {
    id: "plasma",
    name: "Plasma",
    colors: [
      [13, 8, 135],
      [126, 3, 168],
      [204, 71, 120],
      [248, 149, 64],
      [240, 249, 33],
    ],
  },
  {
    id: "magma",
    name: "Magma",
    colors: [
      [0, 0, 4],
      [81, 18, 124],
      [183, 55, 121],
      [252, 137, 97],
      [252, 253, 191],
    ],
  },
  {
    id: "cividis",
    name: "Cividis",
    colors: [
      [0, 32, 76],
      [87, 92, 109],
      [170, 156, 116],
      [255, 234, 70],
    ],
  },
  {
    id: "heat",
    name: "Heat",
    colors: [
      [0, 0, 255],
      [0, 255, 255],
      [0, 255, 0],
      [255, 255, 0],
      [255, 0, 0],
    ],
  },
  {
    id: "blue-red",
    name: "Blue-Red",
    colors: [
      [66, 133, 244],
      [234, 67, 53],
    ],
  },
  {
    id: "green-yellow-red",
    name: "Green-Yellow-Red",
    colors: [
      [52, 168, 83],
      [251, 188, 4],
      [234, 67, 53],
    ],
  },
  {
    id: "purple-orange",
    name: "Purple-Orange",
    colors: [
      [136, 84, 208],
      [255, 152, 0],
    ],
  },
  {
    id: "blues",
    name: "Blues",
    colors: [
      [222, 235, 247],
      [158, 202, 225],
      [49, 130, 189],
    ],
  },
  {
    id: "reds",
    name: "Reds",
    colors: [
      [254, 224, 210],
      [252, 146, 114],
      [222, 45, 38],
    ],
  },
  {
    id: "greens",
    name: "Greens",
    colors: [
      [229, 245, 224],
      [161, 217, 155],
      [49, 163, 84],
    ],
  },
  {
    id: "purples",
    name: "Purples",
    colors: [
      [239, 237, 245],
      [188, 189, 220],
      [117, 107, 177],
    ],
  },
];

export const BUILTIN_GRADIENTS: HeatmapGradient[] = BUILTIN_COLORS.map((g) => ({
  id: g.id,
  name: g.name,
  stops: evenStops(g.colors),
}));

export const DEFAULT_GRADIENT_ID = BUILTIN_GRADIENTS[0].id;

const BUILTIN_IDS = new Set(BUILTIN_GRADIENTS.map((g) => g.id));

export function isBuiltinGradient(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/** Layers written before 1.1 referenced gradients by position in BUILTIN_GRADIENTS. */
export function gradientIdFromLegacyIndex(index: unknown): string {
  if (typeof index !== "number") return DEFAULT_GRADIENT_ID;
  return BUILTIN_GRADIENTS[index]?.id ?? DEFAULT_GRADIENT_ID;
}

/** Accepts both stop shapes: 1.1 stored bare colours at implicit even spacing. */
export function normalizeStops(raw: unknown): GradientStop[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (Array.isArray(raw[0])) return evenStops(raw as RGB[]);
  return (raw as GradientStop[])
    .filter((s) => s && Array.isArray(s.color))
    .map((s) => ({
      color: [...s.color] as RGB,
      pos: clamp01(Number(s.pos) || 0),
    }))
    .sort((a, b) => a.pos - b.pos);
}

export function normalizeGradient(g: HeatmapGradient): HeatmapGradient {
  return { ...g, stops: normalizeStops(g.stops) };
}

export function resolveGradient(
  id: string,
  customs: HeatmapGradient[],
): HeatmapGradient {
  return (
    BUILTIN_GRADIENTS.find((g) => g.id === id) ??
    customs.find((g) => g.id === id) ??
    BUILTIN_GRADIENTS[0]
  );
}

export function newCustomGradient(from: HeatmapGradient): HeatmapGradient {
  return {
    id: crypto.randomUUID(),
    name: `${from.name} copy`,
    stops: from.stops.map((s) => ({ color: [...s.color] as RGB, pos: s.pos })),
  };
}

export function colorAt(stops: GradientStop[], t: number): RGB {
  if (stops.length === 0) return [0, 0, 0];
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t <= first.pos) return first.color;
  if (t >= last.pos) return last.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t > b.pos) continue;
    const span = b.pos - a.pos;
    const f = span <= 0 ? 0 : (t - a.pos) / span;
    return [
      Math.round(a.color[0] + (b.color[0] - a.color[0]) * f),
      Math.round(a.color[1] + (b.color[1] - a.color[1]) * f),
      Math.round(a.color[2] + (b.color[2] - a.color[2]) * f),
    ];
  }
  return last.color;
}

// deck.gl's HeatmapLayer spreads colorRange evenly across the texture, so stop
// positions only survive by being resampled into a dense even ramp.
export function sampleColorRange(stops: GradientStop[], n = 32): RGB[] {
  if (stops.length === 0)
    return sampleColorRange(BUILTIN_GRADIENTS[0].stops, n);
  if (n === 1) return [colorAt(stops, 0)];
  return Array.from({ length: n }, (_, i) => colorAt(stops, i / (n - 1)));
}

export function gradientCss(stops: GradientStop[]): string {
  if (stops.length === 0) return "transparent";
  const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
  if (stops.length === 1) return rgb(stops[0].color);
  const parts = stops.map(
    (s) => `${rgb(s.color)} ${+(s.pos * 100).toFixed(2)}%`,
  );
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** Returns the moved stop's new index too — repositioning re-sorts the list. */
export function moveStop(
  stops: GradientStop[],
  index: number,
  pos: number,
): { stops: GradientStop[]; index: number } {
  const target = stops[index];
  if (!target) return { stops, index };
  const moved: GradientStop = {
    color: [...target.color] as RGB,
    pos: clamp01(pos),
  };
  const next = stops
    .map((s, i) => (i === index ? moved : s))
    .sort((a, b) => a.pos - b.pos);
  return { stops: next, index: next.indexOf(moved) };
}

/** Inserts a stop carrying the colour the ramp already has there, so nothing jumps. */
export function addStopAt(
  stops: GradientStop[],
  pos: number,
): { stops: GradientStop[]; index: number } {
  const p = clamp01(pos);
  const added: GradientStop = { color: colorAt(stops, p), pos: p };
  const next = [...stops, added].sort((a, b) => a.pos - b.pos);
  return { stops: next, index: next.indexOf(added) };
}

export function removeStop(
  stops: GradientStop[],
  index: number,
): GradientStop[] {
  if (stops.length <= MIN_STOPS) return stops;
  return stops.filter((_, i) => i !== index);
}

export function setStopColor(
  stops: GradientStop[],
  index: number,
  color: RGB,
): GradientStop[] {
  return stops.map((s, i) => (i === index ? { ...s, color } : s));
}

export function reverseStops(stops: GradientStop[]): GradientStop[] {
  return stops.map((s) => ({ ...s, pos: 1 - s.pos })).reverse();
}

export function rgbToHex(c: RGB): string {
  return `#${c
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}
