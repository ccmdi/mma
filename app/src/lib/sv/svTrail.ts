import { emit as emitEvent } from "@/lib/events";

let trail: [number, number][] = [];

export function resetTrail(lng: number, lat: number) {
	trail = [[lng, lat]];
	emitEvent("trail:changed");
}

export function pushTrail(lng: number, lat: number) {
	const last = trail.at(-1);
	if (last?.[0] === lng && last[1] === lat) return;
	trail = [...trail, [lng, lat]];
	emitEvent("trail:changed");
}

export function clearTrail() {
	if (trail.length === 0) return;
	trail = [];
	emitEvent("trail:changed");
}

export function getTrail(): [number, number][] {
	return trail;
}
