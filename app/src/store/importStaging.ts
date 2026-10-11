import { bboxTupleToBounds } from "@/types";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { EditorImportPreview, Target } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { mmaBufUrl } from "@/lib/util/util";
import { fitMapToBounds } from "@/lib/map/mapState";
import { getSettings } from "@/store/settings";
import * as autosave from "@/store/autosave";
import { whenSceneSettled } from "@/lib/render/sceneStore";
import { emit as emitEvent } from "@/lib/events";
import { settled, getMapState, setWorkArea } from "./useMapStore";
import * as edit from "./edit";

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
	preview: EditorImportPreview;
}

const EMPTY_IMPORT = { staging: null, positions: new Float32Array(0) };
let importState: { staging: ImportStaging | null; positions: Float32Array } = EMPTY_IMPORT;

/** The preview marker positions for the staged import. */
export function getImportPreviewPositions() {
	return importState.positions;
}

/** The current staged import, or null if none. */
export function getImportStaging() {
	return importState.staging;
}

/** The pending layer holding this window's staged import locations. */
export function importTarget(): Target {
	return { kind: "pending", name: `import:${getCurrentWebviewWindow().label}` };
}

/** Discard the staged import and its pending layer. */
export function resetImportState() {
	importState = EMPTY_IMPORT;
	void cmd.storeImportCancel().catch((e: unknown) => log.error("[import] cancel failed:", e));
}

async function setImportStaging(preview: EditorImportPreview) {
	let positions = new Float32Array(0);
	try {
		const resp = await fetch(mmaBufUrl(preview.previewPositionsPath));
		if (!resp.ok) throw new Error(`preview fetch ${resp.status}: ${await resp.text()}`);
		positions = new Float32Array(await resp.arrayBuffer());
	} catch (e) {
		log.error("[import] preview positions fetch failed:", e);
	}
	importState = { staging: { preview }, positions };
	emitEvent("import-markers:changed");
	setWorkArea("import");
	if (getSettings().panToImported)
		fitMapToBounds(bboxTupleToBounds(preview.bounds), 100, getSettings().pastePadding);
}

/** Import from a file path. */
export async function beginImportFromPath(path: string) {
	await setImportStaging(await cmd.storeImportPreview(path));
}

/** Stage pasted text for preview. Throws if no locations are found. */
export async function beginImportPaste(text: string) {
	await setImportStaging(await cmd.storeImportPastePreview(text));
}

/** Commit the staged import, optionally dropping fields and applying bulk tags. */
export async function confirmImport(droppedFields: string[], tagNames: string[] = []) {
	if (!importState.staging) return null;
	await autosave.waitForInflight();

	const settings = importState.staging.preview.settings;
	const r = await cmd.storeImportFile(droppedFields, tagNames.map((n) => n.trim()).filter(Boolean));
	cancelImport();
	await settled(r.mutation);

	const map = getMapState().map;
	if (map && Object.keys(settings).length) {
		await edit.meta({ settings: { ...map.settings, ...settings } });
	}

	if (r.autoCommit) {
		const mapId = getMapState().mapId;
		if (mapId) {
			await whenSceneSettled();
			autosave.cancel();
			await autosave.waitForInflight();
			autosave.scheduleAutoCommit(mapId, r.importedCount);
		}
	}
	return r;
}

/** Discard the staged import without committing. */
export function cancelImport() {
	resetImportState();
	emitEvent("import-markers:changed");
	if (getMapState().open?.origin === "import" || getMapState().workArea === "import") {
		setWorkArea("overview");
	} else {
		emitEvent("store:changed");
	}
}
