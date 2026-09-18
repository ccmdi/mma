import { mdiArrowLeft } from "@mdi/js";
import { IconButton } from "@/components/primitives/IconButton";
import { getCommitDiffPreview, endCommitDiffPreview } from "@/store/commitDiff";
import { useEventValue } from "@/lib/events";
import { fmt } from "@/lib/util/format";
import { t } from "@/lib/i18n";

/** Sidebar shown while viewing a commit diff on the map. The colored markers
 *  temporarily replace the regular markers; this panel labels them. The back
 *  arrow restores the regular markers. */
export function DiffSidebar() {
	const diff = useEventValue("diff-markers:changed", getCommitDiffPreview);
	if (!diff) return null;
	const { counts } = diff;

	return (
		<section className="import-sidebar">
			<header className="import-sidebar__header">
				<div className="diff-sidebar__title-group">
					<IconButton
						className="icon-button--inline"
						icon={mdiArrowLeft}
						size={18}
						label={t("Back to map")}
						onClick={endCommitDiffPreview}
					/>
					<h2 className="import-sidebar__title">{t("Changes")}</h2>
				</div>
				<span className="import-sidebar__count mono">{diff.hash}</span>
			</header>

			<div className="import-sidebar__section">
				<ul className="diff-legend">
					<li>
						<span className="diff-legend__dot" style={{ background: "rgb(34,197,94)" }} />

						{t("Added")}
						<span className="diff-legend__count mono">{fmt.format(counts.added)}</span>
					</li>
					<li>
						<span className="diff-legend__dot" style={{ background: "rgb(239,68,68)" }} />

						{t("Removed")}
						<span className="diff-legend__count mono">{fmt.format(counts.removed)}</span>
					</li>
					<li>
						<span className="diff-legend__dot" style={{ background: "rgb(245,158,11)" }} />

						{t("Modified")}
						<span className="diff-legend__count mono">{fmt.format(counts.modified)}</span>
					</li>
				</ul>
			</div>
		</section>
	);
}
