import { Fragment, useEffect, useRef, useState } from "react";
import {
	mdiAccountCircle,
	mdiIncognito,
	mdiLockOutline,
	mdiOpenInNew,
	mdiPaperclip,
	mdiTextBoxOutline,
} from "@mdi/js";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { IssueThread } from "@/bindings.gen";
import { Button } from "@/components/primitives/Button";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Hint, Notice } from "@/components/primitives/Hint";
import { Icon } from "@/components/primitives/Icon";
import { IconButton } from "@/components/primitives/IconButton";
import { Spinner } from "@/components/primitives/Spinner";
import { Tooltip } from "@/components/primitives/Tooltip";
import { cmd } from "@/lib/commands";
import { uploadImages, useStagedImages } from "@/lib/feedback/attachments";
import { buildReplyBody, readBody, SECTION_TITLES } from "@/lib/feedback/body";
import { recordThread, replyToken } from "@/lib/feedback/submit";
import { t } from "@/lib/i18n";
import { errText, relativeTime } from "@/lib/util/format";
import { Markdown } from "@/lib/util/markdown";
import {
	ATTACHMENT_LABELS,
	reportStatus,
	useReports,
	type SubmittedReport,
} from "@/store/feedback";
import { ReportImages } from "./ReportImages";

const POLL_MS = 60_000;

function sectionLabel(title: string): string {
	const key = (Object.keys(SECTION_TITLES) as Array<keyof typeof SECTION_TITLES>).find(
		(k) => SECTION_TITLES[k] === title,
	);
	return key ? t(ATTACHMENT_LABELS[key]) : title;
}

function Entry({
	report,
	author,
	avatarUrl,
	mine,
	at,
	body,
}: {
	report: SubmittedReport;
	author: string;
	avatarUrl?: string | null;
	mine: boolean;
	at: string;
	body: string;
}) {
	const { text, sections } = readBody(body);
	return (
		<article className="report-thread__entry">
			{avatarUrl && !mine ? (
				<img className="report-thread__avatar" src={avatarUrl} alt="" />
			) : (
				<Tooltip content={mine && report.anonymous ? t("Anonymous") : author}>
					<span className="report-thread__avatar">
						<Icon path={mine && report.anonymous ? mdiIncognito : mdiAccountCircle} size={24} />
					</span>
				</Tooltip>
			)}
			<div className="report-thread__message">
				<header className="report-thread__byline">
					<strong>{mine ? t("You") : author}</strong>
					<time dateTime={at} title={new Date(at).toLocaleString()}>
						{relativeTime(at)}
					</time>
					{sections.length > 0 && (
						<Tooltip content={sections.map(sectionLabel).join(", ")}>
							<span className="report-thread__sections">
								<Icon path={mdiPaperclip} size={14} />
							</span>
						</Tooltip>
					)}
				</header>
				{text && <Markdown source={text} />}
			</div>
		</article>
	);
}

/** One filed report's conversation, and a way to answer it. */
export function ReportThread({ number, open, onOpenChange }: DialogProps & { number: number }) {
	const [reports] = useReports();
	const report = reports.find((r) => r.number === number);
	const latest = useRef(report);
	latest.current = report;
	// Which replies were new is what the reader opened this to see, so it is fixed at open.
	const [seenAtOpen] = useState(() => report?.seenReplies ?? 0);

	const [thread, setThread] = useState<IssueThread | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [attachLog, setAttachLog] = useState(false);
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const { images, add, remove, clear } = useStagedImages();
	const timeline = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const load = async () => {
			const current = latest.current;
			if (!current) return;
			try {
				const fetched = await cmd.feedbackThread(current.number, replyToken(current));
				setThread(fetched);
				setLoadError(null);
				recordThread(current, fetched, true);
			} catch (e) {
				setLoadError(errText(e));
			}
		};
		void load();
		const timer = setInterval(() => void load(), POLL_MS);
		return () => clearInterval(timer);
	}, [number]);

	const shown = thread?.comments.length;
	useEffect(() => {
		const el = timeline.current;
		if (el && shown !== undefined) el.scrollTop = el.scrollHeight;
	}, [shown]);

	if (!report) return null;
	const status = reportStatus(report);

	const attach = async (files: FileList | null) => {
		setSendError(null);
		try {
			await add(files);
		} catch (e) {
			setSendError(errText(e));
		}
	};

	const send = async () => {
		if (!thread || !draft.trim() || sending) return;
		setSending(true);
		setSendError(null);
		try {
			const uploaded = await uploadImages(images);
			const logTail = attachLog ? await cmd.feedbackLogTail() : undefined;
			const comment = await cmd.feedbackReply(
				report.number,
				replyToken(report),
				buildReplyBody(draft, { logTail, images: uploaded }),
			);
			const next = { ...thread, comments: [...thread.comments, comment] };
			setThread(next);
			recordThread(report, next, true);
			setDraft("");
			setAttachLog(false);
			clear();
		} catch (e) {
			setSendError(errText(e));
		} finally {
			setSending(false);
		}
	};

	let replies = 0;
	let dividerShown = false;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				title={report.title}
				className="report-thread"
				size="lg"
				aside={
					<div className="report-thread__status">
						{status && (
							<span className={`report-status report-status--${status.tone}`}>
								<Icon path={status.icon} size={16} />
								{t(status.label)}
							</span>
						)}
						<span className="report-thread__number">#{report.number}</span>
						<IconButton
							className="icon-button--inline"
							icon={mdiOpenInNew}
							size={14}
							label={t("Open on GitHub")}
							onClick={() => void openExternal(report.url)}
						/>
					</div>
				}
			>
				<div className="report-thread__timeline" ref={timeline}>
					{thread ? (
						<>
							<Entry
								report={report}
								author={thread.author ?? ""}
								mine
								at={report.submittedAt}
								body={thread.body ?? ""}
							/>
							{thread.comments.map((c, i) => {
								const mine = c.author === thread.author;
								const fresh = !mine && replies++ >= seenAtOpen && !dividerShown;
								if (fresh) dividerShown = true;
								return (
									<Fragment key={i}>
										{fresh && (
											<div className="report-thread__new" role="separator">
												{t("New")}
											</div>
										)}
										<Entry
											report={report}
											author={c.author}
											avatarUrl={c.avatarUrl}
											mine={mine}
											at={c.createdAt}
											body={c.body}
										/>
									</Fragment>
								);
							})}
						</>
					) : loadError ? (
						<Notice tone="error">{loadError}</Notice>
					) : (
						<Spinner />
					)}
				</div>

				{thread?.locked ? (
					<p className="report-thread__locked">
						<Icon path={mdiLockOutline} size={16} />
						{t("Locked")}
					</p>
				) : (
					thread && (
						<div
							className="report-thread__composer"
							onPaste={(e) => void attach(e.clipboardData.files)}
						>
							<textarea
								className="report-thread__draft"
								placeholder={t("Reply")}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
								}}
							/>
							<div className="report-thread__tools">
								<IconButton
									icon={mdiTextBoxOutline}
									size={18}
									label={t("Attach recent log")}
									active={attachLog}
									onClick={() => setAttachLog((v) => !v)}
								/>
								<ReportImages images={images} onAdd={(f) => void attach(f)} onRemove={remove} />
								<Button
									small
									variant="primary"
									disabled={sending || !draft.trim()}
									onClick={() => void send()}
								>
									{sending ? t("Sending...") : t("Send")}
								</Button>
							</div>
						</div>
					)
				)}
				{sendError && <Hint tone="error">{sendError}</Hint>}
			</DialogContent>
		</Dialog>
	);
}
