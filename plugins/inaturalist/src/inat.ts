import { ScatterplotLayer } from "@deck.gl/layers";
import type { DeckOverlayHandle } from "mma-plugin-types";

const { createLocation, addLocations, getMapHost } = MMA;

export interface Observation {
	id: number;
	lat: number;
	lng: number;
	name: string;
	photo: string | null;
	observed_at: string | null;
}

export interface Taxon {
	id: number;
	name: string;
	commonName: string | null;
	rank: string;
	count: number;
	photoUrl: string | null;
}

interface TileEntry {
	data: Observation[];
	expiresAt: number;
}

const TILE_TTL = 5 * 60 * 1000;
const MAX_TILES = 300;
const MAX_RENDER = 50_000;

const tileCache = new Map<string, TileEntry>();
const observationsById = new Map<number, Observation>();
let overlay: DeckOverlayHandle | null = null;
let currentTaxonId: number | null = null;
let currentTaxonName: string | null = null;
let visible = true;
let listeners: (() => void)[] = [];
let onUpdate: (() => void) | null = null;

export function setOnUpdate(cb: (() => void) | null) {
	onUpdate = cb;
}

export function getObservations(): Observation[] {
	return Array.from(observationsById.values());
}

export function getCurrentTaxon(): { id: number; name: string } | null {
	if (!currentTaxonId) return null;
	return { id: currentTaxonId, name: currentTaxonName ?? "Unknown" };
}

export function isVisible(): boolean {
	return visible;
}

export function toggleVisibility() {
	visible = !visible;
	if (visible) render();
	else overlay?.setProps({ layers: [] });
	onUpdate?.();
}

export function clearData() {
	observationsById.clear();
	tileCache.clear();
	currentTaxonId = null;
	currentTaxonName = null;
	overlay?.setProps({ layers: [] });
	onUpdate?.();
}

export async function searchTaxa(query: string): Promise<Taxon[]> {
	const res = await fetch(
		`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(query)}&per_page=20`,
	);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	return (data.results ?? []).map((t: Record<string, unknown>) => ({
		id: t.id as number,
		name: t.name as string,
		commonName: (t.preferred_common_name as string) ?? null,
		rank: (t.rank as string) ?? "",
		count: (t.observations_count as number) ?? 0,
		photoUrl: (t.default_photo as Record<string, string> | null)?.square_url ?? null,
	}));
}

export function selectTaxon(taxon: Taxon) {
	observationsById.clear();
	tileCache.clear();
	currentTaxonId = taxon.id;
	currentTaxonName = taxon.commonName ?? taxon.name;
	loadViewport();
	onUpdate?.();
}

export function importToMap() {
	const obs = getObservations();
	if (obs.length === 0) return 0;
	const locs = obs.map((o) =>
		createLocation({ lat: o.lat, lng: o.lng, extra: { tags: [o.name] } }),
	);
	addLocations(locs);
	return locs.length;
}

export async function init(): Promise<() => void> {
	const host = getMapHost();
	if (!host) throw new Error("No map instance");

	overlay = host.createDeckOverlay();

	const throttled = throttle(() => loadViewport(), 400);
	listeners = [host.on("camera", throttled)];

	return () => {
		for (const un of listeners) un();
		listeners = [];
		if (overlay) {
			overlay.finalize();
			overlay = null;
		}
		observationsById.clear();
		tileCache.clear();
		currentTaxonId = null;
		currentTaxonName = null;
		onUpdate = null;
	};
}

function throttle(fn: () => void, ms: number): () => void {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	return () => {
		const now = Date.now();
		if (now - last >= ms) {
			last = now;
			fn();
		} else if (!timer) {
			timer = setTimeout(() => {
				last = Date.now();
				timer = null;
				fn();
			}, ms - (now - last));
		}
	};
}

function tileKey(z: number, x: number, y: number): string {
	return `${z}/${x}/${y}`;
}

function lngToTileX(lng: number, z: number): number {
	return Math.floor(((lng + 180) / 360) * (1 << z));
}

function latToTileY(lat: number, z: number): number {
	const r = (lat * Math.PI) / 180;
	return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z));
}

function tileToBbox(x: number, y: number, z: number) {
	const n = 1 << z;
	return {
		west: (x / n) * 360 - 180,
		east: ((x + 1) / n) * 360 - 180,
		north: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
		south: (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI,
	};
}

function computeTileZoom(mapZoom: number): number {
	return Math.max(1, Math.min(10, Math.floor(mapZoom) - 2));
}

async function fetchTile(
	taxonId: number,
	bbox: { north: number; south: number; east: number; west: number },
): Promise<Observation[]> {
	const url =
		`https://api.inaturalist.org/v1/observations?` +
		`taxon_id=${taxonId}` +
		`&nelat=${bbox.north}&nelng=${bbox.east}` +
		`&swlat=${bbox.south}&swlng=${bbox.west}` +
		`&per_page=200&page=1`;
	const res = await fetch(url);
	if (!res.ok) return [];
	const data = await res.json();
	return (data.results ?? [])
		.map((d: Record<string, unknown>) => {
			const geo = d.geojson as { coordinates: [number, number] } | null;
			return {
				id: d.id as number,
				lat: geo?.coordinates?.[1],
				lng: geo?.coordinates?.[0],
				name: (d.species_guess as string) ?? "Unknown",
				photo:
					(
						(d.observation_photos as Array<{ photo: { url: string } }> | null)?.[0]
							?.photo?.url ?? ""
					).replace("square", "medium") || null,
				observed_at: (d.time_observed_at as string) ?? (d.observed_on as string) ?? null,
			};
		})
		.filter((o: Observation) => o.lat != null && o.lng != null);
}

async function loadViewport() {
	if (!currentTaxonId || !visible) return;
	const host = getMapHost();
	if (!host) return;
	const bounds = host.getBounds();
	if (!bounds) return;

	const tz = computeTileZoom(host.getZoom());

	const xMin = lngToTileX(bounds.west, tz);
	const xMax = lngToTileX(bounds.east, tz);
	const yMin = latToTileY(bounds.north, tz);
	const yMax = latToTileY(bounds.south, tz);

	const now = Date.now();
	const fetches: Promise<void>[] = [];

	for (let x = xMin; x <= xMax; x++) {
		for (let y = yMin; y <= yMax; y++) {
			const key = tileKey(tz, x, y);
			const cached = tileCache.get(key);
			if (cached && cached.expiresAt > now) {
				for (const o of cached.data) observationsById.set(o.id, o);
				continue;
			}

			fetches.push(
				fetchTile(currentTaxonId!, tileToBbox(x, y, tz)).then((obs) => {
					tileCache.set(key, { data: obs, expiresAt: Date.now() + TILE_TTL });
					if (tileCache.size > MAX_TILES) {
						const oldest = tileCache.keys().next().value!;
						tileCache.delete(oldest);
					}
					for (const o of obs) observationsById.set(o.id, o);
				}),
			);
		}
	}

	if (fetches.length > 0) await Promise.all(fetches);

	render();
	onUpdate?.();
}

function render() {
	if (!overlay || !visible) return;
	let data = Array.from(observationsById.values());
	if (data.length > MAX_RENDER) {
		const step = Math.ceil(data.length / MAX_RENDER);
		data = data.filter((_, i) => i % step === 0);
	}
	if (data.length === 0) {
		overlay.setProps({ layers: [] });
		return;
	}
	overlay.setProps({
		layers: [
			new ScatterplotLayer<Observation>({
				id: "inat-observations",
				data,
				getPosition: (d) => [d.lng, d.lat],
				getRadius: 5,
				radiusUnits: "pixels",
				getFillColor: [255, 120, 0, 180],
				pickable: true,
			}),
		],
	});
}
