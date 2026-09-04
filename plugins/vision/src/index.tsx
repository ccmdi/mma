import { VisionSidebar } from "./VisionSidebar";
import { FindSimilarButton } from "./FindSimilarButton";

const { registerPlugin } = MMA;

registerPlugin({
	activate() {},
	sidebar: VisionSidebar,
	locationPanel: FindSimilarButton,
	comingSoon: true
});
