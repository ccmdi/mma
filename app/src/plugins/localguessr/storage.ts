import { createPluginStorage } from "@/plugins/registry";
import { getSeenCount, getSeenEntries } from "@/lib/seen/seen";
import type { Game, PastGame, Session, StreakMode } from "./game";

const storage = createPluginStorage("localguessr");
const SAVED_GAME = "savedGame";
const GLOBAL_STREAK = "globalStreak";
const HISTORY = "history";

/**
 * The one in-flight game per map, kept so closing the sidebar mid-round isn't a loss.
 * Keyed by the map the rounds were drawn from: their location ids and tags mean nothing
 * on any other map. Only the drawn rounds are stored, never the pool they came from.
 */
export function getSavedGame(mapId: string): Game | null {
	const game = storage.get<Game | null>(`${SAVED_GAME}:${mapId}`, null);
	return game && game.mapId === mapId && Array.isArray(game.locations) && game.locations.length > 0
		? game
		: null;
}

export function saveGame(game: Game): void {
	storage.set(`${SAVED_GAME}:${game.mapId}`, game);
}

export function clearSavedGame(mapId: string): void {
	storage.set(`${SAVED_GAME}:${mapId}`, null);
}

interface GlobalStreak {
	mode: StreakMode;
	count: number;
}

export function getGlobalStreak(mode: StreakMode): number {
	if (mode === "off") return 0;
	const s = storage.get<GlobalStreak | null>(GLOBAL_STREAK, null);
	return s?.mode === mode ? s.count : 0;
}

export function setGlobalStreak(mode: StreakMode, count: number): void {
	if (mode === "off") return;
	storage.set(GLOBAL_STREAK, { mode, count } satisfies GlobalStreak);
}

export const HISTORY_ROUND_CAP = 2_000;

function readHistory(): PastGame[] {
	return storage.get<PastGame[]>(HISTORY, []);
}

export function getHistory(mapId: string): PastGame[] {
	return readHistory().filter((g) => g.mapId === mapId);
}

const gameKey = (game: PastGame) => `${game.mapId}:${game.startedAt}`;

export function appendHistory(game: PastGame): void {
	const kept = [game];
	const keys = new Set([gameKey(game)]);
	let rounds = game.rounds.length;
	for (const older of readHistory()) {
		if (keys.has(gameKey(older))) continue;
		keys.add(gameKey(older));
		rounds += older.rounds.length;
		if (rounds > HISTORY_ROUND_CAP) break;
		kept.push(older);
	}
	storage.set(HISTORY, kept);
}

export function clearHistory(mapId: string): void {
	storage.set(
		HISTORY,
		readHistory().filter((g) => g.mapId !== mapId),
	);
}

export async function roundThumbnails(
	session: Pick<Session, "mapId" | "startedAt" | "results">,
): Promise<Map<number, string | null>> {
	const filter = {
		mapId: session.mapId,
		since: session.startedAt,
		locationIds: session.results.map((r) => r.location.id),
	};
	const entries = await getSeenEntries(await getSeenCount(filter), 0, filter);
	const thumbnails = new Map<number, string | null>();
	for (const entry of entries.toReversed()) {
		if (entry.locationId != null && !thumbnails.has(entry.locationId)) {
			thumbnails.set(entry.locationId, entry.thumbnail);
		}
	}
	return thumbnails;
}
