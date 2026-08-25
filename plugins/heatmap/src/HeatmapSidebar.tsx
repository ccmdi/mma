import { useState, useEffect, useRef } from "react";
import {
  getLayers,
  getCustomGradients,
  updateLayer,
  addLayer,
  removeLayer,
  resetLayers,
  addCustomGradient,
  updateCustomGradient,
  removeCustomGradient,
  setOnSettingsChange,
  type HeatmapLayerSettings,
} from "./heatmap";
import {
  BUILTIN_GRADIENTS,
  MIN_STOPS,
  addStopAt,
  gradientCss,
  hexToRgb,
  isBuiltinGradient,
  moveStop,
  removeStop,
  resolveGradient,
  reverseStops,
  rgbToHex,
  setStopColor,
  type GradientStop,
  type HeatmapGradient,
} from "./gradients";
import type { SelectorPick } from "mma-plugin-types";

const CSS = `
.heatmap-sidebar { overflow: auto; }
.heatmap-sidebar__header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px; border-bottom: 1px solid var(--color-divider, #333);
}
.heatmap-sidebar__title { margin: 0; font-size: 14px; font-weight: 600; }
.heatmap-sidebar__body {
  padding: 12px; display: flex; flex-direction: column; gap: 12px;
}
.heatmap-sidebar__section {
  border-bottom: 1px solid var(--color-divider, #333);
  padding-bottom: 10px;
}
.heatmap-sidebar__section:last-child { border-bottom: none; padding-bottom: 0; }
.heatmap-sidebar__section-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  color: var(--text-secondary, #999); margin: 0 0 6px;
}
.heatmap-sidebar__layer-header {
  display: flex; align-items: center; gap: 8px; padding: 2px 0 6px;
}
.heatmap-sidebar__layer-title { flex: 1; font-size: 13px; font-weight: 600; }
.heatmap-sidebar__control {
  display: flex; align-items: center; gap: 8px; padding: 2px 0;
}
.heatmap-sidebar__control label {
  flex: 1; font-size: 13px;
}
.heatmap-sidebar__control input[type="range"] {
  width: 100px;
}
.heatmap-sidebar__control .heatmap-sidebar__value {
  min-width: 36px; text-align: right; font-size: 12px;
  color: var(--text-secondary, #999); font-variant-numeric: tabular-nums;
}
.heatmap-sidebar__reset {
  font-size: 12px; color: var(--text-secondary, #999);
  background: none; border: none; cursor: pointer; padding: 0;
  text-decoration: underline;
}
.heatmap-sidebar__reset:hover { color: var(--text-primary, #fff); }
.heatmap-sidebar__add {
  width: 100%; padding: 6px; font-size: 13px; cursor: pointer;
  background: none; border: 1px dashed var(--color-divider, #444);
  border-radius: 4px; color: var(--text-secondary, #999);
}
.heatmap-sidebar__add:hover {
  color: var(--text-primary, #fff);
  border-color: var(--text-secondary, #999);
}
.heatmap-sidebar .selector-picker { padding: 2px 0 6px; font-size: 13px; }
.heatmap-sidebar__gradients {
  display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
}
.heatmap-sidebar__gradient {
  background: none; border: 2px solid transparent; border-radius: 4px;
  padding: 2px; cursor: pointer; width: 100%;
}
.heatmap-sidebar__gradient--active { border-color: var(--accent-color, #4a9eff); }
.heatmap-sidebar__gradient-bar { height: 14px; border-radius: 2px; }
.heatmap-sidebar__gradient-new {
  border: 1px dashed var(--color-divider, #444); border-radius: 4px;
  background: none; color: var(--text-secondary, #999); cursor: pointer;
  font-size: 12px; padding: 3px 2px;
}
.heatmap-sidebar__gradient-new:hover {
  color: var(--text-primary, #fff); border-color: var(--text-secondary, #999);
}
.heatmap-sidebar__editor {
  border: 1px solid var(--color-divider, #333); border-radius: 4px;
  padding: 8px; margin-top: 6px; display: flex; flex-direction: column; gap: 8px;
}
.heatmap-sidebar__editor-name {
  width: 100%; box-sizing: border-box; font-size: 13px; padding: 4px 6px;
  background: var(--surface-2, #1c1c1c); color: inherit;
  border: 1px solid var(--color-divider, #333); border-radius: 3px;
}
.heatmap-sidebar__track { position: relative; height: 34px; touch-action: none; }
.heatmap-sidebar__track-bar {
  height: 18px; border-radius: 3px; cursor: copy;
  border: 1px solid var(--color-divider, #333);
}
.heatmap-sidebar__handle {
  position: absolute; top: 14px; transform: translateX(-50%);
  width: 12px; height: 12px; padding: 0; cursor: grab;
  border: 2px solid var(--surface-1, #111); border-radius: 3px;
  box-shadow: 0 0 0 1px #0000008c;
}
.heatmap-sidebar__handle:before {
  content: ""; position: absolute; left: 50%; top: -6px;
  width: 1px; height: 6px; background: var(--text-secondary, #999);
}
.heatmap-sidebar__handle--selected {
  border-color: var(--accent-color, #4a9eff); z-index: 1;
}
.heatmap-sidebar__handle:active { cursor: grabbing; }
.heatmap-sidebar__stop-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.heatmap-sidebar__stop-row input[type="color"] {
  width: 28px; height: 24px; padding: 0; cursor: pointer;
  background: none; border: 1px solid var(--color-divider, #444); border-radius: 3px;
}
.heatmap-sidebar__stop-row input[type="number"] {
  width: 52px; font-size: 12px; padding: 3px 4px;
  background: var(--surface-2, #1c1c1c); color: inherit;
  border: 1px solid var(--color-divider, #333); border-radius: 3px;
}
.heatmap-sidebar__hint { font-size: 11px; color: var(--text-secondary, #999); margin: 0; }
.heatmap-sidebar__editor-actions { display: flex; gap: 10px; align-items: center; }
`;

let styleEl: HTMLStyleElement | null = null;

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

const ARROW_LEFT =
  "M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z";

function Icon({ path, size = 20 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d={path} />
    </svg>
  );
}

export function HeatmapSidebar({ onClose }: { onClose: () => void }) {
  const [, rerender] = useState(0);
  const layers = getLayers();

  useEffect(() => {
    injectCSS();
    setOnSettingsChange(() => rerender((n) => n + 1));
    return () => {
      setOnSettingsChange(null);
      removeCSS();
    };
  }, []);

  const allCount = MMA.useMapState((s) => s.locationCount);
  const selectedIds = MMA.useMapState((s) => s.selectedLocationIds);

  return (
    <section className="map-sidebar heatmap-sidebar">
      <header className="heatmap-sidebar__header">
        <button className="icon-button" onClick={onClose}>
          <Icon path={ARROW_LEFT} />
        </button>
        <h2 className="heatmap-sidebar__title">Heatmap</h2>
        <span style={{ flex: 1 }} />
        <button className="heatmap-sidebar__reset" onClick={resetLayers}>
          Reset
        </button>
      </header>

      <div className="heatmap-sidebar__body">
        {layers.map((l, i) => (
          <LayerControls
            key={l.id}
            layer={l}
            index={i}
            allCount={allCount}
            selectionCount={selectedIds.size}
          />
        ))}

        <button className="heatmap-sidebar__add" onClick={addLayer}>
          Add heatmap
        </button>
      </div>
    </section>
  );
}

function LayerControls({
  layer: l,
  index,
  allCount,
  selectionCount,
}: {
  layer: HeatmapLayerSettings;
  index: number;
  allCount: number;
  selectionCount: number;
}) {
  const set = (patch: Partial<HeatmapLayerSettings>) =>
    updateLayer(l.id, patch);

  return (
    <div className="heatmap-sidebar__section">
      <div className="heatmap-sidebar__layer-header">
        <input
          type="checkbox"
          checked={l.visible}
          onChange={(e) => set({ visible: e.target.checked })}
        />
        <span className="heatmap-sidebar__layer-title">
          Heatmap {index + 1}
        </span>
        <button
          className="heatmap-sidebar__reset"
          onClick={() => removeLayer(l.id)}
        >
          Remove
        </button>
      </div>

      <MMA.ui.SelectorPicker
        ctl={{
          selector: MMA.selectorForPick(l.source),
          choice: l.source,
          setChoice: (c: SelectorPick) => set({ source: c }),
          allCount,
          selectionCount,
          saved: true,
        }}
      />

      <Slider
        label="Intensity"
        value={l.intensity}
        min={0.1}
        max={10}
        step={0.1}
        onChange={(v) => set({ intensity: v })}
      />
      <Slider
        label="Radius"
        value={l.radiusPixels}
        min={1}
        max={100}
        step={1}
        onChange={(v) => set({ radiusPixels: v })}
        format={(v) => `${v}px`}
      />
      <Slider
        label="Opacity"
        value={l.opacity}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => set({ opacity: v })}
      />
      <Slider
        label="Threshold"
        value={l.threshold}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => set({ threshold: v })}
      />

      <GradientPicker
        layerId={l.id}
        gradientId={l.gradientId}
        onSelect={(id) => set({ gradientId: id })}
      />
    </div>
  );
}

function GradientPicker({
  layerId,
  gradientId,
  onSelect,
}: {
  layerId: string;
  gradientId: string;
  onSelect: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const customs = getCustomGradients();
  const current = resolveGradient(gradientId, customs);
  const editing = customs.find((g) => g.id === editingId) ?? null;

  return (
    <>
      <p className="heatmap-sidebar__section-title" style={{ marginTop: 8 }}>
        Gradient
      </p>
      <div className="heatmap-sidebar__gradients">
        {[...BUILTIN_GRADIENTS, ...customs].map((g) => (
          <button
            key={g.id}
            className={`heatmap-sidebar__gradient ${g.id === current.id ? "heatmap-sidebar__gradient--active" : ""}`}
            onClick={() => onSelect(g.id)}
            title={g.name}
          >
            <div
              className="heatmap-sidebar__gradient-bar"
              style={{ background: gradientCss(g.stops) }}
            />
          </button>
        ))}
        <button
          className="heatmap-sidebar__gradient-new"
          onClick={() => setEditingId(addCustomGradient(layerId, current).id)}
          title="Create an editable copy of the selected gradient"
        >
          + New
        </button>
      </div>

      {!isBuiltinGradient(current.id) && (
        <div
          className="heatmap-sidebar__editor-actions"
          style={{ marginTop: 6 }}
        >
          <button
            className="heatmap-sidebar__reset"
            onClick={() =>
              setEditingId(editing?.id === current.id ? null : current.id)
            }
          >
            {editing?.id === current.id ? "Done" : "Edit gradient"}
          </button>
          <button
            className="heatmap-sidebar__reset"
            onClick={() => removeCustomGradient(current.id)}
          >
            Delete
          </button>
        </div>
      )}

      {editing && <GradientEditor gradient={editing} />}
    </>
  );
}

function GradientEditor({ gradient: g }: { gradient: HeatmapGradient }) {
  const [selectedRaw, setSelected] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const selected = Math.min(selectedRaw, g.stops.length - 1);
  const stop = g.stops[selected];

  const setStops = (stops: GradientStop[]) =>
    updateCustomGradient(g.id, { stops });

  const posFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect?.width) return 0;
    return (clientX - rect.left) / rect.width;
  };

  const startDrag =
    (index: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;
      setSelected(index);

      const el = e.currentTarget;
      // Every move recomputes from the drag-start snapshot, so re-sorting mid-drag
      // can't make the tracked stop drift.
      const from = g.stops;
      const onMove = (ev: PointerEvent) => {
        const next = moveStop(from, index, posFromClientX(ev.clientX));
        setSelected(next.index);
        setStops(next.stops);
      };
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
      };
      el.setPointerCapture(e.pointerId);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    };

  const nudge = (index: number) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -step : step;
      const next = moveStop(g.stops, index, g.stops[index].pos + delta);
      setSelected(next.index);
      setStops(next.stops);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setStops(removeStop(g.stops, index));
    }
  };

  return (
    <div className="heatmap-sidebar__editor">
      <input
        className="heatmap-sidebar__editor-name"
        value={g.name}
        onChange={(e) => updateCustomGradient(g.id, { name: e.target.value })}
        aria-label="Gradient name"
      />

      <div className="heatmap-sidebar__track" ref={trackRef}>
        <div
          className="heatmap-sidebar__track-bar"
          style={{ background: gradientCss(g.stops) }}
          title="Click to add a stop"
          onClick={(e) => {
            const next = addStopAt(g.stops, posFromClientX(e.clientX));
            setSelected(next.index);
            setStops(next.stops);
          }}
        />
        {g.stops.map((s, i) => (
          <button
            key={i}
            className={`heatmap-sidebar__handle ${i === selected ? "heatmap-sidebar__handle--selected" : ""}`}
            style={{ left: `${s.pos * 100}%`, background: rgbToHex(s.color) }}
            onPointerDown={startDrag(i)}
            onKeyDown={nudge(i)}
            onDoubleClick={() => colorInputRef.current?.click()}
            onContextMenu={(e) => {
              e.preventDefault();
              setStops(removeStop(g.stops, i));
            }}
            title={`${Math.round(s.pos * 100)}% — drag to move, right-click to remove`}
            aria-label={`Stop ${i + 1} at ${Math.round(s.pos * 100)}%`}
          />
        ))}
      </div>

      {stop && (
        <div className="heatmap-sidebar__stop-row">
          <input
            ref={colorInputRef}
            type="color"
            value={rgbToHex(stop.color)}
            onChange={(e) =>
              setStops(
                setStopColor(g.stops, selected, hexToRgb(e.target.value)),
              )
            }
            aria-label="Stop colour"
          />
          <input
            type="number"
            min={0}
            max={100}
            value={Math.round(stop.pos * 100)}
            onChange={(e) => {
              const next = moveStop(
                g.stops,
                selected,
                Number(e.target.value) / 100,
              );
              setSelected(next.index);
              setStops(next.stops);
            }}
            aria-label="Stop position"
          />
          <span>%</span>
          <span style={{ flex: 1 }} />
          <button
            className="heatmap-sidebar__reset"
            onClick={() => setStops(reverseStops(g.stops))}
          >
            Reverse
          </button>
        </div>
      )}

      <p className="heatmap-sidebar__hint">
        {g.stops.length <= MIN_STOPS
          ? `Click the bar to add a stop (${MIN_STOPS} minimum).`
          : "Click the bar to add a stop, right-click a handle to remove it."}
      </p>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const display = format
    ? format(value)
    : String(Math.round(value * 100) / 100);
  return (
    <div className="heatmap-sidebar__control">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="heatmap-sidebar__value">{display}</span>
    </div>
  );
}
