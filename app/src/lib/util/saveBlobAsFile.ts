import { save } from "@tauri-apps/plugin-dialog";
import { cmd } from "@/lib/commands";
import { isWeb } from "@/lib/util/util";

export interface SaveBlobOptions {
	suggestedName: string;
	extension: string;
	filterName?: string;
}

/** Save a blob via native save dialog (Tauri) or browser download / File System Access API (web). */
export async function saveBlobAsFile(blob: Blob, opts: SaveBlobOptions): Promise<boolean> {
	const { suggestedName, extension, filterName = extension.toUpperCase() } = opts;

	if (isWeb()) {
		const picker = (
			window as unknown as {
				showSaveFilePicker?: (o: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
			}
		).showSaveFilePicker;
		if (picker) {
			try {
				const handle = await picker({ suggestedName });
				const writable = (await handle.createWritable()) as unknown as WritableStream<Uint8Array>;
				await blob.stream().pipeTo(writable);
				return true;
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") return false;
				throw e;
			}
		}
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = suggestedName;
		a.click();
		URL.revokeObjectURL(a.href);
		return true;
	}

	const bytes = new Uint8Array(await blob.arrayBuffer());
	const tempPath = await cmd.writeTempBytes(extension, Array.from(bytes));
	const dest = await save({
		defaultPath: suggestedName,
		filters: [{ name: filterName, extensions: [extension] }],
	});
	if (!dest) return false;
	await cmd.storeSaveExportFile(tempPath, dest);
	return true;
}
