import { describe, expect, it } from "vitest";
import type { GameConfig, PastGame, PastRound, Place } from "@/plugins/localguessr/game";
import { pastStats } from "@/plugins/localguessr/stats";

const CONFIG: GameConfig = {
	movementMode: "moving",
	roundMode: "classic",
	rounds: 3,
	timerMode: "off",
	timeLimit: 60,
	streakMode: "off",
};

const MAX_ERROR = 185.34781;
const at = { lat: 10, lng: 10 };
const far = { lat: -40, lng: 150 };

function place(country_code: string, admin = ""): Place {
	return { admin, country_code };
}

function round(over: Partial<PastRound> = {}): PastRound {
	return {
		location: { id: 1, ...at, heading: 0, pitch: 0, zoom: 0, panoId: null },
		guess: at,
		elapsedMs: 0,
		...over,
	};
}

function past(over: Partial<PastGame> = {}): PastGame {
	return {
		config: CONFIG,
		mapId: "m",
		mapName: "Map",
		maxError: MAX_ERROR,
		startedAt: 0,
		finishedAt: 0,
		rounds: [round()],
		...over,
	};
}

describe("past stats", () => {
	it("totals rounds and scores across games, ignoring games with no rounds", () => {
		const stats = pastStats([
			past({ finishedAt: 2, rounds: [round(), round({ guess: null })] }),
			past({ finishedAt: 1, rounds: [round()] }),
			past({ finishedAt: 3, rounds: [] }),
		]);
		expect(stats.overall).toEqual({ games: 2, rounds: 3, averageScore: 10000 / 3, bestGame: 5000 });
		expect(stats.perfectRounds).toBe(2);
	});

	it("plots one point per game, oldest first", () => {
		const stats = pastStats([
			past({ finishedAt: 2, mapName: "Two", rounds: [round({ guess: null })] }),
			past({ finishedAt: 1, mapName: "One" }),
		]);
		expect(stats.trend).toEqual([
			{ finishedAt: 1, mapName: "One", averageScore: 5000 },
			{ finishedAt: 2, mapName: "Two", averageScore: 0 },
		]);
	});

	it("counts a country hit only when the guess landed in the answer's country", () => {
		const stats = pastStats([
			past({
				rounds: [
					round({ truth: place("FR"), guessed: place("FR") }),
					round({ truth: place("FR"), guessed: place("DE"), guess: far }),
					round({ truth: place("FR"), guessed: null, guess: null }),
					round({ truth: place("JP"), guessed: place("JP") }),
				],
			}),
		]);
		expect(stats.countries.map(({ code, rounds, hits }) => ({ code, rounds, hits }))).toEqual([
			{ code: "FR", rounds: 3, hits: 1 },
			{ code: "JP", rounds: 1, hits: 1 },
		]);
	});

	it("leaves out rounds stored without their places", () => {
		const stats = pastStats([past({ rounds: [round(), round({ truth: place("FR") })] })]);
		expect(stats.countries.map((c) => c.rounds)).toEqual([1]);
		expect(stats.overall.rounds).toBe(2);
	});

	it("takes the best streak from games that counted one, by their own mode", () => {
		const texas = place("US", "Texas");
		const ohio = place("US", "Ohio");
		const state = { ...CONFIG, streakMode: "state" as const };
		const country = { ...CONFIG, streakMode: "country" as const };
		const rounds = [
			round({ truth: texas, guessed: ohio }),
			round({ truth: texas, guessed: ohio }),
			round({ truth: texas, guessed: texas }),
		];
		expect(pastStats([past({ rounds })]).bestStreak).toBeNull();
		expect(pastStats([past({ config: state, rounds })]).bestStreak).toBe(1);
		expect(pastStats([past({ config: country, rounds })]).bestStreak).toBe(3);
		expect(pastStats([past({ config: country, rounds: [round()] })]).bestStreak).toBeNull();
	});

	it("breaks down by map under its newest name and by movement, most played first", () => {
		const nmpz = { ...CONFIG, movementMode: "nmpz" as const };
		const stats = pastStats([
			past({ mapId: "b", mapName: "B", finishedAt: 1 }),
			past({ mapId: "a", mapName: "A renamed", finishedAt: 4, config: nmpz }),
			past({
				mapId: "a",
				mapName: "A",
				finishedAt: 3,
				config: nmpz,
				rounds: [round({ guess: null })],
			}),
		]);
		expect(stats.maps.map((m) => [m.mapId, m.mapName, m.games, m.bestGame])).toEqual([
			["a", "A renamed", 2, 5000],
			["b", "B", 1, 5000],
		]);
		expect(stats.modes.map((m) => [m.mode, m.games, m.averageScore])).toEqual([
			["nmpz", 2, 2500],
			["moving", 1, 5000],
		]);
	});
});
