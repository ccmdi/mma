import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { createPortal } from "react-dom";
import { mdiDeleteOutline, mdiEarth, mdiHistory } from "@mdi/js";
import {
	Sidebar,
	Section,
	Field,
	SegmentedControl,
	EmptyState,
} from "@/components/primitives/Sidebar";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { EntryCard, EntryList } from "@/components/primitives/EntryList";
import { Slider } from "@/components/primitives/Slider";
import { NSelect } from "@/components/primitives/NSelect";
import { usePluginState } from "@/plugins/registry";
import { useSelectorPick } from "@/store/selectorPick";
import { fetchLocations, getMapState, sampleFrom, useMapState } from "@/store/useMapStore";
import { useScoreMaxError } from "@/lib/geo/scoring";
import { toast } from "@/lib/util/toast";
import { dateTimeFmt, fmt, relativeTime } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import type { Selector } from "@/bindings.gen";
import {
	DEFAULT_CONFIG,
	formatElapsed,
	INFINITE_BATCH,
	hydrateSession,
	locate,
	movementLabels,
	pastTotal,
	reduce,
	toPastGame,
	toRoundLocation,
	type Game,
	type GameConfig,
	type MovementMode,
	type PastGame,
	type RoundLocation,
	type RoundMode,
	type Session,
	type StreakMode,
	type TimerMode,
	type View,
} from "./game";
import {
	appendHistory,
	clearHistory,
	getGlobalStreak,
	getHistory,
	getSavedGames,
	removeSavedGame,
	useStartingThumbnails,
	saveGame,
	setGlobalStreak,
} from "./storage";
import { RoundPlayer } from "./RoundPlayer";
import { Summary } from "./Summary";
import { PastStats } from "./PastStats";
import "./localguessr.css";

async function drawRounds(selector: Selector, n: number): Promise<RoundLocation[]> {
	const ids = await sampleFrom(selector, n);
	if (ids.length === 0) return [];
	return (await fetchLocations({ type: "Locations", locations: ids, name: null })).map(
		toRoundLocation,
	);
}

function SavedGameCard({
	game,
	onResume,
	onDiscard,
}: {
	game: Game;
	onResume: (game: Game) => void;
	onDiscard: (game: Game) => void;
}) {
	const round =
		game.config.roundMode === "infinite"
			? `${game.index + 1}`
			: `${game.index + 1}/${game.locations.length}`;
	return (
		<EntryCard
			actions={
				<>
					<Tooltip content={t("Discard")}>
						<button
							className="icon-button"
							type="button"
							aria-label={t("Discard")}
							onClick={() => onDiscard(game)}
						>
							<Icon path={mdiDeleteOutline} />
						</button>
					</Tooltip>
					<Button small onClick={() => onResume(game)}>
						{t("Resume")}
					</Button>
				</>
			}
		>
			<div className="entry-list__name">{t("Round {n}", { n: round })}</div>
			<div className="entry-list__meta">
				<span>{movementLabels()[game.config.movementMode]}</span>
				<span title={dateTimeFmt.format(game.roundStartedAt)}>
					{relativeTime(game.roundStartedAt / 1000)}
				</span>
			</div>
		</EntryCard>
	);
}

function PastGameCard({
	game,
	thumbnail,
	onOpen,
}: {
	game: PastGame;
	thumbnail: string | null | undefined;
	onOpen: (game: PastGame) => void;
}) {
	return (
		<EntryCard
			actions={
				<Button small onClick={() => onOpen(game)}>
					{t("Open")}
				</Button>
			}
		>
			{thumbnail && (
				<img className="lg-row-thumb" src={`data:image/jpeg;base64,${thumbnail}`} alt="" />
			)}
			<div className="entry-list__name">{fmt.format(pastTotal(game))}</div>
			<div className="entry-list__meta">
				<span>{t("{n} rounds", { n: game.rounds.length })}</span>
				<span>{movementLabels()[game.config.movementMode]}</span>
				<span>{formatElapsed(game.rounds.reduce((sum, r) => sum + r.elapsedMs, 0))}</span>
				<span title={dateTimeFmt.format(game.finishedAt)}>
					{relativeTime(game.finishedAt / 1000)}
				</span>
			</div>
		</EntryCard>
	);
}

function PastGamesModal({
	open,
	onOpenChange,
	history,
	onOpen,
	onClear,
}: DialogProps & {
	history: PastGame[];
	onOpen: (game: PastGame) => void;
	onClear: () => void;
}) {
	const [tab, setTab] = useState<"games" | "stats">("games");
	const [confirmingClear, setConfirmingClear] = useState(false);
	const mapId = history[0]?.mapId ?? "";
	const starts = history.flatMap((g) =>
		g.rounds[0] ? [{ locationId: g.rounds[0].location.id, startedAt: g.startedAt }] : [],
	);
	const thumbnails = useStartingThumbnails(mapId, starts);
	const thumbnailByStart = new Map(starts.map((s, i) => [s.startedAt, thumbnails[i]]));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Past games")} className="lg-history" size="lg">
				<SegmentedControl
					className="lg-history__tabs"
					value={tab}
					onChange={setTab}
					options={[
						{ value: "games", label: t("Games") },
						{ value: "stats", label: t("Stats") },
					]}
				/>
				{tab === "stats" ? (
					<PastStats mapId={mapId} />
				) : (
					<>
						<EntryList>
							{history.map((g) => (
								<PastGameCard
									key={g.startedAt}
									game={g}
									thumbnail={thumbnailByStart.get(g.startedAt)}
									onOpen={onOpen}
								/>
							))}
						</EntryList>
						<div className="lg-history__clear">
							<Button
								small
								variant="destructive"
								onClick={() => (confirmingClear ? onClear() : setConfirmingClear(true))}
								onBlur={() => setConfirmingClear(false)}
							>
								{confirmingClear ? t("Are you sure?") : t("Clear history")}
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
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
	const [saved, setSaved] = useState<Game[]>([]);
	const [history, setHistory] = useState<PastGame[]>([]);
	const [past, setPast] = useState<Session | null>(null);
	const [showHistory, setShowHistory] = useState(false);

	const patch = (p: Partial<GameConfig>) => setStored({ ...config, ...p });

	useEffect(() => {
		if (view.phase === "playing" || view.phase === "result") {
			saveGame(view.game);
			setGlobalStreak(view.game.config.streakMode, view.game.streak);
		} else if (view.phase === "summary") {
			removeSavedGame(view.session);
			appendHistory(toPastGame(view.session));
		}
	}, [view]);

	useEffect(() => {
		const inConfig = map && view.phase === "config";
		setHistory(inConfig ? getHistory(map.id) : []);
		setSaved(inConfig ? getSavedGames(map.id) : []);
	}, [map, view]);

	const exitGame = useCallback(() => dispatch({ type: "exit" }), []);

	const discardGame = useCallback((game: Game) => {
		removeSavedGame(game);
		setSaved(getSavedGames(game.mapId));
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

	const playAgain = useCallback(() => {
		setPast(null);
		void start();
	}, [start]);

	const openPast = useCallback(async (game: PastGame) => {
		const session = await hydrateSession(game, locate);
		setPast(session);
		setShowHistory(false);
	}, []);

	const clearPast = useCallback(() => {
		const mapId = getMapState().map?.id;
		if (mapId) clearHistory(mapId);
		setHistory([]);
		setShowHistory(false);
	}, []);

	const inspecting = useMapState((s) => s.workArea) === "location";

	const content =
		view.phase === "playing" || view.phase === "result" ? (
			<RoundPlayer
				game={view.game}
				showResult={view.phase === "result"}
				selector={picker.selector}
				onResult={(result) => dispatch({ type: "result", result })}
				onNext={next}
				onFinish={() => dispatch({ type: "finish" })}
				onExit={exitGame}
				inspecting={inspecting}
			/>
		) : view.phase === "summary" ? (
			<Summary session={view.session} onPlayAgain={playAgain} onBack={exitGame} />
		) : past ? (
			<Summary
				session={past}
				onPlayAgain={playAgain}
				onBack={() => {
					setPast(null);
					setShowHistory(true);
				}}
			/>
		) : null;

	const overlay =
		content &&
		createPortal(
			<div
				className="lg-overlay"
				role="dialog"
				aria-modal="true"
				hidden={inspecting}
				data-plugin-overlay={inspecting ? undefined : true}
			>
				{content}
			</div>,
			document.body,
		);

	return (
		<>
			<Sidebar
				title={t("LocalGuessr")}
				onBack={onClose}
				className="lg-sidebar"
				actions={
					history.length > 0 && (
						<Tooltip content={t("Past games")} side="bottom">
							<button
								className="icon-button"
								type="button"
								aria-label={t("Past games")}
								onClick={() => setShowHistory(true)}
							>
								<Icon path={mdiHistory} />
							</button>
						</Tooltip>
					)
				}
			>
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
										...(Object.entries(movementLabels()) as [MovementMode, string][]).map(
											([value, label]) => ({ value, label }),
										),
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

						{saved.length > 0 && (
							<Section title={t("In progress")}>
								<EntryList>
									{saved.map((game) => (
										<SavedGameCard
											key={game.startedAt}
											game={game}
											onResume={(game) => dispatch({ type: "start", game })}
											onDiscard={discardGame}
										/>
									))}
								</EntryList>
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
			{showHistory && (
				<PastGamesModal
					open
					onOpenChange={setShowHistory}
					history={history}
					onOpen={(game) => void openPast(game)}
					onClear={clearPast}
				/>
			)}
			{overlay}
		</>
	);
}
