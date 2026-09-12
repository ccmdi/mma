const { registerPlugin } = window.MMA;
import { mdiGamepadVariantOutline } from "@mdi/js";
import { msg } from "@/lib/i18n";
import { LocalGuessrSidebar } from "./LocalGuessrSidebar";

registerPlugin({
	id: "localguessr",
	name: "LocalGuessr",
	description: msg("Play a guessing game on your own map, and tag rounds as you go"),
	icon: mdiGamepadVariantOutline,
	experimental: true,
	keepAlive: true,
	sidebar: LocalGuessrSidebar,
	activate() {},
});
