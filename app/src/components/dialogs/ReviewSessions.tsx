import { startTransition, useOptimistic, useRef, useState } from "react";
import { useAsync, useSticky } from "@/lib/hooks/useAsync";
import { toast } from "@/lib/util/toast";
import { Notice } from "@/components/primitives/Hint";
import { SelectionList } from "@/store/selectionList";
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
import { Review } from "@/lib/review/review";
import { errText, shortDateFmt, relativeTime } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { dateTimeFmt } from "@/lib/util/format";
import type { ReviewSession } from "@/bindings.gen";
import type { ReviewMode } from "@/bindings.consts";
import { IconButton } from "@/components/primitives/IconButton";
import { addSelection } from "@/store/selections";

export function ReviewSessionsModal({ open, onOpenChange }: DialogProps) {
	const [filter, setFilter] = useState<"active" | "done">("active");
	const listed = useAsync(() => (open ? Review.sessions(filter) : []), [open, filter]);
	const [sessions, applyEdit] = useOptimistic(
		useSticky(listed, filter).ok() ?? [],
		(current: ReviewSession[], edit: (list: ReviewSession[]) => ReviewSession[]) => edit(current),
	);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const skipBlur = useRef(false);

	const commit = (edit: (list: ReviewSession[]) => ReviewSession[], write: () => Promise<void>) =>
		startTransition(async () => {
			applyEdit(edit);
			await write().catch((e: unknown) => toast(t("Error: {error}", { error: errText(e) })));
			await listed.rerun();
		});

	const handleResume = (s: ReviewSession) => {
		void Review.resume(s);
		onOpenChange(false);
	};

	const handleDelete = (id: string) =>
		commit(
			(list) => list.filter((s) => s.id !== id),
			() => Review.removeSession(id),
		);

	const handleSelect = (s: ReviewSession, mode: ReviewMode) => {
		void SelectionList.update(addSelection(Review.selector(s, mode)));
		onOpenChange(false);
	};

	const startEdit = (s: ReviewSession) => {
		skipBlur.current = false;
		setDraft(s.name || "");
		setEditingId(s.id);
	};

	const saveEdit = () => {
		const id = editingId;
		const name = draft.trim();
		setEditingId(null);
		if (!id || !name) return;
		commit(
			(list) => list.map((s) => (s.id === id ? { ...s, name } : s)),
			() => Review.rename(id, name),
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Review sessions")} size="lg">
				<SegmentedControl
					role="tabs"
					fill
					className="review-sessions__tabs"
					options={[
						{ value: "active", label: t("In progress") },
						{ value: "done", label: t("Completed") },
					]}
					value={filter}
					onChange={setFilter}
				/>

				{listed.status === "error" && <Notice tone="error">{errText(listed.error)}</Notice>}
				{sessions.length === 0 ? (
					listed.status === "ok" && (
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
												onConfirm={() => handleDelete(s.id)}
												data-qa="review-session-delete"
											>
												<Icon path={mdiDelete} size={18} />
											</ConfirmButton>
										</>
									}
								>
									{editingId === s.id ? (
										<TextInput
											className="entry-list__name truncate"
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
												saveEdit();
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
											className="entry-list__name truncate"
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
											{t("Started")} {shortDateFmt.format(new Date(s.createdAt))}
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
