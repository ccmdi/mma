import { init } from "./heatmap";
import { HeatmapSidebar } from "./HeatmapSidebar";

const { registerPlugin } = MMA;

registerPlugin({
  activate: init,
  sidebar: HeatmapSidebar,
});
