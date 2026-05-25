import { useSyncExternalStore } from "react";
import { log } from "@/lib/util/log";

interface UpdateInfo {
	version: string;
	dismissed: boolean;
}

let updateInfo: UpdateInfo | null = null;
const listeners = new Set<() => void>();

function notify() {
	for (const fn of listeners) fn();
}

const DISMISS_KEY = "mma-update-dismissed-version";

export async function checkForUpdateOnStartup() {
	try {
		const { check } = await import("@tauri-apps/plugin-updater");
		const update = await check();
		if (update) {
			const dismissed = localStorage.getItem(DISMISS_KEY) === update.version;
			updateInfo = { version: update.version, dismissed };
			log.info(`[updater] update available: v${update.version}`);
			notify();
		}
	} catch (e) {
		log.warn("[updater] startup check failed:", e);
	}
}

export function dismissUpdate() {
	if (!updateInfo) return;
	localStorage.setItem(DISMISS_KEY, updateInfo.version);
	updateInfo = { ...updateInfo, dismissed: true };
	notify();
}

function subscribe(fn: () => void) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function getSnapshot(): UpdateInfo | null {
	return updateInfo;
}

export function useUpdateAvailable(): UpdateInfo | null {
	return useSyncExternalStore(subscribe, getSnapshot);
}
