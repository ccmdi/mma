import { useSyncExternalStore } from "react";
import {
	getHeaderProviderId,
	subscribeProvidersSettings,
} from "@/lib/sv/providers/settings";
import type { AltSvProviderId } from "@/lib/sv/providers/types";

/** Header button: last enabled provider id (while still on), else null. */
export function useSoleEnabledProviderId(): AltSvProviderId | null {
	return useSyncExternalStore(
		subscribeProvidersSettings,
		getHeaderProviderId,
		() => null,
	);
}
