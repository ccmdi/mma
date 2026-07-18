/**
 * Provider coverage line layers for the Google map stack.
 * Same type and band as Google SV: ImageMapType, after SV, under labels.
 */
import { createSyncStore } from "@/lib/util/syncStore";

export type LineLayerFactory = () => google.maps.ImageMapType[];

const factories: LineLayerFactory[] = [];
const store = createSyncStore();

export function registerProviderLineLayers(factory: LineLayerFactory): () => void {
	factories.push(factory);
	store.notify();
	return () => {
		const i = factories.indexOf(factory);
		if (i >= 0) factories.splice(i, 1);
		store.notify();
	};
}

/** Fresh ImageMapType instances for the current provider settings (built like Google SV). */
export function getProviderLineLayers(): google.maps.ImageMapType[] {
	const out: google.maps.ImageMapType[] = [];
	for (const f of factories) {
		try {
			out.push(...f());
		} catch {
			/* ignore */
		}
	}
	return out;
}

/** Notify map hosts (re-applyPrefs) and deck surfaces to refresh coverage. */
export function bumpProviderCoverageLayers(): void {
	store.notify();
}

export function subscribeProviderCoverageLayers(cb: () => void): () => void {
	return store.subscribe(cb);
}

export function getProviderCoverageLayersEpoch(): number {
	return store.getSnapshot();
}
