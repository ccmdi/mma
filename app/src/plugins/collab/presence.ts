import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { events, type RGB } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { subscribe } from "@/lib/events";
import { getLocal, persisted, subscribeLocal } from "@/lib/hooks/useLocalStorage";
import { lngSpan, sameBounds, unwrapLng, wrapDeg } from "@/lib/geo/geo";
import { latLngToWorld, unwrapWorldX, worldToLatLng } from "@/lib/geo/mercator";
import { MapHost, type DeckOverlayHandle } from "@/lib/map/host";
import { hexToRgb, legible, rgbCss } from "@/lib/util/color";
import { throttle } from "@/lib/util/concurrent";
import { frameLoop, smoothed, type Motion, type Smoothed } from "@/lib/util/motion";
import { errText } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { Store } from "@/store/store";
import type { Bounds, LatLng } from "@/types";
import { toPeople, type Person } from "./people";
import { Sessions } from "./sessions";

const SEND_MS = 40;
const BEHIND_MS = 100;
const SNAP_MS = 1000;
const GLIDE_MS = 200;
const OMEGA = 0.035;
const DAMPING = 0.8;
const SETTLED_PX = 0.05;
const RESTING_PX_PER_MS = 0.0125;
const IDLE_MS = 10_000;
const IDLE_ALPHA = 0.45;
const FADE_MS = 250;
const RIPPLE_MS = 600;
const RIPPLE_FROM = 6;
const RIPPLE_TO = 28;
const ARROW_W = 22;
const ARROW_H = 22;
const TIP = 3;
const NEAR_PX = 20;

/** What this plugin shows everyone else in a session: where this user points and looks, and a
 *  ping the first time it is sent. */
export type Spot = {
	cursor: LatLng | null;
	viewport: Bounds | null;
	ping: LatLng | null;
};

/** Which of everyone else's marks this user sees. */
type Shown = { cursors: boolean; viewports: boolean; pings: boolean };
const SHOWN = persisted<Shown>("collabShown", { cursors: true, viewports: true, pings: true });

const here = () => Sessions.get().on(Store.get().mapId);

type Pin = {
	id: string;
	url: string;
	width: number;
	height: number;
	anchorX: number;
	anchorY: number;
};

const token = (name: string) =>
	getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A rounded arrowhead filled with `color`, its tip at the icon's anchor. */
function drawArrow(id: string, color: RGB): Pin {
	const scale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
	const canvas = document.createElement("canvas");
	canvas.width = ARROW_W * scale;
	canvas.height = ARROW_H * scale;
	const ctx = canvas.getContext("2d")!;
	ctx.scale(scale, scale);
	const arrow = new Path2D("M3 3 L19 9.5 L11.5 11.5 L9.5 19 Z");
	ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
	ctx.shadowBlur = 3;
	ctx.shadowOffsetY = 1;
	ctx.lineJoin = "round";
	ctx.lineWidth = 4;
	ctx.strokeStyle = "#fff";
	ctx.stroke(arrow);
	ctx.shadowColor = "transparent";
	ctx.lineWidth = 1.5;
	ctx.strokeStyle = ctx.fillStyle = rgbCss(color);
	ctx.stroke(arrow);
	ctx.fill(arrow);
	return {
		id,
		url: canvas.toDataURL(),
		width: canvas.width,
		height: canvas.height,
		anchorX: TIP * scale,
		anchorY: TIP * scale,
	};
}

type Sample = { x: number; y: number; at: number };

/** Someone else in the session: what they last sent, and how they are drawn. */
type Drawn = {
	login: string;
	person: Person;
	samples: Sample[];
	cursor: Smoothed | null;
	movedAt: number;
	alpha: Smoothed;
	bounds: Bounds | null;
	viewport: number[] | null;
	view: Smoothed | null;
};

/** Tell the open map's live session where this app points and looks, as it changes. */
function sending(): () => void {
	const spot: Spot = { cursor: null, viewport: null, ping: null };
	const sends = throttle(() => {
		const session = here();
		if (!session?.live) return;
		cmd
			.collabPresent(session.map, { ...spot })
			.catch((e: unknown) => log.debug(`[collab] presence not sent: ${errText(e)}`));
		spot.ping = null;
	}, SEND_MS);
	const changed = () => {
		if (here()?.live) sends.schedule();
	};
	const stops = [
		subscribe(Sessions.changed, () => {
			if (here()?.live) changed();
			else spot.ping = null;
		}),
		MapHost.each((host) => {
			spot.viewport = host.getBounds();
			changed();
			const offs = [
				host.on("click", (at) => {
					if (!here()?.live) return;
					spot.ping = at;
					changed();
				}),
				host.on("mousemove", ({ lat, lng }) => {
					spot.cursor = { lat, lng };
					changed();
				}),
				host.on("mouseout", () => {
					spot.cursor = null;
					changed();
				}),
				host.on("camera", () => {
					spot.viewport = host.getBounds();
					changed();
				}),
			];
			return () => {
				for (const off of offs) off();
			};
		}),
	];
	return () => {
		for (const stop of stops) stop();
		sends.cancel();
	};
}

/** Draw everyone else in the open map's session where they point and look, from what they send. */
function drawing() {
	const people = new Map<string, Drawn>();
	let ripples: { person: Person; at: LatLng; start: number }[] = [];
	let host: MapHost | null = null;
	let overlay: DeckOverlayHandle | null = null;
	let mouse: LatLng | null = null;
	const still = window.matchMedia("(prefers-reduced-motion: reduce)");

	const scale = () => 2 ** (host?.getZoom() ?? 0);
	const spring: Motion = {
		spring: OMEGA,
		damping: DAMPING,
		settled: (gap, velocity) =>
			Math.hypot(...gap) * scale() < SETTLED_PX &&
			Math.hypot(...velocity) * scale() < RESTING_PX_PER_MS,
	};
	const fade: Motion = { ease: FADE_MS, settled: ([gap]) => Math.abs(gap) < 0.005 };
	const personOf = (login: string) =>
		here()?.people.find((p) => p.login === login) ?? toPeople([{ login, guest: false }])[0];

	const pins = new Map<string, Pin>();
	const pinOf = (color: RGB): Pin => {
		const id = color.join();
		let pin = pins.get(id);
		if (!pin) pins.set(id, (pin = drawArrow(id, color)));
		return pin;
	};

	const draw = () => {
		if (people.size === 0 && ripples.length === 0) {
			overlay?.finalize();
			overlay = null;
			return;
		}
		if (!host) return;
		overlay ??= host.createDeckOverlay();
		const all = [...people.values()];
		const shown = getLocal(SHOWN);
		const rings = shown.viewports ? all.filter((p) => p.view) : [];
		const cursors = shown.cursors ? all.filter((p) => p.cursor) : [];
		const at = ({ cursor }: Drawn): [number, number] => {
			const { lat, lng } = worldToLatLng(cursor!.value[0], cursor!.value[1]);
			return [wrapDeg(lng, -180), lat];
		};

		const pointer = mouse && latLngToWorld(mouse);
		let near: Drawn | undefined;
		let nearest = NEAR_PX;
		if (pointer)
			for (const p of cursors) {
				const [x, y] = p.cursor!.value;
				const px = Math.hypot(unwrapWorldX(x, pointer.x) - pointer.x, y - pointer.y) * scale();
				if (px < nearest) [near, nearest] = [p, px];
			}
		const pill: RGB = near ? hexToRgb(token("--surface-3")) : [0, 0, 0];

		overlay.setProps({
			layers: [
				new PathLayer<Drawn>({
					id: "collab-viewports",
					data: rings,
					getPath: ({ view }) => {
						const [west, south, east, north] = view!.value;
						return [
							[west, south],
							[east, south],
							[east, north],
							[west, north],
							[west, south],
						];
					},
					getColor: (p) => p.person.color,
					widthUnits: "pixels",
					getWidth: 2,
					pickable: false,
				}),
				new ScatterplotLayer<(typeof ripples)[number]>({
					id: "collab-pings",
					data: shown.pings ? ripples : [],
					getPosition: (r) => [r.at.lng, r.at.lat],
					radiusUnits: "pixels",
					getRadius: (r) => {
						if (still.matches) return RIPPLE_FROM / 2;
						const f = Math.min(1, (performance.now() - r.start) / RIPPLE_MS);
						return RIPPLE_FROM + (RIPPLE_TO - RIPPLE_FROM) * (1 - (1 - f) ** 3);
					},
					stroked: !still.matches,
					filled: still.matches,
					lineWidthUnits: "pixels",
					getLineWidth: 2,
					getLineColor: (r) => {
						const f = Math.min(1, (performance.now() - r.start) / RIPPLE_MS);
						return [...r.person.color, Math.round(255 * (1 - f))];
					},
					getFillColor: (r) => r.person.color,
					pickable: false,
				}),
				new IconLayer<Drawn>({
					id: "collab-cursors",
					data: cursors,
					getPosition: at,
					getIcon: (p) => pinOf(p.person.color),
					getColor: (p) => [255, 255, 255, Math.round(p.alpha.value[0] * 255)],
					getSize: ARROW_H,
					sizeUnits: "pixels",
					pickable: false,
				}),
				new TextLayer<Drawn>({
					id: "collab-names",
					data: near ? [near] : [],
					getPosition: at,
					getText: (p) => p.person.name,
					getColor: (p) => legible(p.person.color, pill),
					getSize: 12,
					getPixelOffset: [ARROW_W - TIP, ARROW_H - TIP],
					getTextAnchor: "start",
					getAlignmentBaseline: "top",
					background: true,
					getBackgroundColor: [...pill, 240],
					backgroundPadding: [8, 3],
					backgroundBorderRadius: 999,
					fontFamily: '"Open Sans", sans-serif',
					fontWeight: 600,
					characterSet: "auto",
					pickable: false,
				}),
			],
		});
	};

	const loop = frameLoop((elapsed, now) => {
		const dt = still.matches ? Infinity : elapsed;
		const then = now - BEHIND_MS;
		let next = Infinity;
		for (const p of people.values()) {
			if (p.view && p.viewport && p.view.step(p.viewport, dt)) next = 0;
			const { samples, cursor } = p;
			while (samples.length > 1 && samples[1].at <= then) samples.shift();
			const [a, b] = samples;
			if (!a || !cursor) continue;
			const f = b && then > a.at ? (then - a.at) / (b.at - a.at) : 0;
			if (b) next = 0;
			if (cursor.step(b ? [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f] : [a.x, a.y], dt))
				next = 0;
			const idleAt = p.movedAt + IDLE_MS;
			if (now < idleAt) next = Math.min(next, idleAt - now);
			if (p.alpha.step([now >= idleAt ? IDLE_ALPHA : 1], dt)) next = 0;
		}
		ripples = ripples.filter((r) => now - r.start < RIPPLE_MS);
		if (ripples.length) next = 0;
		draw();
		return next;
	});

	const stops = [
		subscribeLocal(SHOWN, loop.wake),
		subscribe(Sessions.changed, () => {
			const session = here();
			for (const p of people.values()) p.person = personOf(p.login);
			if (session?.live) {
				for (const login of [...people.keys()])
					if (!session.people.some((p) => p.login === login)) people.delete(login);
			} else {
				people.clear();
				ripples = [];
			}
			loop.wake();
		}),
		MapHost.each((ready) => {
			host = ready;
			const offs = [
				ready.on("mousemove", ({ lat, lng }) => {
					mouse = { lat, lng };
					loop.wake();
				}),
				ready.on("mouseout", () => {
					mouse = null;
					loop.wake();
				}),
				ready.on("zoom", loop.wake),
			];
			loop.wake();
			return () => {
				for (const off of offs) off();
				overlay?.finalize();
				[host, overlay, mouse] = [null, null, null];
			};
		}),
	];

	return {
		/** Take in what `login` sent. */
		hear: (login: string, theirs: Spot) => {
			const now = performance.now();
			const p: Drawn = people.get(login) ?? {
				login,
				person: personOf(login),
				samples: [],
				cursor: null,
				movedAt: now,
				alpha: smoothed(fade, [1]),
				bounds: null,
				viewport: null,
				view: null,
			};
			people.set(login, p);
			if (theirs.ping) ripples.push({ person: p.person, at: theirs.ping, start: now });
			const v = theirs.viewport;
			if (!v) [p.viewport, p.view] = [null, null];
			else if (!p.bounds || !sameBounds(v, p.bounds)) {
				const west = p.view ? unwrapLng(v.west, p.view.value[0]) : v.west;
				p.viewport = [west, v.south, west + lngSpan(v), v.north];
				p.view ??= smoothed({ glide: GLIDE_MS }, p.viewport);
			}
			p.bounds = v;
			if (!theirs.cursor) {
				p.samples = [];
				p.cursor = null;
			} else {
				const { x, y } = latLngToWorld(theirs.cursor);
				const last = p.samples.at(-1);
				const to = { x: last ? unwrapWorldX(x, last.x) : x, y };
				if (!last || to.x !== last.x || to.y !== last.y) p.movedAt = now;
				if (!last || still.matches || now - last.at > SNAP_MS) {
					p.samples = [{ ...to, at: now }];
					p.cursor = smoothed(spring, [to.x, to.y]);
				} else {
					if (now - last.at > BEHIND_MS) p.samples.push({ ...last, at: now - SEND_MS });
					p.samples.push({ ...to, at: now });
				}
			}
			loop.wake();
		},
		stop: () => {
			for (const stop of stops) stop();
			loop.stop();
			people.clear();
		},
	};
}

export const Presence = {
	/** Which of everyone else's marks this user sees, remembered on this device. */
	shown: SHOWN,
	/** Tell the session on the open map where this app points and looks, and draw where everyone
	 *  else does. Returns the teardown. */
	mount: (): (() => void) => {
		const drawn = drawing();
		const stops = [sending(), drawn.stop];
		const unlisten = events.collabPresence.listen(({ payload: { map, login, data } }) => {
			if (map !== Store.get().mapId) return;
			drawn.hear(login, data as Spot);
		});
		return () => {
			void unlisten.then((stop) => stop());
			for (const stop of stops) stop();
		};
	},
};
