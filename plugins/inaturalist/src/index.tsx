import { init } from "./inat";
import { INatSidebar } from "./INatSidebar";

const { registerPlugin } = MMA;

registerPlugin({
	activate() {
		let cancelled = false;
		let teardown: (() => void) | null = null;

		(async () => {
			if (cancelled) return;
			teardown = await init();
		})();

		return () => {
			cancelled = true;
			teardown?.();
		};
	},
	sidebar: INatSidebar,
});
