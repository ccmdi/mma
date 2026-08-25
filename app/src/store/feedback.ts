import { mdiCheckCircleOutline, mdiCloseCircleOutline, mdiRecordCircleOutline } from "@mdi/js";
import type { IssueState } from "@/bindings.gen";
import { getLocal, persisted, setLocal, useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { msg } from "@/lib/i18n";
import type { Attachments, ReportKind } from "@/lib/feedback/body";

const REPORTS_KEY = "feedbackReports";
const INSTALL_ID_KEY = "feedbackInstallId";

/** Per-kind attachment choices; a suggestion starts with none since they only bear on bugs. */
export const ATTACHMENT_PREFS = persisted<Record<ReportKind, Attachments>>("feedbackAttachments", {
	bug: { diagnostics: true, settings: true, log: true },
	idea: { diagnostics: false, settings: false, log: false },
});

/** A report this install has filed. Kept locally because an anonymous reporter has no account
 *  to look their own issues up under. */
export interface SubmittedReport {
	number: number;
	url: string;
	title: string;
	kind: ReportKind;
	/** ISO-8601. */
	submittedAt: string;
	anonymous: boolean;
	/** Reads this one issue's relayed replies. Anonymous reports only; signed-in reports read
	 *  the thread with the user's own token. */
	token?: string;
	/** Replies already shown, so new ones can be counted without another source of truth. */
	seenReplies: number;
	replies: number;
	/** What GitHub says became of it. Absent until a refresh succeeds -- reports filed before
	 *  this was tracked, and threads that have never been reachable, simply show no status. */
	state?: IssueState;
	/** `completed`, `not_planned` or `reopened`. */
	stateReason?: string | null;
}

/** GitHub's own three outcomes, in its own vocabulary and colours. A closed issue with no
 *  recorded reason reads as done, which is what it meant before GitHub tracked reasons. */
export function reportStatus(
	report: SubmittedReport,
): { icon: string; tone: string; label: string } | null {
	if (!report.state) return null;
	if (report.state === "open") {
		return { icon: mdiRecordCircleOutline, tone: "open", label: msg("Open") };
	}
	return report.stateReason === "not_planned"
		? { icon: mdiCloseCircleOutline, tone: "dismissed", label: msg("Closed as not planned") }
		: { icon: mdiCheckCircleOutline, tone: "done", label: msg("Closed") };
}

export function getReports(): SubmittedReport[] {
	return getLocal<SubmittedReport[]>(REPORTS_KEY, []);
}

export function addReport(report: SubmittedReport): void {
	setLocal(REPORTS_KEY, [report, ...getReports()]);
}

export function updateReport(number: number, patch: Partial<SubmittedReport>): void {
	setLocal(
		REPORTS_KEY,
		getReports().map((r) => (r.number === number ? { ...r, ...patch } : r)),
	);
}

export function markRepliesSeen(number: number): void {
	const report = getReports().find((r) => r.number === number);
	if (report) updateReport(number, { seenReplies: report.replies });
}

export function unreadReplyCount(reports: SubmittedReport[]): number {
	return reports.reduce((n, r) => n + Math.max(0, r.replies - r.seenReplies), 0);
}

export function useReports() {
	return useLocalStorage<SubmittedReport[]>(REPORTS_KEY, []);
}

export function getInstallId(): string {
	let id = getLocal<string>(INSTALL_ID_KEY, "");
	if (!id) {
		id = crypto.randomUUID();
		setLocal(INSTALL_ID_KEY, id);
	}
	return id;
}
