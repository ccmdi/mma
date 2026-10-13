import { Store } from "@/store/store";
import { Mutation } from "@/store/mutation";
import { Editor } from "@/store/editor";
import { Autosave } from "@/store/autosave";
import { Commit } from "@/store/commit";
import { Edit } from "./edit";
import { bboxTupleToBounds } from "@/types";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { EditorImportPreview, Target } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { mmaBufUrl } from "@/lib/util/util";
import { MapHost } from "@/lib/map/host";
import { getSettings } from "@/store/settings";
import { Scene } from "@/lib/render/scene";
import { emit as emitEvent } from "@/lib/events";

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
	preview: EditorImportPreview;
}

const EMPTY_IMPORT = { staging: null, positions: new Float32Array(0) };
let importState: { staging: ImportStaging | null; positions: Float32Array } = EMPTY_IMPORT;

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
	Editor.setArea("import");
	if (getSettings().panToImported)
		MapHost.fitToBounds(bboxTupleToBounds(preview.bounds), 100, getSettings().pastePadding);
}

export const Import = {
	/** The preview marker positions for the staged import. */
	previewPositions: () => {
		return importState.positions;
	},
	/** The current staged import, or null if none. */
	staging: () => {
		return importState.staging;
	},
	/** The pending layer holding this window's staged import locations. */
	target: (): Target => {
		return { kind: "pending", name: `import:${getCurrentWebviewWindow().label}` };
	},
	/** Discard the staged import and its pending layer. */
	reset: () => {
		importState = EMPTY_IMPORT;
		void cmd.storeImportCancel().catch((e: unknown) => log.error("[import] cancel failed:", e));
	},
	/** Import from a file path. */
	fromPath: async (path: string) => {
		await setImportStaging(await cmd.storeImportPreview(path));
	},
	/** Stage pasted text for preview. Throws if no locations are found. */
	paste: async (text: string) => {
		await setImportStaging(await cmd.storeImportPastePreview(text));
	},
	/** Commit the staged import, optionally dropping fields and applying bulk tags. */
	confirm: async (droppedFields: string[], tagNames: string[] = []) => {
		if (!importState.staging) return null;
		await Autosave.waitForInflight();

		const settings = importState.staging.preview.settings;
		const r = await cmd.storeImportFile(
			droppedFields,
			tagNames.map((n) => n.trim()).filter(Boolean),
		);
		Import.cancel();
		await Mutation.settle(r.mutation);

		if (Object.keys(settings).length) await Edit.meta({ settings });

		if (r.autoCommit) {
			const mapId = Store.get().mapId;
			if (mapId) {
				await Scene.settled();
				Commit.background(mapId, `Import ${r.importedCount} locations`);
			}
		}
		return r;
	},
	/** Discard the staged import without committing. */
	cancel: () => {
		Import.reset();
		emitEvent("import-markers:changed");
		if (Editor.get().open?.origin === "import" || Editor.get().workArea === "import")
			Editor.setArea("overview");
	},
};
