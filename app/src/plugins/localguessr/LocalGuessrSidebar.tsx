import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { createPortal } from "react-dom";
import { mdiEarth } from "@mdi/js";
import {
	Sidebar,
	Section,
	Field,
	SegmentedControl,
	EmptyState,
} from "@/components/primitives/Sidebar";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import { Button } from "@/components/primitives/Button";
import { Slider } from "@/components/primitives/Slider";
import { NSelect } from "@/components/primitives/NSelect";
import { usePluginState } from "@/plugins/registry";
import { useSelectorPick } from "@/store/selectorPick";
import { fetchLocations, getMapState, sampleFrom, useMapState } from "@/store/useMapStore";
import { useScoreMaxError } from "@/lib/geo/scoring";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";
import type { Selector } from "@/bindings.gen";
import {
	DEFAULT_CONFIG,
	INFINITE_BATCH,
	reduce,
	toRoundLocation,
	type GameConfig,
	type MovementMode,
	type RoundLocation,
	type RoundMode,
	type StreakMode,
	type TimerMode,
	type View,
} from "./game";
import {
	clearSavedGame,
	getGlobalStreak,
	getSavedGame,
	saveGame,
	setGlobalStreak,
} from "./storage";
import { RoundPlayer } from "./RoundPlayer";
import { Summary } from "./Summary";
import "./localguessr.css";

async function drawRounds(selector: Selector, n: number): Promise<RoundLocation[]> {
	const ids = await sampleFrom(selector, n);
	if (ids.length === 0) return [];
	return (await fetchLocations({ type: "Locations", locations: ids, name: null })).map(
		toRoundLocation,
	);
}

export function LocalGuessrSidebar({ onClose }: { onClose: () => void }) {
	const [stored, setStored] = usePluginState<GameConfig>("localguessr", "config", DEFAULT_CONFIG);
	const config = useMemo<GameConfig>(() => ({ ...DEFAULT_CONFIG, ...stored }), [stored]);
	const map = useMapState((s) => s.map);
	const locationCount = useMapState((s) => s.locationCount);
	const maxError = useScoreMaxError();
	const picker = useSelectorPick();
	const [view, dispatch] = useReducer(reduce, { phase: "config" } as View);
	const [starting, setStarting] = useState(false);
	const [resumable, setResumable] = useState(() => {
		const id = getMapState().map?.id;
		return id ? getSavedGame(id) : null;
	});

	const patch = (p: Partial<GameConfig>) => setStored({ ...config, ...p });

	// The config phase never clears here: this effect also runs on a fresh mount,
	// and clearing then would wipe a resumable run. Explicit exits clear via `exitGame`.
	useEffect(() => {
		const mapId = getMapState().map?.id;
		if (view.phase === "playing" || view.phase === "result") {
			saveGame(view.game);
			setGlobalStreak(view.game.config.streakMode, view.game.streak);
		} else if (view.phase === "summary" && mapId) {
			clearSavedGame(mapId);
		}
		setResumable(view.phase === "config" && mapId ? getSavedGame(mapId) : null);
	}, [view]);

	/** Leave and forfeit the game (drops the saved run). */
	const exitGame = useCallback(() => {
		const mapId = getMapState().map?.id;
		if (mapId) clearSavedGame(mapId);
		dispatch({ type: "exit" });
	}, []);

	const start = useCallback(async () => {
		const current = getMapState().map;
		if (!current || starting) return;
		setStarting(true);
		try {
			const count = config.roundMode === "classic" ? config.rounds : INFINITE_BATCH;
			const locations = await drawRounds(picker.selector, count);
			if (locations.length === 0) {
				toast(t("No locations to play"));
				return;
			}
			dispatch({
				type: "start",
				game: {
					config,
					mapId: current.id,
					mapName: current.name,
					maxError,
					locations,
					index: 0,
					results: [],
					streak: getGlobalStreak(config.streakMode),
					startedAt: Date.now(),
					roundStartedAt: Date.now(),
				},
			});
		} finally {
			setStarting(false);
		}
	}, [config, picker.selector, maxError, starting]);

	// Infinite mode draws a fresh batch when the current one runs out.
	const next = useCallback(() => {
		if (view.phase !== "result") return;
		const { game } = view;
		const exhausted = game.index + 1 >= game.locations.length;
		if (game.config.roundMode === "infinite" && exhausted) {
			void drawRounds(picker.selector, INFINITE_BATCH).then((locations) =>
				dispatch({ type: "next", locations }),
			);
			return;
		}
		dispatch({ type: "next" });
	}, [view, picker.selector]);

	const overlay =
		view.phase === "config"
			? null
			: createPortal(
					<div className="lg-overlay" role="dialog" aria-modal="true" data-plugin-overlay>
						{view.phase === "summary" ? (
							<Summary session={view.session} onPlayAgain={() => void start()} onBack={exitGame} />
						) : (
							<RoundPlayer
								game={view.game}
								showResult={view.phase === "result"}
								selector={picker.selector}
								onResult={(result) => dispatch({ type: "result", result })}
								onNext={next}
								onFinish={() => dispatch({ type: "finish" })}
								onExit={exitGame}
							/>
						)}
					</div>,
					document.body,
				);

	return (
		<>
			<Sidebar title={t("LocalGuessr")} onBack={onClose} className="lg-sidebar">
				{!map ? (
					<EmptyState icon={mdiEarth}>{t("Open a map to play")}</EmptyState>
				) : (
					<>
						<Section title={t("Locations")}>
							<SelectorPicker ctl={picker} />
						</Section>

						<Section title={t("Mode")}>
							<Field label={t("Movement")}>
								<SegmentedControl<MovementMode>
									value={config.movementMode}
									onChange={(movementMode) => patch({ movementMode })}
									options={[
										{ value: "moving", label: t("Moving") },
										{ value: "noMove", label: t("No move") },
										{ value: "nmpz", label: t("NMPZ") },
									]}
								/>
							</Field>
							<Field label={t("Rounds")}>
								<SegmentedControl<RoundMode>
									value={config.roundMode}
									onChange={(roundMode) => patch({ roundMode })}
									options={[
										{ value: "classic", label: t("Fixed") },
										{ value: "infinite", label: t("Endless") },
									]}
								/>
							</Field>
							{config.roundMode === "classic" && (
								<Field label={t("{n} rounds", { n: config.rounds })}>
									<Slider
										min={1}
										max={20}
										step={1}
										value={config.rounds}
										onChange={(e) => patch({ rounds: Number(e.target.value) })}
									/>
								</Field>
							)}
						</Section>

						<Section title={t("Timer")} collapsible>
							<Field label={t("Timer")}>
								<NSelect
									value={config.timerMode}
									onChange={(e) => patch({ timerMode: e.target.value as TimerMode })}
								>
									<option value="off">{t("No timer")}</option>
									<option value="countup">{t("Count up")}</option>
									<option value="countdown">{t("Countdown")}</option>
								</NSelect>
							</Field>
							{config.timerMode === "countdown" && (
								<Field label={t("{n} seconds per round", { n: config.timeLimit })}>
									<Slider
										min={15}
										max={300}
										step={5}
										value={config.timeLimit}
										onChange={(e) => patch({ timeLimit: Number(e.target.value) })}
									/>
								</Field>
							)}
						</Section>

						<Section title={t("Streak")} collapsible>
							<Field label={t("Count a streak by")}>
								<NSelect
									value={config.streakMode}
									onChange={(e) => patch({ streakMode: e.target.value as StreakMode })}
								>
									<option value="off">{t("Off")}</option>
									<option value="country">{t("Country")}</option>
									<option value="state">{t("State or region")}</option>
								</NSelect>
							</Field>
							{config.streakMode !== "off" && getGlobalStreak(config.streakMode) > 0 && (
								<p className="lg-sidebar__streak">
									{t("Current streak: {n}", { n: getGlobalStreak(config.streakMode) })}
								</p>
							)}
						</Section>

						{resumable && (
							<Section title={t("In progress")}>
								<div className="lg-sidebar__resume">
									<span>
										{t("{name} - round {n}", {
											name: resumable.mapName,
											n: resumable.index + 1,
										})}
									</span>
									<Button small onClick={() => dispatch({ type: "start", game: resumable })}>
										{t("Resume")}
									</Button>
								</div>
							</Section>
						)}

						<div className="lg-sidebar__actions">
							<Button
								variant="primary"
								disabled={locationCount === 0 || starting}
								onClick={() => void start()}
							>
								{starting ? t("Starting...") : t("Play")}
							</Button>
						</div>
					</>
				)}
			</Sidebar>
			{overlay}
		</>
	);
}
