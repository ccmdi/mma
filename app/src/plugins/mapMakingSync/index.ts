const { registerPlugin } = window.MMA;
import { mapMakingApp } from "@/components/primitives/Icon";
import { SyncSidebar } from "./SyncSidebar";
import { adoptStoredKey, controller } from "./controller";
import { activateSyncPlugin } from "@/lib/sync/controller";
import { msg } from "@/lib/i18n";
import { log } from "@/lib/util/log";

registerPlugin({
	id: "map-making-sync",
	name: "map-making.app sync",
	description: msg("Bidirectional sync with map-making.app maps"),
	icon: mapMakingApp,
	experimental: true,
	sidebar: SyncSidebar,
	activate: () => {
		adoptStoredKey().catch((e: unknown) => log.warn("[map-making-sync] key adoption failed", e));
		return activateSyncPlugin(controller);
	},
});
