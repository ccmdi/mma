const { registerPlugin } = window.MMA;
import { ValiSidebar } from "./ui/ValiSidebar";
import { mdiEarth } from "@mdi/js";

registerPlugin({
	id: "vali",
	name: "Vali",
	description: "Generate locations from pre-built coverage data using Vali",
	icon: mdiEarth,
	keepAlive: true,
	activate() {},
	sidebar: ValiSidebar,
});
