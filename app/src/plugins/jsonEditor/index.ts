const { registerPlugin } = window.MMA;
import { JsonEditorPanel } from "./JsonEditorPanel";
import { mdiCodeBraces } from "@mdi/js";

if (import.meta.env.DEV) {
	registerPlugin({
		id: "json-editor",
		name: "JSON editor",
		description: "View and edit location data as JSON",
		icon: mdiCodeBraces,
		activate() {},
		locationPanel: JsonEditorPanel,
	});
}
