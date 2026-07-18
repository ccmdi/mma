/**
 * Baidu Google bridge — shared inject via providers/googleInject.
 * Kept as a thin re-export so existing imports keep working.
 */
export {
	installGoogleInjectBridge as installBaiduGoogleBridge,
	installGoogleInjectBridge as installChinaGoogleBridge,
	installGoogleInjectBridge,
	isGoogleInjectBridgeInstalled as isBaiduBridgeInstalled,
	isGoogleInjectBridgeInstalled as isChinaBridgeInstalled,
	isGoogleInjectBridgeInstalled,
} from "@/lib/sv/providers/googleInject";
