import { useCallback, useEffect, useRef, useState } from "react";
import type { GeoResult, Scope } from "@/bindings.gen";
import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/primitives/Icon";
import { Flag } from "@/components/primitives/Flag";
import { Tooltip } from "@/components/primitives/Tooltip";
import {
	mdiClose,
	mdiHome,
	mdiNavigation,
	mdiBookmarkOutline,
	mdiBookmark,
	mdiCar,
	mdiCarOff,
	mdiTagOutline,
} from "@mdi/js";
import { cmd } from "@/lib/commands";
import { getSettings, setSetting, useSettings } from "@/store/settings";
import { sendHideCar, Compass, CompassTape } from "@/components/editor/location/PanoControls";
import { usePluginState } from "@/plugins/registry";
import { t } from "@/lib/i18n";
import type { LatLng } from "@/types";
import {
	currentRound,
	formatRoundDistance,
	isLastRound,
	scoreGuess,
	streakBeforeLast,
	streakHit,
	type Game,
	type RoundResult,
	type StreakMode,
} from "./game";
import { GuessMap } from "./GuessMap";
import { PanoView, type PanoHandle } from "./PanoView";
import { RoundTagBar } from "./RoundTagBar";

function Timer({
	mode,
	limit,
	startedAt,
	running,
	onExpire,
}: {
	mode: "countdown" | "countup";
	limit: number;
	startedAt: number;
	running: boolean;
	onExpire: () => void;
}) {
	const [display, setDisplay] = useState(mode === "countdown" ? limit : 0);
	const onExpireRef = useRef(onExpire);
	onExpireRef.current = onExpire;

	useEffect(() => {
		if (!running) return;
		const tick = () => {
			const elapsed = Math.floor((Date.now() - startedAt) / 1000);
			if (mode === "countdown") {
				const remaining = Math.max(0, limit - elapsed);
				setDisplay(remaining);
				if (remaining === 0) onExpireRef.current();
			} else {
				setDisplay(elapsed);
			}
		};
		tick();
		const id = setInterval(tick, 250);
		return () => clearInterval(id);
	}, [mode, limit, startedAt, running]);

	const mins = Math.floor(display / 60);
	const secs = display % 60;
	const low = mode === "countdown" && display <= 10;
	return (
		<span className={low ? "lg-timer lg-timer--low" : "lg-timer"}>
			{mins}:{String(secs).padStart(2, "0")}
		</span>
	);
}

function streakMessage(
	result: RoundResult,
	results: RoundResult[],
	streak: number,
	streakMode: StreakMode,
): string | null {
	if (result.streakHit === null) return null;
	const place = (g: GeoResult | null) =>
		streakMode === "state"
			? g?.admin?.trim() || g?.country || t("somewhere unknown")
			: g?.country || t("somewhere unknown");
	if (result.streakHit) {
		return t("Correct: {place}. Streak: {n}", { place: place(result.truth), n: streak });
	}
	const previous = streakBeforeLast(results);
	if (previous > 0) {
		return t("You guessed {guess}, it was {truth}. Your streak of {n} ended.", {
			guess: place(result.guessed),
			truth: place(result.truth),
			n: previous,
		});
	}
	return t("You guessed {guess}, it was {truth}.", {
		guess: place(result.guessed),
		truth: place(result.truth),
	});
}

export function RoundPlayer({
	game,
	showResult,
	scope,
	onResult,
	onNext,
	onFinish,
	onExit,
}: {
	game: Game;
	showResult: boolean;
	scope: Scope;
	onResult: (result: RoundResult) => void;
	onNext: () => void;
	onFinish: () => void;
	onExit: () => void;
}) {
	const round = currentRound(game);
	const panoRef = useRef<PanoHandle>(null);
	const [guess, setGuess] = useState<LatLng | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [hasCheckpoint, setHasCheckpoint] = useState(false);
	const [panorama, setPanorama] = useState<Parameters<typeof Compass>[0]["panorama"] | null>(null);
	const settings = useSettings();
	const [hideCar, setHideCar] = useState(!getSettings().showCar);
	// Persisted: the tag bar is a working preference, not per-round state.
	const [showTags, setShowTags] = usePluginState<boolean>("localguessr", "showTags", false);
	const lastResult = game.results[game.results.length - 1] ?? null;
	const last = isLastRound(game);

	useEffect(() => {
		setGuess(null);
		setSubmitting(false);
		setHasCheckpoint(false);
	}, [game.index]);

	useEffect(() => {
		sendHideCar(hideCar);
		return () => sendHideCar(false);
	}, [hideCar]);

	const submit = useCallback(
		async (at: LatLng | null) => {
			if (!round || submitting || showResult) return;
			setSubmitting(true);
			const { distanceMeters, score } = scoreGuess(
				at,
				{ lat: round.lat, lng: round.lng },
				game.maxError,
			);
			const needsPlaces = game.config.streakMode !== "off";
			const [truth, guessed] = needsPlaces
				? await Promise.all([
						cmd.reverseGeocode(round.lat, round.lng).catch(() => null),
						at ? cmd.reverseGeocode(at.lat, at.lng).catch(() => null) : null,
					])
				: [null, null];

			onResult({
				location: round,
				guess: at,
				distanceMeters,
				score,
				truth,
				guessed,
				streakHit: streakHit(game.config.streakMode, truth, guessed),
				elapsedMs: Date.now() - game.roundStartedAt,
			});
			setSubmitting(false);
		},
		[round, submitting, showResult, game, onResult],
	);

	const advance = useCallback(() => {
		if (last) onFinish();
		else onNext();
	}, [last, onNext, onFinish]);

	// One capture-phase handler for the game's own keys. Editor-level handlers are kept
	// out by `pluginOverlayOwnsInput` (they yield while `data-plugin-overlay` is mounted);
	// the stopImmediatePropagation below only settles ordering among later listeners.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null;
			if (e.repeat || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;

			const act = (fn: () => void) => {
				e.preventDefault();
				e.stopImmediatePropagation();
				fn();
			};
			// Space only submits with a pin down; a guessless round is never scoreable.
			if (e.code === "Space") {
				if (!showResult && !guess) return;
				return act(() => (showResult ? advance() : void submit(guess)));
			}
			if (e.key === "Escape") return act(onExit);
			// Pano keys are inert during the result -- the singleton is showing the
			// warmed next round by then, not this one.
			if (showResult) return;
			if (e.key === "r") return act(() => panoRef.current?.returnToSpawn());
			if (e.key === "n" && game.config.movementMode !== "nmpz") {
				return act(() => panoRef.current?.pointNorth());
			}
			if (e.key === "c" && game.config.movementMode === "moving") {
				return act(() => {
					if (panoRef.current?.setCheckpoint()) setHasCheckpoint(true);
				});
			}
			if (e.key === "b" && game.config.movementMode === "moving") {
				return act(() => {
					if (panoRef.current?.returnToCheckpoint()) setHasCheckpoint(false);
				});
			}
			if (e.key === "h") {
				return act(() => {
					setHideCar((v) => {
						setSetting("showCar", v);
						return !v;
					});
				});
			}
		};
		document.addEventListener("keydown", handler, true);
		return () => document.removeEventListener("keydown", handler, true);
	}, [showResult, guess, submit, advance, onExit]);

	if (!round) return null;

	const total = game.config.roundMode === "infinite" ? "∞" : game.locations.length;
	const cumulative = game.results.reduce((sum, r) => sum + r.score, 0);

	return (
		<div className={`lg-round${showResult ? " lg-round--result" : ""}`}>
			{/* Kept mounted through the result phase: remounting drops the WebGL context. */}
			<div className="lg-round__pano" aria-hidden={showResult}>
				<PanoView
					ref={panoRef}
					round={round}
					movementMode={game.config.movementMode}
					preload={showResult ? (game.locations[game.index + 1] ?? null) : null}
					onPanorama={setPanorama}
				/>
			</div>

			{!showResult && panorama && (
				<>
					{settings.showCompass && (
						<div className="lg-round__compass">
							<Compass panorama={panorama} />
						</div>
					)}
					{settings.showCompassTape && (
						<div className="lg-round__compass-tape">
							<CompassTape panorama={panorama} />
						</div>
					)}
				</>
			)}

			<header className="lg-hud">
				<div className="lg-hud__item">
					<span className="lg-hud__label">{t("Map")}</span>
					<span className="lg-hud__value">{game.mapName}</span>
				</div>
				<div className="lg-hud__item">
					<span className="lg-hud__label">{t("Round")}</span>
					<span className="lg-hud__value">
						{game.index + 1}/{total}
					</span>
				</div>
				<div className="lg-hud__item">
					<span className="lg-hud__label">{t("Score")}</span>
					<span className="lg-hud__value">{cumulative.toLocaleString()}</span>
				</div>
				{game.config.streakMode !== "off" && (
					<div className="lg-hud__item">
						<span className="lg-hud__label">{t("Streak")}</span>
						<span className="lg-hud__value">{game.streak}</span>
					</div>
				)}
				{game.config.timerMode !== "off" && !showResult && (
					<div className="lg-hud__item">
						<span className="lg-hud__label">{t("Time")}</span>
						<span className="lg-hud__value">
							<Timer
								mode={game.config.timerMode}
								limit={game.config.timeLimit}
								startedAt={game.roundStartedAt}
								running={!showResult && !submitting}
								onExpire={() => void submit(guess)}
							/>
						</span>
					</div>
				)}
			</header>

			<button type="button" className="lg-round__close" onClick={onExit} aria-label={t("Close")}>
				<Icon path={mdiClose} />
			</button>

			{!showResult && (
				<div className="lg-round__tools">
					<Tooltip content={t("Return to start (R)")} side="right">
						<button
							type="button"
							className="lg-round__tool"
							onClick={() => panoRef.current?.returnToSpawn()}
							aria-label={t("Return to start")}
						>
							<Icon path={mdiHome} size={20} />
						</button>
					</Tooltip>
					{game.config.movementMode !== "nmpz" && (
						<Tooltip content={t("Point north (N)")} side="right">
							<button
								type="button"
								className="lg-round__tool"
								onClick={() => panoRef.current?.pointNorth()}
								aria-label={t("Point north")}
							>
								<Icon path={mdiNavigation} size={20} />
							</button>
						</Tooltip>
					)}
					{game.config.movementMode === "moving" && (
						<Tooltip
							content={hasCheckpoint ? t("Return to checkpoint (B)") : t("Set checkpoint (C)")}
							side="right"
						>
							<button
								type="button"
								className={`lg-round__tool${hasCheckpoint ? " is-active" : ""}`}
								onClick={() => {
									if (hasCheckpoint) {
										if (panoRef.current?.returnToCheckpoint()) setHasCheckpoint(false);
									} else {
										if (panoRef.current?.setCheckpoint()) setHasCheckpoint(true);
									}
								}}
								aria-label={hasCheckpoint ? t("Return to checkpoint") : t("Set checkpoint")}
							>
								<Icon path={hasCheckpoint ? mdiBookmark : mdiBookmarkOutline} size={20} />
							</button>
						</Tooltip>
					)}
					<Tooltip content={hideCar ? t("Show car (H)") : t("Hide car (H)")} side="right">
						<button
							type="button"
							className={`lg-round__tool${hideCar ? " is-active" : ""}`}
							onClick={() => {
								setSetting("showCar", hideCar);
								setHideCar((v) => !v);
							}}
							aria-label={hideCar ? t("Show car") : t("Hide car")}
						>
							<Icon path={hideCar ? mdiCarOff : mdiCar} size={20} />
						</button>
					</Tooltip>
				</div>
			)}

			<div className={showResult ? "lg-round__result" : "lg-round__map-slot"}>
				<GuessMap
					guess={showResult ? (lastResult?.guess ?? null) : guess}
					truth={showResult ? { lat: round.lat, lng: round.lng } : null}
					showResult={showResult}
					roundKey={`${game.startedAt}:${game.index}`}
					scope={scope}
					onGuess={setGuess}
					onSubmit={() => void submit(guess)}
					submitting={submitting}
				/>

				{showResult && lastResult && showTags && (
					<div className="lg-round__tagbar">
						<RoundTagBar locationId={lastResult.location.id} />
					</div>
				)}

				{showResult && lastResult && (
					<div className="lg-result-bar">
						{lastResult.truth && (
							<div className="lg-result-bar__place">
								<Flag code={lastResult.truth.country_code} />
								<span>
									{[lastResult.truth.admin, lastResult.truth.country].filter(Boolean).join(", ")}
								</span>
							</div>
						)}
						{streakMessage(lastResult, game.results, game.streak, game.config.streakMode) && (
							<div className="lg-result-bar__streak">
								{streakMessage(lastResult, game.results, game.streak, game.config.streakMode)}
							</div>
						)}

						<div className="lg-result-bar__stats">
							<div className="lg-result-bar__stat lg-result-bar__stat--distance">
								<span className="lg-result-bar__value">
									{lastResult.distanceMeters != null
										? formatRoundDistance(lastResult.distanceMeters)
										: "—"}
								</span>
								<span className="lg-result-bar__label">
									{lastResult.guess ? t("from the location") : t("No guess made")}
								</span>
							</div>
							<div className="lg-result-bar__stat lg-result-bar__stat--score">
								<span className="lg-result-bar__value">{lastResult.score.toLocaleString()}</span>
								<span className="lg-result-bar__label">{t("of 5,000 points")}</span>
							</div>
						</div>

						<div className="lg-result-bar__actions">
							<button
								type="button"
								className={`lg-tag-btn${showTags ? " is-active" : ""}`}
								onClick={() => setShowTags((v) => !v)}
							>
								<Icon path={mdiTagOutline} size={18} />
								<span>{t("Tags")}</span>
							</button>
							<Button variant="primary" onClick={advance}>
								{last ? t("View summary") : t("Next round")}
							</Button>
						</div>
						<p className="lg-result-bar__hint">{t("Press Space to continue")}</p>
					</div>
				)}
			</div>
		</div>
	);
}
