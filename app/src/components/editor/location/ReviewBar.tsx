import { memo } from "react";
import {
	useReviewSession,
	reviewIndex,
	isCurrentReviewed,
	cancelReview,
} from "@/lib/review/review";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { mdiClose } from "@mdi/js";
import { t } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";

/** Header shown above the pano during a review pass. Single point of review-UI in the
 *  preview; the rest of LocationPreview only calls reviewNext/Prev/Delete. */
export const ReviewBar = memo(function ReviewBar() {
	const s = useReviewSession();
	if (!s) return null;

	const pos = reviewIndex(s) + 1;
	const reviewedHere = isCurrentReviewed(s);

	return (
		<div className="review-header">
			<span>
				{t("Reviewing")}{" "}
				<span
					className="mono"
					style={{ color: reviewedHere ? "var(--constructive)" : undefined, fontWeight: 600 }}
				>
					{pos} / {s.order.length}
				</span>{" "}
				&middot;{" "}
				<Trans msg="{count} reviewed" count={<span className="mono">{s.reviewed.length}</span>} />
			</span>
			<span style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
				<Tooltip content={t("Exit review")} side="bottom">
					<button
						className="icon-button"
						aria-label={t("Exit review")}
						onClick={cancelReview}
						data-qa="review-cancel"
					>
						<Icon path={mdiClose} size={16} />
					</button>
				</Tooltip>
			</span>
		</div>
	);
});
