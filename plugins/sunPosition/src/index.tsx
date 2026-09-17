import { useState } from "react";
import { LineLayer } from "@deck.gl/layers";
import type {
	DeckOverlayHandle,
	ExtraFieldDef,
	MapHost,
	RGB,
	RGBA,
	Selector,
} from "mma-plugin-types";

const {
	registerPlugin,
	registerEnrichFields,
	registerProvider,
	waitForMapHost,
	fetchColumns,
	on,
	storage,
	usePluginState,
	ui: { Sidebar, Section, SwitchRow, Field, Slider, ColorPicker },
} = MMA;

const PLUGIN_ID = "sunPosition";
const RAYS_KEY = "showRays";
const LENGTH_KEY = "rayLength";
const COLOR_KEY = "rayColor";
const DEFAULT_LENGTH = 28;
const LENGTH_RANGE = { min: 8, max: 96 };
const DEFAULT_COLOR: RGB = [255, 179, 0];
const WORLD_PX = 256;
const RAD = Math.PI / 180;

const FIELDS: Record<string, ExtraFieldDef> = {
	sunAzimuth: {
		type: "number",
		label: "Sun azimuth",
		values: null,
		labels: null,
		comparison: { type: "circular", period: 360 },
	},
	sunAltitude: {
		type: "number",
		label: "Sun altitude",
		values: null,
		labels: null,
		comparison: null,
	},
};

const ENRICHED: Selector = { type: "Filter", field: "sunAzimuth", test: { op: "has" } };

export function sunIsUp(altitude: unknown): boolean {
	return typeof altitude === "number" && altitude > 0;
}

export function rayLength(value: unknown): number {
	const px = Math.round(Number(value));
	return Number.isFinite(px) && px > 0 ? px : DEFAULT_LENGTH;
}

function isRgb(value: unknown): value is RGB {
	return (
		Array.isArray(value) &&
		value.length === 3 &&
		value.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
	);
}

export function rayColor(value: unknown): RGB {
	return isRgb(value) ? value : DEFAULT_COLOR;
}

export interface SunRays {
	source: Float64Array;
	bearing: Float64Array;
}

const NO_RAYS: SunRays = { source: new Float64Array(0), bearing: new Float64Array(0) };

export function daylightRays(
	lats: unknown[],
	lngs: unknown[],
	azimuths: unknown[],
	altitudes: unknown[],
): SunRays {
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

export function rayTargets(rays: SunRays, lengthPx: number, zoom: number): Float64Array {
	const world = WORLD_PX * 2 ** zoom;
	const target = new Float64Array(rays.source.length);
	for (let i = 0; i < rays.bearing.length; i++) {
		const lng = rays.source[i * 2];
		const sin = Math.sin(rays.source[i * 2 + 1] * RAD);
		const theta = rays.bearing[i] * RAD;
		const y =
			0.5 -
			Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) -
			(lengthPx * Math.cos(theta)) / world;
		target[i * 2] = lng + (360 * lengthPx * Math.sin(theta)) / world;
		target[i * 2 + 1] = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;
	}
	return target;
}

let overlay: DeckOverlayHandle | null = null;
let rays = NO_RAYS;

function draw(host: MapHost) {
	const stored = storage(PLUGIN_ID);
	const color: RGBA = [...rayColor(stored.get(COLOR_KEY)), 255];
	overlay?.setProps({
		layers: [
			new LineLayer({
				id: `${PLUGIN_ID}-rays`,
				data: {
					length: rays.bearing.length,
					attributes: {
						getSourcePosition: { value: rays.source, size: 2 },
						getTargetPosition: {
							value: rayTargets(rays, rayLength(stored.get(LENGTH_KEY)), host.getZoom()),
							size: 2,
						},
					},
				},
				getColor: color,
				getWidth: 2,
				widthUnits: "pixels",
			}),
		],
	});
}

let redraw: (() => void) | null = null;
let loadToken = 0;

async function load(host: MapHost) {
	const token = ++loadToken;
	const [lats, lngs, azimuths, altitudes] = await fetchColumns(ENRICHED, [
		"lat",
		"lng",
		"sunAzimuth",
		"sunAltitude",
	]);
	if (token !== loadToken || !overlay) return;
	rays = daylightRays(lats, lngs, azimuths, altitudes);
	draw(host);
}

const DATA_EVENTS = [
	"location:add",
	"location:remove",
	"location:update",
	"location:invalidate",
] as const;

function start(host: MapHost): () => void {
	overlay = host.createDeckOverlay();
	void load(host);

	let reloadTimer: ReturnType<typeof setTimeout> | undefined;
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

let showing = false;
let stop: (() => void) | null = null;

export function showRays(visible: boolean) {
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

function useRayStyle<T>(key: string, parse: (value: unknown) => T) {
	const [value, setValue] = useState(() => parse(storage(PLUGIN_ID).get(key)));
	const set = (next: T) => {
		setValue(next);
		storage(PLUGIN_ID).set(key, next);
		redraw?.();
	};
	return [value, set] as const;
}

function SunSidebar({ onClose }: { onClose: () => void }) {
	const [visible, setVisible] = usePluginState<boolean>(PLUGIN_ID, RAYS_KEY, false);
	const [length, setLength] = useRayStyle(LENGTH_KEY, rayLength);
	const [color, setColor] = useRayStyle(COLOR_KEY, rayColor);
	return (
		<Sidebar title="Sun Position" onBack={onClose}>
			<Section title="Overlay">
				<SwitchRow
					label="Sun rays"
					checked={visible}
					onChange={(value) => {
						setVisible(value);
						showRays(value);
					}}
				/>
				<Field label={`Length: ${length}px`}>
					<Slider
						min={LENGTH_RANGE.min}
						max={LENGTH_RANGE.max}
						value={length}
						onChange={(e) => setLength(rayLength(e.target.value))}
					/>
				</Field>
				<Field label="Color" row>
					<ColorPicker color={color} onChange={setColor} ariaLabel="Ray color" />
				</Field>
			</Section>
		</Sidebar>
	);
}

registerPlugin({
	sidebar: SunSidebar,
	activate() {
		registerEnrichFields([
			{ key: "sunAzimuth", label: "Sun azimuth" },
			{ key: "sunAltitude", label: "Sun altitude" },
		]);
		registerProvider({
			id: PLUGIN_ID,
			label: "Sun position",
			fieldDefs: FIELDS,
			requires: ["datetime"],
			procedure: {
				entry: "procedure.js",
				batch: { mode: "chunk", size: 10000 },
			},
		});

		showRays(storage(PLUGIN_ID).get<boolean>(RAYS_KEY, false));

		return () => showRays(false);
	},
});
