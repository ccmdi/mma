import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";
import { SegmentedControl } from "@/components/primitives/Sidebar";
import { EmptyState } from "@/components/primitives/EmptyState";
import { TextInput } from "@/components/primitives/TextInput";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { EntryCard, EntryList } from "@/components/primitives/EntryList";
import { Bar } from "@/components/primitives/Bar";
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
import { IconButton } from "@/components/primitives/IconButton";

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
			<DialogContent title={t("Review sessions")} size="lg">
				<SegmentedControl
					className="segmented--fill review-sessions__tabs"
					options={[
						{ value: "active", label: t("In progress") },
						{ value: "done", label: t("Completed") },
					]}
					value={filter}
					onChange={setFilter}
				/>

				{sessions.length === 0 ? (
					!loading && (
						<EmptyState>
							{filter === "active" ? t("No reviews in progress.") : t("No completed reviews.")}
						</EmptyState>
					)
				) : (
					<EntryList>
						{sessions.map((s) => {
							const pct =
								s.order.length > 0 ? Math.round((s.reviewed.length / s.order.length) * 100) : 0;
							return (
								<EntryCard
									key={s.id}
									actions={
										<>
											<IconButton
												icon={mdiCheckCircleOutline}
												size={18}
												label={t("Select reviewed")}
												onClick={() => handleSelect(s, "reviewed")}
												data-qa="review-select-reviewed"
											/>
											<IconButton
												icon={mdiCircleOutline}
												size={18}
												label={t("Select unreviewed")}
												onClick={() => handleSelect(s, "unreviewed")}
												data-qa="review-select-unreviewed"
											/>
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
											<ConfirmButton
												small
												variant="ghost"
												title={t("Delete session")}
												aria-label={t("Delete session")}
												onConfirm={() => void handleDelete(s.id)}
												data-qa="review-session-delete"
											>
												<Icon path={mdiDelete} size={18} />
											</ConfirmButton>
										</>
									}
								>
									{editingId === s.id ? (
										<TextInput
											className="entry-list__name"
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
											className="entry-list__name"
											title={t("Click to rename")}
											onClick={() => startEdit(s)}
										>
											{s.name || t("Review")}
										</div>
									)}
									<div className="entry-list__meta">
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
									<Bar value={pct / 100} className="review-sessions__bar" />
								</EntryCard>
							);
						})}
					</EntryList>
				)}
			</DialogContent>
		</Dialog>
	);
}
