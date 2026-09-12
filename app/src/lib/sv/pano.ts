import type { CameraFrame, Location, Pano } from "@/bindings.gen";
import { LocationFlag } from "@/bindings.consts";
import { isPinned, type LocationPOV, type PanoCapture, type PanoView } from "@/types";
import { clamp } from "@/types/util";
import { getSettings, panoDisplayOptions } from "@/store/settings";
import { google } from "@/lib/sv/opensv";
import { patchOpenSV, setPanoHovered } from "@/lib/sv/opensvPatch";
import { lookupStreetView, nearestLinkHeading, resolvePano } from "@/lib/sv/lookup";
import { drawScaled, hasImagery, sceneCanvas } from "@/lib/sv/panoCapture";
import {
	PANO_PITCH,
	PANO_ZOOM,
	SV_JUMP_RADIUS,
	displayZoom,
	storedZoom,
	zoomInStep,
	zoomOutStep,
} from "@/lib/sv/constants";
import { normalizeHeading, reverseHeading, wrapDeg } from "@/lib/geo/geo";
import { toast as showToast } from "@/lib/util/toast";

export type PanoDestination = string | google.maps.LatLngLiteral;
export type PanoFrame = CameraFrame & { zoom?: number };
export type ShowResult = { status: "shown"; pano: Pano | null } | { status: "superseded" };
export type PanoEvent =
	"pov_changed" | "zoom_changed" | "links_changed" | "status_changed" | "pano_changed";

const REVEAL_MS = 180;
const TURN_MS = 160;
const RESOLUTION_CAP = 64;
const KEYS_KEPT_FROM_MAP = new Set([
	"arrowleft",
	"arrowright",
	"arrowup",
	"arrowdown",
	"w",
	"a",
	"s",
	"d",
	"+",
	"-",
	"=",
]);
const CROSSHAIR_REGION = '.gm-style > div[role="region"]';

const container = createContainer();
let viewer: google.maps.StreetViewPanorama | null = null;
let latestClaim = 0;
let concealedFor: number | null = null;
let activeTurn: { target: CameraFrame; stop: () => void } | null = null;
let jumpAheadPending: Promise<boolean> = Promise.resolve(false);
const resolutions = new Map<string, Promise<Pano | null>>();
const subscribers: Record<PanoEvent, Set<() => void>> = {
	pov_changed: new Set(),
	zoom_changed: new Set(),
	links_changed: new Set(),
	status_changed: new Set(),
	pano_changed: new Set(),
};
const mounts: HTMLElement[] = [];
let containerObserver: ResizeObserver | null = null;
let resizeFrame = 0;

function createContainer(): HTMLDivElement {
	const el = document.createElement("div");
	Object.assign(el.style, { width: "100%", height: "100%" });
	el.addEventListener("pointerenter", () => setPanoHovered(true));
	el.addEventListener("pointerleave", () => setPanoHovered(false));
	const keepFromMap = (e: KeyboardEvent) => {
		if (KEYS_KEPT_FROM_MAP.has(e.key.toLowerCase())) e.stopPropagation();
	};
	el.addEventListener("keydown", keepFromMap, true);
	el.addEventListener("keyup", keepFromMap, true);
	return el;
}

function viewerRoot(sv: google.maps.StreetViewPanorama | null): HTMLElement | undefined {
	return sv
		? (Object.values(sv).find((v) => v instanceof HTMLElement) as HTMLElement | undefined)
		: undefined;
}

function ensureViewer(): google.maps.StreetViewPanorama | null {
	if (viewer || !google?.maps) return viewer;
	const created = new google.maps.StreetViewPanorama(container, {
		disableDefaultUI: true,
		...panoDisplayOptions(getSettings()),
		motionTracking: false,
		visible: false,
	});
	patchOpenSV(created);
	const root = viewerRoot(created);
	if (root) root.style.backgroundColor = "#000";
	for (const event of Object.keys(subscribers) as PanoEvent[]) {
		created.addListener(event, () => {
			for (const fn of [...subscribers[event]]) fn();
		});
	}
	viewer = created;
	return created;
}

function clearViewer() {
	viewer?.setVisible(false);
	viewer = null;
	container.replaceChildren();
}

function on(event: PanoEvent, fn: () => void): () => void {
	subscribers[event].add(fn);
	return () => {
		subscribers[event].delete(fn);
	};
}

function applyFrame(sv: google.maps.StreetViewPanorama, frame: PanoFrame) {
	sv.setPov({ heading: frame.heading, pitch: frame.pitch });
	if (frame.zoom !== undefined) sv.setZoom(frame.zoom);
}

function applyResolved(sv: google.maps.StreetViewPanorama, resolved: Pano | null, loc: Location) {
	if (resolved?.id) sv.setPano(resolved.id);
	else sv.setPosition({ lat: loc.lat, lng: loc.lng });
	sv.setZoom(displayZoom(loc.zoom));
	sv.setPov({ heading: loc.heading, pitch: loc.pitch });
	sv.setVisible(true);
	sv.focus();
}

function isAt(sv: google.maps.StreetViewPanorama, to: PanoDestination): boolean {
	if (typeof to === "string") return sv.getPano() === to && sv.getStatus() === "OK";
	const at = sv.getPosition();
	return at?.lat() === to.lat && at?.lng() === to.lng;
}

function conceal(claim: number) {
	concealedFor = claim;
	container.style.transition = "none";
	container.style.opacity = "0";
}

function reveal() {
	concealedFor = null;
	container.style.transition = `opacity ${REVEAL_MS}ms ease`;
	container.style.opacity = "1";
}

function revealWhenReady(sv: google.maps.StreetViewPanorama, claim: number, to: PanoDestination) {
	conceal(claim);
	const off = on("status_changed", () => {
		const outgoing = sv.getStatus() === "OK" && typeof to === "string" && sv.getPano() !== to;
		if (claim === latestClaim && outgoing) return;
		off();
		if (claim === latestClaim) reveal();
	});
}

function resize() {
	if (viewer && google?.maps) google.maps.event.trigger(viewer, "resize");
}

function resolutionKey(loc: Location): string {
	return `${isPinned(loc) ? loc.panoId : ""}@${loc.lat},${loc.lng}`;
}

function resolveCached(loc: Location): Promise<Pano | null> {
	const key = resolutionKey(loc);
	const cached = resolutions.get(key);
	if (cached) return cached;
	const pending = resolvePano(loc).then(
		(resolved) => {
			if (!resolved) resolutions.delete(key);
			return resolved;
		},
		(error: unknown) => {
			resolutions.delete(key);
			throw error;
		},
	);
	resolutions.set(key, pending);
	if (resolutions.size > RESOLUTION_CAP) {
		const [oldest] = resolutions.keys();
		resolutions.delete(oldest);
	}
	return pending;
}

function reserveJump(): (to: PanoDestination, frame?: PanoFrame) => boolean {
	const claim = latestClaim;
	return (to, frame) => {
		const sv = ensureViewer();
		if (claim !== latestClaim || !sv) return false;
		latestClaim++;
		if (typeof to === "string") sv.setPano(to);
		else sv.setPosition(to);
		if (frame) applyFrame(sv, frame);
		reveal();
		return true;
	};
}

function jump(to: PanoDestination, frame?: PanoFrame) {
	reserveJump()(to, frame);
}

async function show(loc: Location): Promise<ShowResult> {
	const claim = ++latestClaim;
	const alreadyShown =
		viewer !== null && isPinned(loc) && loc.panoId !== null && isAt(viewer, loc.panoId);
	if (viewer && !alreadyShown) conceal(claim);
	let resolved: Pano | null;
	try {
		resolved = await resolveCached(loc);
	} catch (error) {
		if (claim === latestClaim) reveal();
		throw error;
	}
	if (claim !== latestClaim) return { status: "superseded" };
	const sv = ensureViewer();
	if (!sv) {
		reveal();
		return { status: "superseded" };
	}
	const to: PanoDestination = resolved?.id ? resolved.id : { lat: loc.lat, lng: loc.lng };
	if (isAt(sv, to)) reveal();
	else revealWhenReady(sv, claim, to);
	applyResolved(sv, resolved, loc);
	resize();
	return { status: "shown", pano: resolved };
}

async function preload(loc: Location): Promise<void> {
	const claim = latestClaim;
	const resolved = await resolveCached(loc);
	const sv = ensureViewer();
	if (claim !== latestClaim || concealedFor !== null || !sv || !resolved?.id) return;
	sv.setPano(resolved.id);
	sv.setPov({ heading: loc.heading, pitch: loc.pitch });
}

function reload(fallback: google.maps.LatLngLiteral) {
	if (!viewer) return;
	const panoId = viewer.getPano();
	const { heading, pitch } = viewer.getPov();
	const zoom = viewer.getZoom();
	clearViewer();
	if (!ensureViewer()) return;
	jump(panoId || fallback, { heading, pitch, zoom });
	viewer?.setVisible(true);
	resize();
}

function links(): google.maps.StreetViewLink[] {
	return (viewer?.getLinks() ?? []).filter((l): l is google.maps.StreetViewLink => l != null);
}

function step(direction: "forward" | "backward"): boolean {
	const available = links();
	if (!viewer || available.length === 0) return false;
	const heading = viewer.getPov().heading;
	const target = direction === "forward" ? heading : reverseHeading(heading);
	let best = available[0];
	let bestDiff = 360;
	for (const link of available) {
		const diff = Math.abs(normalizeHeading((link.heading ?? 0) - target));
		if (diff < bestDiff) {
			bestDiff = diff;
			best = link;
		}
	}
	if (best.pano) jump(best.pano);
	return true;
}

function jumpAhead(headingOffset: number): Promise<boolean> {
	const previous = jumpAheadPending;
	const pending = (async () => {
		await previous;
		const from = viewer?.getPosition();
		if (!viewer || !from || !google?.maps?.geometry) return false;
		const target = google.maps.geometry.spherical.computeOffset(
			from,
			SV_JUMP_RADIUS,
			viewer.getPov().heading + headingOffset,
		);
		const go = reserveJump();
		const found = await lookupStreetView(target.lat(), target.lng(), 0, {
			onlyOfficial: true,
			radius: SV_JUMP_RADIUS,
		});
		if (!found?.panoId) return false;
		return go(
			found.flags & LocationFlag.LoadAsPanoId ? found.panoId : { lat: found.lat, lng: found.lng },
		);
	})().catch(() => false);
	jumpAheadPending = pending;
	return pending;
}

function pov(): CameraFrame {
	const current = viewer?.getPov();
	return { heading: current?.heading ?? 0, pitch: current?.pitch ?? 0 };
}

function zoom(): number {
	return viewer?.getZoom() ?? PANO_ZOOM.min;
}

function captureView(): LocationPOV {
	return { ...pov(), zoom: storedZoom(zoom()) };
}

function capture(): PanoCapture | null {
	const at = viewer?.getPosition();
	if (!at) return null;
	return { ...captureView(), lat: at.lat(), lng: at.lng(), panoId: viewer?.getPano() || null };
}

function snapshot(): PanoView {
	const panoId = viewer?.getPano();
	const { heading, pitch } = pov();
	const current = viewer?.getZoom();
	if (
		!panoId ||
		!Number.isFinite(heading) ||
		!Number.isFinite(pitch) ||
		current === undefined ||
		!Number.isFinite(current)
	) {
		throw new Error("Street View is not ready");
	}
	return { panoId, heading, pitch, zoom: current };
}

function canvas(): HTMLCanvasElement | null {
	return sceneCanvas(container);
}

function captureImage(width: number, height: number): HTMLCanvasElement | null {
	const source = canvas();
	if (!source) return null;
	const out = drawScaled(source, width, height);
	return out && hasImagery(out) ? out : null;
}

function reserveLook(): (frame: PanoFrame) => boolean {
	const claim = latestClaim;
	return (frame) => {
		if (claim !== latestClaim || !viewer) return false;
		applyFrame(viewer, frame);
		return true;
	};
}

function look(frame: PanoFrame) {
	if (viewer) applyFrame(viewer, frame);
}

function nudge(dHeading: number, dPitch: number) {
	if (!viewer) return;
	const current = viewer.getPov();
	viewer.setPov({
		heading: wrapDeg(current.heading + dHeading, 0),
		pitch: clamp(current.pitch + dPitch, PANO_PITCH),
	});
}

function turnTo(target: CameraFrame) {
	activeTurn?.stop();
	const sv = viewer;
	if (!sv) return;
	const from = sv.getPov();
	const dh = normalizeHeading(from.heading - target.heading);
	const dp = from.pitch - target.pitch;
	const start = performance.now();
	let frame = 0;
	const turn = {
		target,
		stop: () => {
			cancelAnimationFrame(frame);
			if (activeTurn === turn) activeTurn = null;
		},
	};
	const tick = (now: number) => {
		const t = Math.min((now - start) / TURN_MS, 1);
		const eased = t * (2 - t);
		sv.setPov({
			heading: target.heading + dh * (1 - eased),
			pitch: target.pitch + dp * (1 - eased),
		});
		if (t < 1) frame = requestAnimationFrame(tick);
		else if (activeTurn === turn) activeTurn = null;
	};
	activeTurn = turn;
	frame = requestAnimationFrame(tick);
}

function pointNorth() {
	if (!viewer) return;
	const { heading, pitch } = activeTurn?.target ?? pov();
	if (Math.abs(normalizeHeading(heading)) < 1 && Math.abs(pitch) < 1) {
		viewer.setZoom(PANO_ZOOM.min);
		turnTo({ heading: 0, pitch: -90 });
	} else {
		turnTo({ heading: 0, pitch: 0 });
	}
}

function faceRoad() {
	const headings = links()
		.map((l) => l.heading)
		.filter((h): h is number => h != null);
	const nearest = nearestLinkHeading(headings, pov().heading);
	if (nearest != null) turnTo({ heading: nearest, pitch: 0 });
}

function turnAround() {
	if (!viewer) return;
	const { heading, pitch } = pov();
	turnTo({ heading: reverseHeading(heading), pitch });
}

function turnToNextLink() {
	const available = links();
	if (!viewer || activeTurn || available.length === 0) return;
	const heading = pov().heading;
	const next = available.reduce((best, cur) => {
		const bestDelta = wrapDeg((best.heading ?? 0) - heading, 0);
		const curDelta = wrapDeg((cur.heading ?? 0) - heading, 0);
		if (bestDelta <= 0.01) return cur;
		if (curDelta <= 0.01) return best;
		return curDelta < bestDelta ? cur : best;
	});
	turnTo({ heading: next.heading ?? 0, pitch: 0 });
}

function zoomIn() {
	if (viewer) viewer.setZoom(zoomInStep(viewer.getZoom()));
}

function zoomOut() {
	if (viewer) viewer.setZoom(zoomOutStep(viewer.getZoom()));
}

function resetZoom() {
	viewer?.setZoom(PANO_ZOOM.min);
}

function configure(options: google.maps.StreetViewPanoramaOptions) {
	viewer?.setOptions(options);
}

function hide() {
	viewer?.setVisible(false);
}

function attachToTopMount() {
	const top = mounts.at(-1);
	containerObserver?.disconnect();
	if (!top) {
		container.remove();
		return;
	}
	top.appendChild(container);
	containerObserver ??= new ResizeObserver(() => {
		cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(resize);
	});
	containerObserver.observe(top);
	resize();
}

function mount(target: HTMLElement): () => void {
	mounts.push(target);
	attachToTopMount();
	return () => {
		const index = mounts.lastIndexOf(target);
		if (index !== -1) mounts.splice(index, 1);
		attachToTopMount();
	};
}

function showCrosshair(): () => void {
	const overlay = document.createElement("canvas");
	Object.assign(overlay.style, {
		position: "absolute",
		top: "0",
		left: "0",
		pointerEvents: "none",
	});
	const draw = () => {
		const region = container.querySelector(CROSSHAIR_REGION);
		const ctx = overlay.getContext("2d");
		if (!region || !ctx) return;
		const { width, height } = region.getBoundingClientRect();
		overlay.width = width;
		overlay.height = height;
		const cx = Math.floor(width / 2);
		const cy = Math.floor(height / 2);
		const aspect = width / height;

		ctx.strokeStyle = "#000";
		ctx.lineWidth = 1;
		ctx.setLineDash([5, 5]);
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(width, height);
		ctx.moveTo(width, 0);
		ctx.lineTo(0, height);
		ctx.stroke();

		ctx.strokeStyle = "#f33";
		ctx.lineWidth = 3;
		ctx.setLineDash([]);
		ctx.beginPath();
		ctx.moveTo(cx - 5 * aspect, cy - 5);
		ctx.lineTo(cx + 5 * aspect, cy + 5);
		ctx.moveTo(cx + 5 * aspect, cy - 5);
		ctx.lineTo(cx - 5 * aspect, cy + 5);
		ctx.stroke();
	};
	const observer = new ResizeObserver(draw);
	const attach = () => {
		const region = container.querySelector(CROSSHAIR_REGION);
		if (region && !container.contains(overlay)) region.insertAdjacentElement("afterend", overlay);
		const scene = container.querySelector(".gm-style");
		if (scene) observer.observe(scene);
		draw();
	};
	const off = on("status_changed", attach);
	attach();
	return () => {
		off();
		observer.disconnect();
		overlay.remove();
	};
}

function toast(message: string, durationMs: number) {
	showToast(message, durationMs, viewerRoot(viewer) ?? container);
}

export const pano = {
	/** Resolve and show a location's pano; "superseded" when a newer request overtook it. */
	show,
	/** Move to a pano id or position now, optionally setting the camera, overtaking pending requests. */
	jump,
	/** Step to the linked pano nearest the camera heading, or its reverse. */
	step,
	/** Jump to the nearest official pano ahead of the camera, turned by `headingOffset` degrees. */
	jumpAhead,
	/** Stage a location's pano while nothing newer is pending, so a later show is instant. */
	preload,
	/** Rebuild a stuck viewer in place, keeping its pano and camera. */
	reload,
	/** Whether the viewer has been created. */
	exists: () => viewer !== null,
	/** Whether the viewer has finished loading its current pano. */
	isLoaded: () => viewer?.getStatus() === "OK",
	/** The current pano id, or null before one loads. */
	panoId: () => viewer?.getPano() || null,
	/** The current pano's position, or null before one loads. */
	position: (): google.maps.LatLngLiteral | null => {
		const at = viewer?.getPosition();
		return at ? { lat: at.lat(), lng: at.lng() } : null;
	},
	/** The camera heading and pitch. */
	pov,
	/** The viewer's display zoom. */
	zoom,
	/** The current pano's navigable links. */
	links,
	/** The camera in the stored zoom domain, zeroed without a viewer. */
	captureView,
	/** The viewer read back into Location fields, or null until it has a position. */
	capture,
	/** Freeze the live camera for an offscreen render; throws until a pano is ready. */
	snapshot,
	/** The live WebGL scene canvas, or null before the first render. */
	canvas,
	/** Cover-crop the live frame into an exact image, or null until real imagery renders. */
	captureImage,
	/** Point the camera now. */
	look,
	/** Reserve a camera move across an async wait; it lands only if nothing moved the pano since. */
	reserveLook,
	/** Nudge heading and pitch by a delta, keeping pitch in range. */
	nudge,
	/** Animate the camera to a frame, replacing any turn in progress. */
	turnTo,
	/** Face north level, or look straight down zoomed out when already facing north. */
	pointNorth,
	/** Face the linked road nearest the camera heading. */
	faceRoad,
	/** Turn to face the opposite direction. */
	turnAround,
	/** Turn to the next linked road clockwise from the camera. */
	turnToNextLink,
	/** Step the zoom in. */
	zoomIn,
	/** Step the zoom out. */
	zoomOut,
	/** Zoom fully out. */
	resetZoom,
	/** Listen to a viewer event, across viewer rebuilds; returns an unsubscribe. */
	on,
	/** Apply display options to the viewer. */
	configure,
	/** Hide the viewer. */
	hide,
	/** Parent the viewer into a container; the newest mount wins until released. */
	mount,
	/** Draw the crosshair over the viewer; returns a remove. */
	showCrosshair,
	/** Show a toast anchored over the viewer. */
	toast,
};
