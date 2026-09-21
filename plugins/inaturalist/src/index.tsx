import { init } from "./inat";
import { INatSidebar } from "./INatSidebar";

const { registerPlugin } = MMA;

registerPlugin({
	activate: init,
	sidebar: INatSidebar,
});
