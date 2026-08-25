import { init } from "./heatmap";
import { HeatmapSidebar } from "./HeatmapSidebar";

MMA.registerPlugin({
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
  sidebar: HeatmapSidebar,
});
