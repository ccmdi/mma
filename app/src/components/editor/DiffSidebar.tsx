import { mdiArrowLeft } from "@mdi/js";
import { IconButton } from "@/components/primitives/IconButton";
import { getCommitDiffPreview, endCommitDiffPreview } from "@/store/commitDiff";
import { useEventValue } from "@/lib/events";
import { fmt } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { DIFF_COLORS } from "@/lib/render/buildSceneLayers";
import { Swatch } from "@/components/primitives/Swatch";

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
						<Swatch color={DIFF_COLORS.added} size="sm" round />

						{t("Added")}
						<span className="diff-legend__count mono">{fmt.format(counts.added)}</span>
					</li>
					<li>
						<Swatch color={DIFF_COLORS.removed} size="sm" round />

						{t("Removed")}
						<span className="diff-legend__count mono">{fmt.format(counts.removed)}</span>
					</li>
					<li>
						<Swatch color={DIFF_COLORS.modified} size="sm" round />

						{t("Modified")}
						<span className="diff-legend__count mono">{fmt.format(counts.modified)}</span>
					</li>
				</ul>
			</div>
		</section>
	);
}
