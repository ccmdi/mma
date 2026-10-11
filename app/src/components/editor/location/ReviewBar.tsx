import { memo } from "react";
import { Review } from "@/lib/review/review";
import { mdiClose } from "@mdi/js";
import { t } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";
import { IconButton } from "@/components/primitives/IconButton";

/** Header shown above the pano during a review pass. Single point of review-UI in the
 *  preview; the rest of LocationPreview only calls Review.next/prev/deleteCurrent. */
export const ReviewBar = memo(function ReviewBar() {
	const s = Review.useSession();
	if (!s) return null;

	const pos = Review.index(s) + 1;
	const reviewedHere = Review.isCurrentReviewed(s);

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
				<IconButton
					icon={mdiClose}
					size={16}
					label={t("Exit review")}
					tooltipSide="bottom"
					onClick={Review.cancel}
					data-qa="review-cancel"
				/>
			</span>
		</div>
	);
});
