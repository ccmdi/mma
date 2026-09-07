// Utilities that reach Tauri (dialogs, IPC)
import { save } from "@tauri-apps/plugin-dialog";
import { cmd } from "@/lib/commands";
import { downloadBlob, isWeb, mmaBufUrl } from "@/lib/util/util";

// In a browser (web-serve) there's no native save dialog that returns a path for the
// backend to write to. Use the File System Access API to let the user pick a destination
// and stream the already-built temp export straight into it (no full read into memory).
// Falls back to a plain download where that API is unavailable. Null = cancelled.
async function downloadInBrowser(srcPath: string, fileName: string): Promise<string | null> {
	const url = mmaBufUrl(srcPath);
	const picker = (
		window as unknown as {
			showSaveFilePicker?: (o: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
		}
	).showSaveFilePicker;
	if (picker) {
		let handle: FileSystemFileHandle;
		try {
			handle = await picker({ suggestedName: fileName });
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return null;
			throw e;
		}
		const res = await fetch(url);
		if (!res.body) throw new Error("export stream unavailable");
		// Reached only behind the showSaveFilePicker feature test above, which the lint rule
		// can't see; without the picker we never get here and fall through to downloadBlob.
		// eslint-disable-next-line local/no-unsupported-builtins
		await res.body.pipeTo((await handle.createWritable()) as unknown as WritableStream<Uint8Array>);
		return handle.name;
	}
	downloadBlob(await (await fetch(url)).blob(), fileName);
	return fileName;
}

/** Prompt for a destination and move a temp export file there (native dialog in
 *  Tauri, File System Access / download in the browser). Returns the name it was saved
 *  under, which the user may have changed in the dialog. Null = cancelled. */
export async function saveExportTempFile(
	srcPath: string,
	fileName: string,
): Promise<string | null> {
	if (isWeb()) return downloadInBrowser(srcPath, fileName);
	const ext = fileName.split(".").pop() ?? "";
	const dest = await save({
		defaultPath: fileName,
		filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
	});
	if (!dest) return null;
	await cmd.storeSaveExportFile(srcPath, dest);
	return dest.split(/[/\\]/).at(-1) ?? fileName;
}
