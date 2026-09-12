import { useEffect, useState } from "react";
import { createPluginStorage } from "@/plugins/registry";
import { getSeenCount, getSeenEntries } from "@/lib/seen/seen";
import type { SeenEntry } from "@/bindings.gen";
import type { Game, PastGame, StreakMode } from "./game";

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

export interface RoundStart {
	locationId: number;
	startedAt: number;
}

export async function startingThumbnails(
	mapId: string,
	rounds: RoundStart[],
): Promise<(string | null)[]> {
	if (rounds.length === 0) return [];
	const filter = {
		mapId,
		since: Math.min(...rounds.map((r) => r.startedAt)),
		locationIds: [...new Set(rounds.map((r) => r.locationId))],
	};
	const newestFirst = await getSeenEntries(await getSeenCount(filter), 0, filter);
	const byLocation = new Map<number, SeenEntry[]>();
	for (const entry of newestFirst.toReversed()) {
		if (entry.locationId == null) continue;
		const seen = byLocation.get(entry.locationId) ?? [];
		seen.push(entry);
		byLocation.set(entry.locationId, seen);
	}
	return rounds.map(
		({ locationId, startedAt }) =>
			byLocation.get(locationId)?.find((e) => e.enteredAt >= startedAt)?.thumbnail ?? null,
	);
}

export function useStartingThumbnails(mapId: string, rounds: RoundStart[]): (string | null)[] {
	const key = rounds.map((r) => `${r.locationId}@${r.startedAt}`).join(",");
	const [found, setFound] = useState<{ key: string; thumbnails: (string | null)[] }>({
		key: "",
		thumbnails: [],
	});
	useEffect(() => {
		let cancelled = false;
		const parsed = key
			? key.split(",").map((pair) => {
					const [locationId, startedAt] = pair.split("@").map(Number);
					return { locationId, startedAt };
				})
			: [];
		void startingThumbnails(mapId, parsed).then((thumbnails) => {
			if (!cancelled) setFound({ key, thumbnails });
		});
		return () => {
			cancelled = true;
		};
	}, [mapId, key]);
	return found.key === key ? found.thumbnails : [];
}
