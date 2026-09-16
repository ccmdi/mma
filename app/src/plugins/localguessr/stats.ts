import {
	bestStreak,
	scoreGuess,
	streakHit,
	type MovementMode,
	type PastGame,
	type PastRound,
	type Place,
} from "./game";

const PERFECT_SCORE = 5000;

export interface Tally {
	games: number;
	rounds: number;
	/** Mean score of a single round. */
	averageScore: number;
	bestGame: number;
}

export interface CountryStats {
	code: string;
	rounds: number;
	/** Rounds whose guess landed in the same country. */
	hits: number;
	averageScore: number;
}

export interface TrendPoint {
	finishedAt: number;
	mapName: string;
	averageScore: number;
}

export interface Stats {
	overall: Tally;
	/** Null when no game counted a streak. */
	bestStreak: number | null;
	perfectRounds: number;
	/** Most played first. Rounds stored without their places are left out. */
	countries: CountryStats[];
	/** Most played first. */
	maps: (Tally & { mapId: string; mapName: string })[];
	/** Most played first. */
	modes: (Tally & { mode: MovementMode })[];
	/** One point per game, oldest first. */
	trend: TrendPoint[];
}

interface Sum {
	games: number;
	rounds: number;
	score: number;
	best: number;
}

const EMPTY: Sum = { games: 0, rounds: 0, score: 0, best: 0 };

const mean = (score: number, rounds: number) => (rounds > 0 ? score / rounds : 0);

function added(sum: Sum = EMPTY, total: number, rounds: number): Sum {
	return {
		games: sum.games + 1,
		rounds: sum.rounds + rounds,
		score: sum.score + total,
		best: Math.max(sum.best, total),
	};
}

function tally({ games, rounds, score, best }: Sum): Tally {
	return { games, rounds, averageScore: mean(score, rounds), bestGame: best };
}

const mostPlayed = (a: Tally, b: Tally) => b.games - a.games;

function hasPlaces(round: PastRound): round is PastRound & { truth: Place | null } {
	return round.truth !== undefined;
}

export function pastStats(history: PastGame[]): Stats {
	let overall = EMPTY;
	let streak: number | null = null;
	let perfectRounds = 0;
	const maps = new Map<string, Sum & { mapName: string }>();
	const modes = new Map<MovementMode, Sum>();
	const countries = new Map<string, { rounds: number; hits: number; score: number }>();
	const trend: TrendPoint[] = [];

	const played = history
		.filter((g) => g.rounds.length > 0)
		.toSorted((a, b) => a.finishedAt - b.finishedAt);
	for (const game of played) {
		const scores = game.rounds.map((r) => scoreGuess(r.guess, r.location, game.maxError).score);
		const total = scores.reduce((sum, s) => sum + s, 0);
		overall = added(overall, total, scores.length);
		perfectRounds += scores.filter((s) => s === PERFECT_SCORE).length;
		trend.push({
			finishedAt: game.finishedAt,
			mapName: game.mapName,
			averageScore: mean(total, scores.length),
		});
		maps.set(game.mapId, {
			...added(maps.get(game.mapId), total, scores.length),
			mapName: game.mapName,
		});
		const { movementMode, streakMode } = game.config;
		modes.set(movementMode, added(modes.get(movementMode), total, scores.length));

		game.rounds.forEach((round, i) => {
			const code = hasPlaces(round) && round.truth?.country_code;
			if (!code) return;
			const country = countries.get(code) ?? { rounds: 0, hits: 0, score: 0 };
			const hit = streakHit("country", round.truth, round.guessed ?? null);
			countries.set(code, {
				rounds: country.rounds + 1,
				hits: country.hits + (hit ? 1 : 0),
				score: country.score + scores[i],
			});
		});

		const rounds = game.rounds;
		if (streakMode !== "off" && rounds.every(hasPlaces)) {
			const hits = rounds.map((r) => ({
				streakHit: streakHit(streakMode, r.truth, r.guessed ?? null),
			}));
			streak = Math.max(streak ?? 0, bestStreak(hits));
		}
	}

	return {
		overall: tally(overall),
		bestStreak: streak,
		perfectRounds,
		countries: [...countries]
			.map(([code, c]) => ({
				code,
				rounds: c.rounds,
				hits: c.hits,
				averageScore: mean(c.score, c.rounds),
			}))
			.sort((a, b) => b.rounds - a.rounds || a.code.localeCompare(b.code)),
		maps: [...maps]
			.map(([mapId, m]) => ({ ...tally(m), mapId, mapName: m.mapName }))
			.sort(mostPlayed),
		modes: [...modes].map(([mode, m]) => ({ ...tally(m), mode })).sort(mostPlayed),
		trend,
	};
}
