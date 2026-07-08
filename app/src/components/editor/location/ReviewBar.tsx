import {
	useReviewSession,
	reviewIndex,
	isCurrentReviewed,
	cancelReview,
} from "@/lib/review/review";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { mdiClose } from "@mdi/js";

/** Header shown above the pano during a review pass. Single point of review-UI in the
 *  preview; the rest of LocationPreview only calls reviewNext/Prev/Delete. */
export function ReviewBar() {
	const s = useReviewSession();
	if (!s) return null;

	const pos = reviewIndex(s) + 1;
	const reviewedHere = isCurrentReviewed(s);

	return (
		<div className="review-header">
			<span>
				Reviewing{" "}
				<span style={{ color: reviewedHere ? "#3fb950" : undefined, fontWeight: 600 }}>
					{pos} / {s.order.length}
				</span>{" "}
				&middot; {s.reviewed.length} reviewed
			</span>
			<span style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
				<Tooltip content="Exit review" side="bottom">
					<button
						className="icon-button"
						aria-label="Exit review"
						onClick={cancelReview}
						data-qa="review-cancel"
					>
						<Icon path={mdiClose} size={16} />
					</button>
				</Tooltip>
			</span>
		</div>
	);
}
