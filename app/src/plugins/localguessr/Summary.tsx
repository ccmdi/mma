import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/primitives/Icon";
import { mdiCheckCircle, mdiCloseCircle } from "@mdi/js";
import { t } from "@/lib/i18n";
import { formatElapsed, formatRoundDistance, type Session } from "./game";
import { Flag } from "@/components/primitives/Flag";
import { TagButton } from "./TagButton";

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

	return (
		<div className="lg-summary">
			<header className="lg-summary__hero">
				<div>
					<div className="lg-summary__label">{t("Game breakdown")}</div>
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

			<div className="lg-summary__rounds">
				{session.results.map((r, i) => (
					<div key={i} className="lg-summary__row">
						<span className="lg-summary__row-n">#{i + 1}</span>
						<span className="lg-summary__row-score">{r.score.toLocaleString()}</span>
						<span className="lg-summary__row-dist">
							{r.distanceMeters != null ? formatRoundDistance(r.distanceMeters) : "—"}
						</span>
						<span className="lg-summary__row-time">{formatElapsed(r.elapsedMs)}</span>
						<span className="lg-summary__row-place">
							<Flag code={r.truth?.country_code ?? null} />
							{[r.truth?.admin, r.truth?.country].filter(Boolean).join(", ")}
						</span>
						{r.streakHit !== null && (
							<span className={`lg-summary__row-streak${r.streakHit ? " is-hit" : " is-miss"}`}>
								<Icon path={r.streakHit ? mdiCheckCircle : mdiCloseCircle} size={16} />
							</span>
						)}
						<TagButton locationIds={[r.location.id]} />
					</div>
				))}
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
