import { getScene } from "@/lib/render/sceneStore";

/** Snapshot of every rendered location's id and position (`[lng, lat, ...]`). */
export function getScenePositions(): { ids: Uint32Array; positions: Float32Array } {
	const scene = getScene();
	const ids = new Uint32Array(scene.totalCount);
	const positions = new Float32Array(scene.totalCount * 2);
	let n = 0;
	scene.forEachPosition((id, lng, lat) => {
		ids[n] = id;
		positions[n * 2] = lng;
		positions[n * 2 + 1] = lat;
		n++;
	});
	return { ids, positions };
}
