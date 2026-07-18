import { Icon } from "@/components/primitives/Icon";
import { BaiduIcon } from "@/components/editor/providers/BaiduIcon";
import { PROVIDER_CATALOG } from "@/lib/sv/providers/settings";
import type { AltSvProviderId } from "@/lib/sv/providers/types";
import { mdiQqchat } from "@mdi/js";

/** Provider brand icon (MDI path or custom SVG). */
export function ProviderIcon({
	id,
	size = 16,
	className,
}: {
	id: AltSvProviderId;
	size?: number;
	className?: string;
}) {
	if (id === "baidu") return <BaiduIcon size={size} className={className} />;
	if (id === "tencent") return <Icon path={mdiQqchat} size={size} className={className} />;
	const path = PROVIDER_CATALOG.find((p) => p.id === id)?.icon;
	if (!path) return null;
	return <Icon path={path} size={size} className={className} />;
}
