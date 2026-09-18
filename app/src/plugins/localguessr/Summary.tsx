import { useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/primitives/Icon";
import { mdiCheckCircle, mdiCloseCircle } from "@mdi/js";
import { t } from "@/lib/i18n";
import { formatElapsed, type Session } from "./game";
import { formatDistance } from "@/lib/util/format";
import { Flag } from "@/components/primitives/Flag";
import { TagButton } from "./TagButton";
import { useStartingThumbnails } from "./storage";
import { loadSeenPano } from "@/lib/seen/seenRecorder";
import { usePano } from "@/lib/hooks/usePano";
import type { RoundResult } from "./game";
import { ReplayMap } from "./ReplayMap";

export function Summary({
	session,
	onPlayAgain,
	onBack,
}: {
	session: Session;
	onPlayAgain: () => void;
	onBack: () => void;
}) {
	const allIds = session.results.map((r) => r.location.id);
	const thumbnails = useStartingThumbnails(
		session.mapId,
		allIds.map((locationId) => ({ locationId, startedAt: session.startedAt })),
	);
	const pano = usePano();
	const [highlighted, setHighlighted] = useState<number | null>(null);
	const openRound = ({ location, truth }: RoundResult) =>
		void loadSeenPano(
			{
				locationId: location.id,
				panoId: location.panoId,
				lat: location.lat,
				lng: location.lng,
				heading: location.heading,
				pitch: location.pitch,
				zoom: location.zoom,
				countryCode: truth?.country_code ?? null,
			},
			pano,
		);

	return (
		<div className="lg-summary">
			<header className="lg-summary__hero">
				<div>
					<div className="eyebrow">{t("Game breakdown")}</div>
					<div className="lg-summary__score">{session.totalScore.toLocaleString()}</div>
				</div>
				<div className="lg-summary__meta">
					<div>{formatElapsed(session.results.reduce((sum, r) => sum + r.elapsedMs, 0))}</div>
					{session.config.streakMode !== "off" && (
						<div>{t("Best streak: {n}", { n: session.bestStreak })}</div>
					)}
					<div>{session.mapName}</div>
				</div>
			</header>

			<ReplayMap
				results={session.results}
				highlighted={highlighted}
				onOpenRound={(i) => openRound(session.results[i])}
			/>

			<div className="lg-summary__rounds" onPointerLeave={() => setHighlighted(null)}>
				{session.results.map((r, i) => {
					const thumbnail = thumbnails[i];
					return (
						<div
							key={i}
							className="lg-summary__row"
							role="button"
							tabIndex={0}
							onPointerEnter={() => setHighlighted(i)}
							onClick={(e) => {
								const target = e.target as Element;
								if (e.currentTarget.contains(target) && !target.closest("button")) openRound(r);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && e.target === e.currentTarget) openRound(r);
							}}
						>
							{thumbnail && (
								<img className="lg-row-thumb" src={`data:image/jpeg;base64,${thumbnail}`} alt="" />
							)}
							<span className="lg-summary__row-n">#{i + 1}</span>
							<span className="mono">{r.score.toLocaleString()}</span>
							<span className="mono">
								{r.distanceMeters != null ? formatDistance(r.distanceMeters, 0) : "-"}
							</span>
							<span className="lg-summary__row-time mono">{formatElapsed(r.elapsedMs)}</span>
							<span className="lg-summary__row-place truncate">
								<Flag code={r.truth?.country_code ?? null} />
								{[r.truth?.admin, r.truth?.country_code].filter(Boolean).join(", ")}
							</span>
							{r.streakHit !== null && (
								<span className={`lg-summary__row-streak${r.streakHit ? " is-hit" : " is-miss"}`}>
									<Icon path={r.streakHit ? mdiCheckCircle : mdiCloseCircle} size={16} />
								</span>
							)}
							<TagButton locationIds={[r.location.id]} />
						</div>
					);
				})}
			</div>

			<footer className="lg-summary__actions">
				<TagButton locationIds={allIds} label={t("Tag all rounds")} />
				<Button variant="primary" onClick={onPlayAgain}>
					{t("Play again")}
				</Button>
				<Button onClick={onBack}>{t("Done")}</Button>
			</footer>
		</div>
	);
}
