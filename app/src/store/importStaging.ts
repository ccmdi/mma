import { bboxTupleToBounds, isVirtualLocation } from "@/types";
import type { EditorImportPreview } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { mmaBufUrl } from "@/lib/util/util";
import { fitMapToBounds } from "@/lib/map/mapState";
import { getSettings } from "@/store/settings";
import { whenSceneSettled } from "@/lib/render/sceneStore";
import { emit as emitEvent } from "@/lib/events";
import {
	mutate,
	getMapState,
	setWorkArea,
	updateMapMeta,
	waitForInflightPersist,
	cancelAutosave,
	scheduleAutoCommit,
} from "./useMapStore";

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
	preview: EditorImportPreview;
	source: "file" | "paste";
}

const EMPTY_IMPORT = { staging: null, positions: new Float32Array(0) };
let importState: { staging: ImportStaging | null; positions: Float32Array } = EMPTY_IMPORT;

export function getImportPreviewPositions() {
	return importState.positions;
}

export function getImportStaging() {
	return importState.staging;
}

/** Reset import state (called when map edit state is cleared). */
export function resetImportState() {
	importState = EMPTY_IMPORT;
}

async function setImportStaging(preview: EditorImportPreview, source: "file" | "paste") {
	let positions = new Float32Array(0);
	try {
		const resp = await fetch(mmaBufUrl(preview.previewPositionsPath));
		if (!resp.ok) throw new Error(`preview fetch ${resp.status}: ${await resp.text()}`);
		positions = new Float32Array(await resp.arrayBuffer());
	} catch (e) {
		log.error("[import] preview positions fetch failed:", e);
	}
	importState = { staging: { preview, source }, positions };
	emitEvent("import-markers:changed");
	setWorkArea("import");
	if (getSettings().panToImported)
		fitMapToBounds(bboxTupleToBounds(preview.bounds), 100, getSettings().pastePadding);
}

/** Import from a known file path. Used by file picker and drag-and-drop. */
export async function beginImportFromPath(path: string) {
	await setImportStaging(await cmd.storeImportPreview(path), "file");
}

/** Stage pasted text for preview. Throws if no locations are found. */
export async function beginImportPaste(text: string) {
	await setImportStaging(await cmd.storeImportPastePreview(text), "paste");
}

/** Commit the staged import, optionally dropping fields and applying a bulk tag. */
export async function confirmImport(droppedFields: string[], tagName?: string) {
	if (!importState.staging) return null;
	await waitForInflightPersist();

	const r = await cmd.storeImportFile(droppedFields, tagName?.trim() || null);
	cancelImport();
	await mutate(() => Promise.resolve(r));

	const map = getMapState().map;
	if (map && r.settings && Object.keys(r.settings).length) {
		await updateMapMeta({ settings: { ...map.settings, ...r.settings } });
	}

	if (r.autoCommit) {
		const mapId = getMapState().mapId;
		if (mapId) {
			await whenSceneSettled();
			cancelAutosave();
			await waitForInflightPersist();
			scheduleAutoCommit(mapId, r.importedCount);
		}
	}
	return r;
}

/** Discard the staged import without committing. */
export function cancelImport() {
	importState = EMPTY_IMPORT;
	emitEvent("import-markers:changed");
	const active = getMapState().activeLocation;
	if ((active && isVirtualLocation(active)) || getMapState().workArea === "import") {
		setWorkArea("overview");
	} else {
		emitEvent("store:changed");
	}
}
