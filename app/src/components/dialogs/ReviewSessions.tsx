import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { mdiCheckCircleOutline, mdiCircleOutline, mdiPlay, mdiDelete } from "@mdi/js";
import {
	listSessions,
	resumeReview,
	deleteSession,
	selectReviewSet,
	renameReview,
} from "@/lib/review/review";
import { shortDateFmt, relativeTime } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { dateTimeFmt } from "@/lib/util/format";
import type { ReviewSession } from "@/bindings.gen";

function formatDate(iso: string): string {
	const d = new Date(iso);
	return shortDateFmt.format(d);
}

export function ReviewSessionsModal({ open, onOpenChange }: DialogProps) {
	const [filter, setFilter] = useState<"active" | "done">("active");
	const [sessions, setSessions] = useState<ReviewSession[]>([]);
	const [loading, setLoading] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const skipBlur = useRef(false);

	const reload = useCallback(async () => {
		setLoading(true);
		try {
			setSessions(await listSessions(filter));
		} finally {
			setLoading(false);
		}
	}, [filter]);

	useEffect(() => {
		if (open) void reload();
	}, [open, reload]);

	const handleResume = (s: ReviewSession) => {
		void resumeReview(s);
		onOpenChange(false);
	};

	const handleDelete = async (id: string) => {
		setSessions((prev) => prev.filter((s) => s.id !== id)); // drop in place
		await deleteSession(id);
	};

	const handleSelect = (s: ReviewSession, mode: "reviewed" | "unreviewed") => {
		void selectReviewSet(s, mode);
		onOpenChange(false);
	};

	const startEdit = (s: ReviewSession) => {
		skipBlur.current = false;
		setDraft(s.name || "");
		setEditingId(s.id);
	};

	const saveEdit = async () => {
		const id = editingId;
		const name = draft.trim();
		setEditingId(null);
		if (!id || !name) return;
		setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s))); // patch in place
		await renameReview(id, name);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Review sessions")} className="review-sessions-modal">
				<div className="review-sessions__tabs">
					<button
						className={`review-sessions__tab${filter === "active" ? " is-active" : ""}`}
						onClick={() => setFilter("active")}
					>
						{t("In progress")}
					</button>
					<button
						className={`review-sessions__tab${filter === "done" ? " is-active" : ""}`}
						onClick={() => setFilter("done")}
					>
						{t("Completed")}
					</button>
				</div>

				{loading ? (
					<p className="review-sessions__empty">{t("Loading...")}</p>
				) : sessions.length === 0 ? (
					<p className="review-sessions__empty">
						{filter === "active" ? t("No reviews in progress.") : t("No completed reviews.")}
					</p>
				) : (
					<ul className="review-sessions__list">
						{sessions.map((s) => {
							const pct =
								s.order.length > 0 ? Math.round((s.reviewed.length / s.order.length) * 100) : 0;
							return (
								<li key={s.id} className="review-sessions__card">
									<div className="review-sessions__info">
										{editingId === s.id ? (
											<input
												className="review-sessions__name"
												style={{ font: "inherit", width: "100%", boxSizing: "border-box" }}
												autoFocus
												value={draft}
												onChange={(e) => setDraft(e.target.value)}
												onFocus={(e) => e.target.select()}
												onBlur={() => {
													if (skipBlur.current) {
														skipBlur.current = false;
														setEditingId(null);
														return;
													}
													void saveEdit();
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														e.preventDefault();
														e.currentTarget.blur();
													} else if (e.key === "Escape") {
														e.preventDefault();
														skipBlur.current = true;
														e.currentTarget.blur();
													}
												}}
											/>
										) : (
											<div
												className="review-sessions__name"
												title={t("Click to rename")}
												onClick={() => startEdit(s)}
											>
												{s.name || t("Review")}
											</div>
										)}
										<div className="review-sessions__meta">
											<span>
												{t("{done} / {total} reviewed ({pct}%)", {
													done: s.reviewed.length,
													total: s.order.length,
													pct,
												})}
											</span>
											<span title={dateTimeFmt.format(new Date(s.createdAt))}>
												{t("Started")} {formatDate(s.createdAt)}
											</span>
											<span title={dateTimeFmt.format(new Date(s.updatedAt))}>
												{t("Updated")} {relativeTime(s.updatedAt)}
											</span>
										</div>
										<div className="review-sessions__bar">
											<div className="review-sessions__bar-fill" style={{ width: `${pct}%` }} />
										</div>
									</div>
									<div className="review-sessions__actions">
										<button
											className="icon-button"
											title={t("Select reviewed")}
											aria-label={t("Select reviewed")}
											onClick={() => handleSelect(s, "reviewed")}
											data-qa="review-select-reviewed"
										>
											<Icon path={mdiCheckCircleOutline} size={18} />
										</button>
										<button
											className="icon-button"
											title={t("Select unreviewed")}
											aria-label={t("Select unreviewed")}
											onClick={() => handleSelect(s, "unreviewed")}
											data-qa="review-select-unreviewed"
										>
											<Icon path={mdiCircleOutline} size={18} />
										</button>
										{filter === "active" && (
											<Button
												variant="primary"
												className="review-sessions__resume"
												onClick={() => handleResume(s)}
												data-qa="review-resume"
											>
												<Icon path={mdiPlay} size={16} />

												{t("Resume")}
											</Button>
										)}
										<button
											className="icon-button review-sessions__delete"
											title={t("Delete session")}
											aria-label={t("Delete session")}
											onClick={() => void handleDelete(s.id)}
											data-qa="review-session-delete"
										>
											<Icon path={mdiDelete} size={18} />
										</button>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}
