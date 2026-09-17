import { cmd } from "@/lib/commands";
import type { SeenEntry, SeenFilter, SeenMapInfo } from "@/bindings.gen";

/** Fetch a page of the seen (visited-panorama) history. */
export async function getSeenEntries(
	limit = 100,
	offset = 0,
	filter?: SeenFilter,
	thumbnails = true,
): Promise<SeenEntry[]> {
	return cmd.storeSeenList(limit, offset, filter ?? null, thumbnails);
}

/** Number of seen entries matching the filter (all when omitted). */
export async function getSeenCount(filter?: SeenFilter): Promise<number> {
	return cmd.storeSeenCount(filter ?? null);
}

/** Distinct country codes that appear in the seen history. */
export async function getSeenCountries(): Promise<string[]> {
	return cmd.storeSeenCountries();
}

/** Maps that have seen-history entries. */
export async function getSeenMaps(): Promise<SeenMapInfo[]> {
	return cmd.storeSeenMaps();
}

/** Delete the entire seen history. Not undoable. */
export async function clearSeen(): Promise<void> {
	await cmd.storeSeenClear();
}
