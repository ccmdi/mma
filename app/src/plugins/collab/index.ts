const { registerPlugin } = window.MMA;
import { mdiAccountGroup } from "@mdi/js";
import { CollabBadge, CollabDialog } from "./CollabDialog";
import { CollabHeader } from "./CollabHeader";
import { SessionNotice } from "./SessionNotice";
import { Presence } from "./presence";
import { msg } from "@/lib/i18n";

registerPlugin({
	id: "collab",
	name: "Collaboration",
	description: msg("Work on a map together in real time"),
	icon: mdiAccountGroup,
	experimental: true,
	onMapList: true,
	modal: CollabDialog,
	badge: CollabBadge,
	headerItem: CollabHeader,
	layer: SessionNotice,
	activate: Presence.mount,
});
