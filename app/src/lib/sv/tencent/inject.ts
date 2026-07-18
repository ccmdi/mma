/**
 * Tencent Google bridge — shared inject via providers/googleInject.
 * Kept as a thin re-export so existing imports keep working.
 */
export {
	installGoogleInjectBridge as installTencentGoogleBridge,
	installGoogleInjectBridge as installChinaGoogleBridge,
	installGoogleInjectBridge,
	isGoogleInjectBridgeInstalled as isTencentBridgeInstalled,
	isGoogleInjectBridgeInstalled as isChinaBridgeInstalled,
	isGoogleInjectBridgeInstalled,
} from "@/lib/sv/providers/googleInject";
