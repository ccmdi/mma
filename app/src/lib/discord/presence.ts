import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cmd } from "@/lib/commands";
import { getMapState } from "@/store/useMapStore";
import { subscribe, MAP_LIFECYCLE_EVENTS, LOCATION_DATA_EVENTS } from "@/lib/events";
import { useSetting } from "@/store/settings";
import type { DiscordPresenceMode } from "@/store/settings";
import type { PresenceActivity } from "@/bindings.gen";
import { isWeb } from "@/lib/util/util";
import { t } from "@/lib/i18n";

// Art-asset key uploaded to the Discord application (developer portal -> Rich Presence).
const LARGE_IMAGE = "logo";
const APP_NAME = "Map Making App";
const PUSH_INTERVAL_MS = 4000;

/** Start of the current editing session (unix seconds); reset on each map open. */
let sessionStart: number | null = null;

function buildActivity(level: Exclude<DiscordPresenceMode, "off">): PresenceActivity {
	const map = getMapState().map;
	const base: PresenceActivity = {
		details: null,
		state: null,
		largeImage: LARGE_IMAGE,
		largeText: APP_NAME,
		smallImage: null,
		smallText: null,
		start: null,
	};
	if (!map) return { ...base, details: "In the map list" };

	const start = sessionStart;
	if (level === "generic") return { ...base, details: "Editing a map", start };

	const count = getMapState().locationCount;
	return {
		...base,
		details: `Editing ${map.meta.name}`,
		state: t({ one: "{n} location", other: "{n} locations" }, { n: count }),
		start,
	};
}

/** Mirror the current editing state to Discord Rich Presence when opted in.
 *  No-op on web (the IPC pipe is desktop-only) and when the setting is off. */
export function useDiscordPresence(): void {
	const level = useSetting("discordPresence");

	useEffect(() => {
		if (isWeb() || level === "off") {
			void cmd.discordPresenceClear();
			return;
		}

		const win = getCurrentWindow();
		let timer: ReturnType<typeof setTimeout> | null = null;
		// Only the focused window drives presence, so multiple map windows never fight
		// over the single process-global connection -- the map in front always wins.
		let focused = false;
		const push = () => {
			if (focused) void cmd.discordPresenceSet(buildActivity(level));
		};
		// Trailing throttle: bursts (import, bulk edits) collapse into one push.
		const schedule = () => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				push();
			}, PUSH_INTERVAL_MS);
		};

		if (getMapState().map && sessionStart === null) sessionStart = Math.floor(Date.now() / 1000);
		void win.isFocused().then((f) => {
			focused = f;
			push();
		});

		const unsubOpen = subscribe("map:open", () => {
			sessionStart = Math.floor(Date.now() / 1000);
			push();
		});
		const unsubClose = subscribe("map:close", () => {
			sessionStart = null;
			push();
		});
		const unsubData = [...MAP_LIFECYCLE_EVENTS, ...LOCATION_DATA_EVENTS]
			.filter((e) => e !== "map:open" && e !== "map:close")
			.map((e) => subscribe(e, schedule));
		// On focus gain, this window takes over presence; on blur, hold last state.
		const unlistenFocus = win.onFocusChanged(({ payload }) => {
			focused = payload;
			if (payload) push();
		});

		return () => {
			if (timer) clearTimeout(timer);
			unsubOpen();
			unsubClose();
			unsubData.forEach((u) => u());
			void unlistenFocus.then((u) => u());
		};
	}, [level]);
}
