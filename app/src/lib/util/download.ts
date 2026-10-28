import { isWeb } from "@/lib/util/util";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";

/** Trigger a browser download from an in-memory Blob. @api @unstable */
export function downloadBlob(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	a.click();
	URL.revokeObjectURL(url);
	// The desktop webview saves without any browser download bar.
	if (!isWeb()) toast(t("Downloaded {file}", { file: fileName }));
}
