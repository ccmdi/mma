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
import "./HeatmapSidebar.css";

const {
  useMapState,
  selectorForPick,
  ui: { Button, Field, Section, SelectorPicker, Sidebar, Slider, Switch, TextInput },
} = MMA;

export function HeatmapSidebar({ onClose }: { onClose: () => void }) {
  const [, rerender] = useState(0);
  const layers = getLayers();

  useEffect(() => {
    setOnSettingsChange(() => rerender((n) => n + 1));
    return () => {
      setOnSettingsChange(null);
    };
  }, []);

  const allCount = useMapState((s) => s.locationCount);
  const selectedIds = useMapState((s) => s.selectedLocationIds);

  return (
    <Sidebar
      title="Heatmap"
      onBack={onClose}
      actions={
        <Button variant="ghost" small onClick={resetLayers}>
          Reset
        </Button>
      }
    >
      {layers.map((l, i) => (
        <LayerControls
          key={l.id}
          layer={l}
          index={i}
          allCount={allCount}
          selectionCount={selectedIds.size}
        />
      ))}
      <Button onClick={addLayer}>Add heatmap</Button>
    </Sidebar>
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
    <Section
      title={`Heatmap ${index + 1}`}
      collapsible={false}
      addons={
        <>
          <Switch
            checked={l.visible}
            onChange={(visible) => set({ visible })}
            label="Visible"
          />
          <Button variant="ghost" small onClick={() => removeLayer(l.id)}>
            Remove
          </Button>
        </>
      }
    >

      <SelectorPicker
        ctl={{
          selector: selectorForPick(l.source),
          choice: l.source,
          setChoice: (c: SelectorPick) => set({ source: c }),
          allCount,
          selectionCount,
        }}
      />

      <Field label="Intensity">
        <Slider
          value={l.intensity}
          min={0.1}
          max={10}
          step={0.1}
          onChange={(e) => set({ intensity: Number(e.target.value) })}
          format={round2}
        />
      </Field>
      <Field label="Radius">
        <Slider
          value={l.radiusPixels}
          min={1}
          max={100}
          step={1}
          onChange={(e) => set({ radiusPixels: Number(e.target.value) })}
          format={(v) => `${v}px`}
        />
      </Field>
      <Field label="Opacity">
        <Slider
          value={l.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(e) => set({ opacity: Number(e.target.value) })}
          format={round2}
        />
      </Field>
      <Field label="Threshold">
        <Slider
          value={l.threshold}
          min={0}
          max={1}
          step={0.01}
          onChange={(e) => set({ threshold: Number(e.target.value) })}
          format={round2}
        />
      </Field>

      <GradientPicker
        layerId={l.id}
        gradientId={l.gradientId}
        onSelect={(id) => set({ gradientId: id })}
      />
    </Section>
  );
}

const round2 = (v: number) => String(Math.round(v * 100) / 100);

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
    <Field label="Gradient">
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
        <div className="heatmap-sidebar__editor-actions">
          <Button
            variant="ghost"
            small
            onClick={() =>
              setEditingId(editing?.id === current.id ? null : current.id)
            }
          >
            {editing?.id === current.id ? "Done" : "Edit gradient"}
          </Button>
          <Button
            variant="ghost"
            small
            onClick={() => removeCustomGradient(current.id)}
          >
            Delete
          </Button>
        </div>
      )}

      {editing && <GradientEditor gradient={editing} />}
    </Field>
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
      <TextInput
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
            title={`${Math.round(s.pos * 100)}% (drag to move, right-click to remove)`}
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
          <TextInput
            className="heatmap-sidebar__stop-pos"
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
          <Button
            variant="ghost"
            small
            onClick={() => setStops(reverseStops(g.stops))}
          >
            Reverse
          </Button>
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
