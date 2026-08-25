// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { GeoResult } from "@/bindings.gen";
import {
	bestStreak,
	currentRound,
	formatElapsed,
	formatRoundDistance,
	isLastRound,
	reduce,
	sampleN,
	scoreGuess,
	streakBeforeLast,
	streakHit,
	toSession,
	type Game,
	type GameConfig,
	type RoundLocation,
	type RoundResult,
	type View,
} from "@/plugins/localguessr/game";

const CONFIG: GameConfig = {
	movementMode: "moving",
	roundMode: "classic",
	rounds: 3,
	timerMode: "off",
	timeLimit: 60,
	streakMode: "off",
};

function loc(id: number): RoundLocation {
	return { id, lat: id, lng: 0, heading: 0, pitch: 0, zoom: 0, panoId: null };
}

function game(over: Partial<Game> = {}): Game {
	return {
		config: CONFIG,
		mapId: "m",
		mapName: "Map",
		maxError: 185.34781,
		locations: [loc(1), loc(2), loc(3)],
		index: 0,
		results: [],
		streak: 0,
		startedAt: 0,
		roundStartedAt: 0,
		...over,
	};
}

function result(over: Partial<RoundResult> = {}): RoundResult {
	return {
		location: loc(1),
		guess: null,
		distanceMeters: null,
		score: 0,
		truth: null,
		guessed: null,
		streakHit: null,
		elapsedMs: 0,
		...over,
	};
}

function place(country_code: string, admin = ""): GeoResult {
	return { city: "", admin, country: country_code, country_code };
}

describe("sampleN", () => {
	it("returns exactly n distinct items", () => {
		const pool = Array.from({ length: 100 }, (_, i) => i);
		const drawn = sampleN(pool, 5);
		expect(drawn).toHaveLength(5);
		expect(new Set(drawn).size).toBe(5);
		expect(drawn.every((v) => pool.includes(v))).toBe(true);
	});

	it("clamps to the pool size rather than repeating", () => {
		const drawn = sampleN([1, 2, 3], 10);
		expect(drawn).toHaveLength(3);
		expect(new Set(drawn).size).toBe(3);
	});

	it("handles an empty pool", () => {
		expect(sampleN([], 5)).toEqual([]);
	});

	it("never mutates the pool", () => {
		const pool = [1, 2, 3, 4, 5];
		sampleN(pool, 3);
		expect(pool).toEqual([1, 2, 3, 4, 5]);
	});

	it("covers the whole pool over many draws", () => {
		const pool = [0, 1, 2, 3, 4];
		const seen = new Set<number>();
		for (let i = 0; i < 200; i++) seen.add(sampleN(pool, 1)[0]);
		expect(seen.size).toBe(pool.length);
	});
});

describe("scoreGuess", () => {
	it("scores a missing guess as zero with no distance", () => {
		expect(scoreGuess(null, { lat: 0, lng: 0 }, 185)).toEqual({
			distanceMeters: null,
			score: 0,
		});
	});

	it("gives a perfect score at the exact location", () => {
		const { distanceMeters, score } = scoreGuess({ lat: 10, lng: 10 }, { lat: 10, lng: 10 }, 185);
		expect(distanceMeters).toBeLessThan(1);
		expect(score).toBe(5000);
	});

	it("scores further guesses lower", () => {
		const truth = { lat: 0, lng: 0 };
		const near = scoreGuess({ lat: 1, lng: 0 }, truth, 185).score;
		const far = scoreGuess({ lat: 40, lng: 0 }, truth, 185).score;
		expect(near).toBeGreaterThan(far);
	});
});

describe("formatRoundDistance", () => {
	it("rounds to whole kilometres past 1 km", () => {
		expect(formatRoundDistance(12_340)).toBe("12 km");
		expect(formatRoundDistance(12_600)).toBe("13 km");
		expect(formatRoundDistance(1000)).toBe("1 km");
	});

	it("stays in whole metres below a kilometre", () => {
		expect(formatRoundDistance(999)).toBe("999 m");
		expect(formatRoundDistance(12.4)).toBe("12 m");
		expect(formatRoundDistance(0)).toBe("0 m");
	});
});

describe("formatElapsed", () => {
	it("formats sub-minute as seconds", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(4_500)).toBe("5s");
		expect(formatElapsed(59_000)).toBe("59s");
	});

	it("formats minutes with remainder", () => {
		expect(formatElapsed(60_000)).toBe("1m");
		expect(formatElapsed(90_000)).toBe("1m 30s");
		expect(formatElapsed(185_000)).toBe("3m 5s");
	});
});

describe("streakHit", () => {
	it("is null only when the mode is off", () => {
		expect(streakHit("off", place("US"), place("US"))).toBeNull();
		expect(streakHit("country", null, null)).toBe(false);
	});

	it("matches on country code", () => {
		expect(streakHit("country", place("FR"), place("FR"))).toBe(true);
		expect(streakHit("country", place("FR"), place("DE"))).toBe(false);
	});

	it("requires country and admin to match in state mode", () => {
		expect(streakHit("state", place("US", "Texas"), place("US", "Texas"))).toBe(true);
		expect(streakHit("state", place("US", "Texas"), place("US", "Ohio"))).toBe(false);
		expect(streakHit("state", place("US", "Texas"), place("MX", "Texas"))).toBe(false);
	});

	it("compares admin case-insensitively but never matches an empty one", () => {
		expect(streakHit("state", place("US", "texas "), place("US", "Texas"))).toBe(true);
		expect(streakHit("state", place("US", ""), place("US", ""))).toBe(false);
	});

	it("misses when a geocode failed", () => {
		expect(streakHit("country", place("US"), null)).toBe(false);
	});
});

describe("streak accounting", () => {
	it("finds the longest run, not the last one", () => {
		const results = [true, true, true, false, true].map((streakHit) => result({ streakHit }));
		expect(bestStreak(results)).toBe(3);
	});

	it("reports the run that ended on the final round", () => {
		const results = [true, true, false].map((streakHit) => result({ streakHit }));
		expect(streakBeforeLast(results)).toBe(2);
		expect(streakBeforeLast([result({ streakHit: false })])).toBe(0);
	});
});

describe("reduce", () => {
	const playing: View = { phase: "playing", game: game() };

	it("increments the streak on a hit and resets it on a miss", () => {
		const hit = reduce(
			{ phase: "playing", game: game({ streak: 2 }) },
			{
				type: "result",
				result: result({ streakHit: true }),
			},
		);
		expect(hit.phase === "result" && hit.game.streak).toBe(3);

		const miss = reduce(
			{ phase: "playing", game: game({ streak: 2 }) },
			{
				type: "result",
				result: result({ streakHit: false }),
			},
		);
		expect(miss.phase === "result" && miss.game.streak).toBe(0);
	});

	it("records the result and moves to the result phase", () => {
		const next = reduce(playing, { type: "result", result: result({ score: 4000 }) });
		expect(next.phase).toBe("result");
		expect(next.phase === "result" && next.game.results).toHaveLength(1);
	});

	it("ignores a result while not playing", () => {
		const view: View = { phase: "config" };
		expect(reduce(view, { type: "result", result: result() })).toBe(view);
	});

	it("advances the round index and restarts the round clock", () => {
		const view = reduce(playing, { type: "result", result: result() });
		const next = reduce(view, { type: "next" });
		expect(next.phase).toBe("playing");
		expect(next.phase === "playing" && next.game.index).toBe(1);
		expect(next.phase === "playing" && next.game.roundStartedAt).toBeGreaterThan(0);
	});

	it("summarizes instead of advancing past the last round", () => {
		const atEnd: View = { phase: "result", game: game({ index: 2, results: [result()] }) };
		const next = reduce(atEnd, { type: "next" });
		expect(next.phase).toBe("summary");
	});

	it("restarts at index zero when a fresh batch is supplied", () => {
		const atEnd: View = { phase: "result", game: game({ index: 2 }) };
		const next = reduce(atEnd, { type: "next", locations: [loc(9), loc(10)] });
		expect(next.phase === "playing" && next.game.index).toBe(0);
		expect(next.phase === "playing" && next.game.locations).toHaveLength(2);
	});

	it("finishes from either phase and totals the score", () => {
		const results = [result({ score: 1000 }), result({ score: 2500 })];
		const view: View = { phase: "playing", game: game({ results }) };
		const done = reduce(view, { type: "finish" });
		expect(done.phase).toBe("summary");
		expect(done.phase === "summary" && done.session.totalScore).toBe(3500);
	});

	it("exits to config", () => {
		expect(reduce(playing, { type: "exit" }).phase).toBe("config");
	});
});

describe("round helpers", () => {
	it("reads the current round and detects the last one", () => {
		expect(currentRound(game())?.id).toBe(1);
		expect(currentRound(game({ index: 9 }))).toBeNull();
		expect(isLastRound(game({ index: 2 }))).toBe(true);
		expect(isLastRound(game({ index: 1 }))).toBe(false);
	});

	it("never treats an endless game as being on its last round", () => {
		const endless = game({ config: { ...CONFIG, roundMode: "infinite" }, index: 2 });
		expect(isLastRound(endless)).toBe(false);
	});

	it("carries the best streak into the session", () => {
		const results = [true, true, false, true].map((streakHit) => result({ streakHit }));
		expect(toSession(game({ results })).bestStreak).toBe(2);
	});
});

describe("saved game storage", () => {
	it("scopes the saved game to its map", async () => {
		const { saveGame, getSavedGame, clearSavedGame } =
			await import("@/plugins/localguessr/storage");
		saveGame(game({ mapId: "a" }));
		expect(getSavedGame("a")?.mapId).toBe("a");
		expect(getSavedGame("b")).toBeNull();
		clearSavedGame("a");
		expect(getSavedGame("a")).toBeNull();
	});
});

describe("resume", () => {
	it("restarts the round clock on start, not the persisted timestamp", () => {
		const stale = game({ roundStartedAt: 1 });
		const view = reduce({ phase: "config" }, { type: "start", game: stale });
		expect(view.phase).toBe("playing");
		if (view.phase === "playing") {
			expect(view.game.roundStartedAt).toBeGreaterThan(1);
		}
	});
});
