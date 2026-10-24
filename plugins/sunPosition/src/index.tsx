import { LineLayer } from "@deck.gl/layers";
import type { DeckOverlayHandle, FieldDef, MapHost, RGB, SelectorPick } from "mma-plugin-types";

const {
	registerPlugin,
	registerProvider,
	waitForMapHost,
	fetchColumns,
	on,
	pluginSetting,
	all,
	has,
	selectorForPick,
	useSelectorPick,
	ui: { Sidebar, Section, SwitchRow, Field, Slider, ColorPicker, SelectorPicker },
} = MMA;

const PLUGIN_ID = "sunPosition";
const LENGTH_RANGE = { min: 8, max: 96 };
const WORLD_PX = 256;
const RAD = Math.PI / 180;

const settings = {
	rays: pluginSetting(PLUGIN_ID, "showRays", false),
	length: pluginSetting(PLUGIN_ID, "rayLength", 28),
	color: pluginSetting<RGB>(PLUGIN_ID, "rayColor", [255, 179, 0]),
	source: pluginSetting<SelectorPick>(PLUGIN_ID, "source", { pick: "all" }),
};

const FIELDS: Record<string, FieldDef> = {
	sunAzimuth: {
		type: "number",
		label: "Sun azimuth",
		values: null,
		comparison: { type: "circular", period: 360 },
	},
	sunAltitude: {
		type: "number",
		label: "Sun altitude",
		values: null,
		comparison: null,
	},
};

export function sunIsUp(altitude: unknown): boolean {
	return typeof altitude === "number" && altitude > 0;
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
	overlay?.setProps({
		layers: [
			new LineLayer({
				id: `${PLUGIN_ID}-rays`,
				data: {
					length: rays.bearing.length,
					attributes: {
						getSourcePosition: { value: rays.source, size: 2 },
						getTargetPosition: {
							value: rayTargets(rays, settings.length.get(), host.getZoom()),
							size: 2,
						},
					},
				},
				getColor: [...settings.color.get(), 255],
				getWidth: 2,
				widthUnits: "pixels",
			}),
		],
	});
}

let loadToken = 0;

async function load(host: MapHost) {
	const token = ++loadToken;
	const [lats, lngs, azimuths, altitudes] = await fetchColumns(
		all(selectorForPick(settings.source.get()), has("sunAzimuth")),
		["lat", "lng", "sunAzimuth", "sunAltitude"],
	);
	if (token !== loadToken || !overlay) return;
	rays = daylightRays(lats, lngs, azimuths, altitudes);
	draw(host);
}

function start(host: MapHost): () => void {
	overlay = host.createDeckOverlay();
	void load(host);

	let reloadTimer: ReturnType<typeof setTimeout> | undefined;
	const reload = () => {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void load(host), 100);
	};
	const redraw = () => draw(host);
	const unsubs = [
		on("store:change", (e) => {
			if (e.added.length + e.updated.length + e.removed.length > 0) reload();
		}),
		on("selection:change", () => {
			if (settings.source.get().pick === "selection") reload();
		}),
		settings.source.on(reload),
		settings.length.on(redraw),
		settings.color.on(redraw),
		host.on("zoom", redraw),
	];

	return () => {
		for (const unsub of unsubs) unsub();
		clearTimeout(reloadTimer);
		overlay?.finalize();
		overlay = null;
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

function SunSidebar({ onClose }: { onClose: () => void }) {
	const [visible, setVisible] = settings.rays.use();
	const [length, setLength] = settings.length.use();
	const [color, setColor] = settings.color.use();
	const picker = useSelectorPick(settings.source.get());
	return (
		<Sidebar title="Sun Position" onBack={onClose}>
			<Section title="Overlay">
				<SwitchRow label="Sun rays" checked={visible} onChange={setVisible} />
				<Field label="Locations">
					<SelectorPicker
						ctl={{
							...picker,
							setChoice: (pick) => {
								picker.setChoice(pick);
								settings.source.set(pick);
							},
						}}
					/>
				</Field>
				<Field label="Length">
					<Slider
						min={LENGTH_RANGE.min}
						max={LENGTH_RANGE.max}
						value={length}
						onChange={(e) => setLength(Number(e.target.value))}
						format={(v) => `${v}px`}
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

		showRays(settings.rays.get());
		const off = settings.rays.on(showRays);
		return () => {
			off();
			showRays(false);
		};
	},
});
