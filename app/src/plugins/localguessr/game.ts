import type { GeoResult, Location, Pano } from "@/bindings.gen";
import type { LatLng, PanoCapture } from "@/types";
import { distMeters } from "@/lib/geo/geo";
import { calcHeading } from "@/lib/sv/lookup";
import { createLocation } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import { computeScore } from "@/lib/geo/scoring";
import { cmd } from "@/lib/commands";
import { t } from "@/lib/i18n";

export type MovementMode = "moving" | "noMove" | "nmpz";
export type RoundMode = "classic" | "infinite";
export type TimerMode = "off" | "countdown" | "countup";
export type StreakMode = "off" | "country" | "state";

export function movementLabels(): Record<MovementMode, string> {
	return { moving: t("Moving"), noMove: t("No move"), nmpz: t("NMPZ") };
}

export interface GameConfig {
	movementMode: MovementMode;
	roundMode: RoundMode;
	/** Round count for `classic`; ignored for `infinite`. */
	rounds: number;
	timerMode: TimerMode;
	/** Countdown seconds per round. */
	timeLimit: number;
	streakMode: StreakMode;
}

export const DEFAULT_CONFIG: GameConfig = {
	movementMode: "moving",
	roundMode: "classic",
	rounds: 5,
	timerMode: "off",
	timeLimit: 120,
	streakMode: "off",
};

/** How many rounds an infinite game draws up front. Re-drawn when exhausted. */
export const INFINITE_BATCH = 500;

/** The subset of a Location a round needs. Kept narrow so a saved game stays small. */
export type RoundLocation = PanoCapture & Pick<Location, "id">;

export type Place = Pick<GeoResult, "admin" | "country_code">;

export interface RoundResult {
	location: RoundLocation;
	guess: LatLng | null;
	distanceMeters: number | null;
	score: number;
	truth: Place | null;
	guessed: Place | null;
	/** Whether the streak survived this round; null when streak mode is off. */
	streakHit: boolean | null;
	elapsedMs: number;
}

export interface Game {
	config: GameConfig;
	mapId: string;
	mapName: string;
	/** Score-bounds max error, resolved once at start so scoring is stable mid-game. */
	maxError: number;
	locations: RoundLocation[];
	index: number;
	results: RoundResult[];
	streak: number;
	startedAt: number;
	roundStartedAt: number;
}

export interface Session {
	config: GameConfig;
	mapId: string;
	mapName: string;
	maxError: number;
	results: RoundResult[];
	totalScore: number;
	bestStreak: number;
	startedAt: number;
	finishedAt: number;
}

export interface PastRound {
	location: RoundLocation;
	guess: LatLng | null;
	elapsedMs: number;
	/** Undefined when the round was stored without its places. */
	truth?: Place | null;
	guessed?: Place | null;
}

export interface PastGame {
	config: GameConfig;
	mapId: string;
	mapName: string;
	maxError: number;
	startedAt: number;
	finishedAt: number;
	rounds: PastRound[];
}

/** Illegal states are unrepresentable: a game exists exactly when one is being played. */
export type View =
	| { phase: "config" }
	| { phase: "playing"; game: Game }
	| { phase: "result"; game: Game }
	| { phase: "summary"; session: Session };

export type GameAction =
	| { type: "start"; game: Game }
	| { type: "result"; result: RoundResult }
	| { type: "next"; locations?: RoundLocation[] }
	| { type: "finish" }
	| { type: "exit" };

export function guessPreview(pano: Pano): Location {
	return createLocation({
		lat: pano.lat,
		lng: pano.lng,
		panoId: pano.id,
		heading: calcHeading(pano, { pointAlongRoad: true }),
		flags: LocationFlag.LoadAsPanoId,
	});
}

export function toRoundLocation({
	id,
	lat,
	lng,
	heading,
	pitch,
	zoom,
	panoId,
}: Location): RoundLocation {
	return { id, lat, lng, heading, pitch, zoom, panoId };
}

/** Uniform sample of `n` distinct items in O(n). Partial Fisher-Yates over a sparse
 *  swap map, so drawing 5 rounds from a million locations touches 5 entries. */
export function sampleN<T>(pool: readonly T[], n: number): T[] {
	const take = Math.min(n, pool.length);
	const swapped = new Map<number, T>();
	const at = (i: number) => swapped.get(i) ?? pool[i];
	const out: T[] = [];
	for (let i = 0; i < take; i++) {
		const j = i + Math.floor(Math.random() * (pool.length - i));
		out.push(at(j));
		swapped.set(j, at(i));
	}
	return out;
}

export async function locate({ lat, lng }: LatLng): Promise<Place | null> {
	const geo = await cmd.reverseGeocode(lat, lng).catch(() => null);
	return geo && { admin: geo.admin, country_code: geo.country_code };
}

function sameCountry(truth: Place, guess: Place): boolean {
	return !!truth.country_code && truth.country_code === guess.country_code;
}

function sameAdmin(truth: Place, guess: Place): boolean {
	const a = truth.admin.trim().toLowerCase();
	const b = guess.admin.trim().toLowerCase();
	return a.length > 0 && a === b;
}

/** Whether the streak survives. Null only when streak mode is off; a failed geocode misses. */
export function streakHit(
	mode: StreakMode,
	truth: Place | null,
	guess: Place | null,
): boolean | null {
	if (mode === "off") return null;
	if (!truth || !guess) return false;
	if (mode === "country") return sameCountry(truth, guess);
	return sameCountry(truth, guess) && sameAdmin(truth, guess);
}

export function scoreGuess(
	guess: LatLng | null,
	truth: LatLng,
	maxError: number,
): { distanceMeters: number | null; score: number } {
	if (!guess) return { distanceMeters: null, score: 0 };
	const distanceMeters = distMeters(guess, truth);
	return { distanceMeters, score: computeScore(distanceMeters, maxError) };
}

export function formatElapsed(ms: number): string {
	const secs = Math.round(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const rem = secs % 60;
	return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

export function currentRound(game: Game): RoundLocation | null {
	return game.locations[game.index] ?? null;
}

export function isLastRound(game: Game): boolean {
	return game.config.roundMode === "classic" && game.index >= game.locations.length - 1;
}

/** Longest run of consecutive streak hits. */
export function bestStreak(results: Pick<RoundResult, "streakHit">[]): number {
	let best = 0;
	let run = 0;
	for (const r of results) {
		run = r.streakHit ? run + 1 : 0;
		if (run > best) best = run;
	}
	return best;
}

/** Consecutive hits in every round but the last, for "your streak of N ended" copy. */
export function streakBeforeLast(results: RoundResult[]): number {
	let run = 0;
	for (let i = results.length - 2; i >= 0; i--) {
		if (!results[i].streakHit) break;
		run++;
	}
	return run;
}

export function toSession({
	config,
	mapId,
	mapName,
	maxError,
	results,
	startedAt,
	finishedAt,
}: Omit<Session, "totalScore" | "bestStreak">): Session {
	return {
		config,
		mapId,
		mapName,
		maxError,
		results,
		startedAt,
		finishedAt,
		totalScore: results.reduce((sum, r) => sum + r.score, 0),
		bestStreak: bestStreak(results),
	};
}

export function toPastGame(session: Session): PastGame {
	return {
		config: session.config,
		mapId: session.mapId,
		mapName: session.mapName,
		maxError: session.maxError,
		startedAt: session.startedAt,
		finishedAt: session.finishedAt,
		rounds: session.results.map(({ location, guess, elapsedMs, truth, guessed }) => ({
			location,
			guess,
			elapsedMs,
			truth,
			guessed,
		})),
	};
}

export function pastTotal(past: PastGame): number {
	return past.rounds.reduce(
		(sum, r) => sum + scoreGuess(r.guess, r.location, past.maxError).score,
		0,
	);
}

/** A round stored without its places is geocoded again. */
export async function hydrateSession(
	past: PastGame,
	geocode: (at: LatLng) => Promise<Place | null>,
): Promise<Session> {
	const { streakMode } = past.config;
	const results = await Promise.all(
		past.rounds.map(async (round): Promise<RoundResult> => {
			const { location, guess, elapsedMs } = round;
			const [truth, guessed] =
				round.truth !== undefined
					? [round.truth, round.guessed ?? null]
					: await Promise.all([geocode(location), guess ? geocode(guess) : null]);
			return {
				location,
				guess,
				...scoreGuess(guess, location, past.maxError),
				truth,
				guessed,
				streakHit: streakHit(streakMode, truth, guessed),
				elapsedMs,
			};
		}),
	);
	return toSession({ ...past, results });
}

export function reduce(view: View, action: GameAction): View {
	switch (action.type) {
		case "start": {
			const game = { ...action.game, roundStartedAt: Date.now() };
			return game.results.length > game.index
				? { phase: "result", game }
				: { phase: "playing", game };
		}

		case "result": {
			if (view.phase !== "playing") return view;
			const { game } = view;
			return {
				phase: "result",
				game: {
					...game,
					results: [...game.results, action.result],
					streak: action.result.streakHit ? game.streak + 1 : 0,
				},
			};
		}

		case "next": {
			if (view.phase !== "result") return view;
			const { game } = view;
			const locations = action.locations ?? game.locations;
			const index = action.locations ? 0 : game.index + 1;
			if (!locations[index])
				return { phase: "summary", session: toSession({ ...game, finishedAt: Date.now() }) };
			return {
				phase: "playing",
				game: { ...game, locations, index, roundStartedAt: Date.now() },
			};
		}

		case "finish":
			if (view.phase !== "playing" && view.phase !== "result") return view;
			return { phase: "summary", session: toSession({ ...view.game, finishedAt: Date.now() }) };

		case "exit":
			return { phase: "config" };
	}
}
