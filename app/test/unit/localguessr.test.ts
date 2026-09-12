// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { GeoResult, Pano } from "@/bindings.gen";
import { LocationFlag } from "@/bindings.consts";
import {
	bestStreak,
	currentRound,
	formatElapsed,
	guessPreview,
	isLastRound,
	reduce,
	sampleN,
	scoreGuess,
	streakBeforeLast,
	streakHit,
	toPastGame,
	toSession,
	hydrateSession,
	pastTotal,
	type Game,
	type GameConfig,
	type PastGame,
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
	return { city: "", admin, country_code };
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
		expect(toSession({ ...game({ results }), finishedAt: 0 }).bestStreak).toBe(2);
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

function past(over: Partial<PastGame> = {}): PastGame {
	return {
		config: CONFIG,
		mapId: "m",
		mapName: "Map",
		maxError: 185.34781,
		startedAt: 0,
		finishedAt: 0,
		rounds: [],
		...over,
	};
}

function filler(n: number) {
	return Array.from({ length: n }, () => ({ location: loc(1), guess: null, elapsedMs: 0 }));
}

describe("history storage", () => {
	it("lists the newest game first, scoped to its map", async () => {
		const { appendHistory, getHistory, clearHistory } =
			await import("@/plugins/localguessr/storage");
		appendHistory(past({ mapId: "one", startedAt: 1 }));
		appendHistory(past({ mapId: "two", startedAt: 2 }));
		appendHistory(past({ mapId: "one", startedAt: 3 }));
		expect(getHistory("one").map((g) => g.startedAt)).toEqual([3, 1]);
		expect(getHistory("two").map((g) => g.startedAt)).toEqual([2]);
		clearHistory("one");
		expect(getHistory("one")).toEqual([]);
		expect(getHistory("two")).toHaveLength(1);
		clearHistory("two");
	});

	it("drops the oldest games once the kept rounds exceed the cap", async () => {
		const { appendHistory, getHistory, clearHistory, HISTORY_ROUND_CAP } =
			await import("@/plugins/localguessr/storage");
		const half = Math.floor(HISTORY_ROUND_CAP / 2);
		appendHistory(past({ mapId: "cap", startedAt: 1, rounds: filler(half) }));
		appendHistory(past({ mapId: "cap", startedAt: 2, rounds: filler(half) }));
		appendHistory(past({ mapId: "cap", startedAt: 3, rounds: filler(1) }));
		expect(getHistory("cap").map((g) => g.startedAt)).toEqual([3, 2]);
		clearHistory("cap");
	});

	it("holds each game once however often it is appended", async () => {
		const { appendHistory, getHistory, clearHistory } =
			await import("@/plugins/localguessr/storage");
		appendHistory(past({ mapId: "once", startedAt: 1 }));
		appendHistory(past({ mapId: "once", startedAt: 2 }));
		appendHistory(past({ mapId: "once", startedAt: 2 }));
		appendHistory(past({ mapId: "once", startedAt: 1 }));
		expect(getHistory("once").map((g) => g.startedAt)).toEqual([1, 2]);
		clearHistory("once");
	});

	it("keeps the game just finished even when it alone exceeds the cap", async () => {
		const { appendHistory, getHistory, clearHistory, HISTORY_ROUND_CAP } =
			await import("@/plugins/localguessr/storage");
		appendHistory(past({ mapId: "big", startedAt: 1, rounds: filler(1) }));
		appendHistory(past({ mapId: "big", startedAt: 2, rounds: filler(HISTORY_ROUND_CAP + 1) }));
		expect(getHistory("big").map((g) => g.startedAt)).toEqual([2]);
		clearHistory("big");
	});
});

describe("history round trip", () => {
	const guess = { lat: 1.4, lng: 0.3 };
	const results = [
		result({
			location: loc(1),
			guess,
			elapsedMs: 4200,
			...scoreGuess(guess, loc(1), 185.34781),
		}),
		result({ location: loc(2), guess: null, elapsedMs: 9100 }),
	];
	const noGeocode = () => Promise.reject(new Error("geocoded a streakless game"));

	it("rescores to the numbers the live game produced", async () => {
		const played = toSession({ ...game({ results }), finishedAt: 1_700_000_000_000 });
		expect(await hydrateSession(toPastGame(played), noGeocode)).toEqual(played);
	});

	it("totals a stored game without hydrating it", async () => {
		const played = toSession({ ...game({ results }), finishedAt: 1 });
		expect(pastTotal(toPastGame(played))).toBe(played.totalScore);
	});

	it("geocodes again only for a game that counted a streak", async () => {
		const config: GameConfig = { ...CONFIG, streakMode: "country" };
		const played = toSession({ ...game({ config, results }), finishedAt: 1 });
		let calls = 0;
		const hydrated = await hydrateSession(toPastGame(played), () => {
			calls++;
			return Promise.resolve(place("US", "Texas"));
		});
		expect(calls).toBe(3);
		expect(hydrated.results.map((r) => r.streakHit)).toEqual([true, false]);
		expect(hydrated.bestStreak).toBe(1);
	});
});

describe("previewing the pano nearest a guess", () => {
	const pano = (over: Partial<Pano> = {}) =>
		({
			id: "PANO_ID",
			lat: 51.5,
			lng: -0.12,
			centerHeading: 200,
			links: [],
			...over,
		}) as unknown as Pano;

	it("pins the preview to the exact pano it found", () => {
		const preview = guessPreview(pano());
		expect(preview.panoId).toBe("PANO_ID");
		expect(preview.flags & LocationFlag.LoadAsPanoId).toBeTruthy();
	});

	it("faces along the road when the pano links somewhere", () => {
		expect(
			guessPreview(pano({ links: [{ panoId: "NEXT", heading: 77 }] as Pano["links"] })).heading,
		).toBe(77);
	});

	it("falls back to the capture heading when the pano links nowhere", () => {
		expect(guessPreview(pano()).heading).toBe(200);
	});
});
