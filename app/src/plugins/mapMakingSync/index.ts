const { registerPlugin } = window.MMA;
import { mdiSync } from "@mdi/js";
import { SyncSidebar } from "./SyncSidebar";
import { getLink, livePref, startLive, stopLive } from "./controller";

registerPlugin({
	id: "map-making-sync",
	name: "map-making.app sync",
	description: "Bidirectional sync with map-making.app maps",
	icon: mdiSync,
	sidebar: SyncSidebar,
	activate() {
		const M = window.MMA;
		// Resume the live loop when a linked map is (re)opened and live was left on.
		const resume = () => {
			if (getLink() && livePref()) startLive();
		};
		resume();
		const offOpen = M.on("map:open", resume);
		const offClose = M.on("map:close", stopLive);
		return () => {
			offOpen();
			offClose();
			stopLive();
		};
	},
});
