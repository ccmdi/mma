import type { IssueThread } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import {
	addReport,
	getInstallId,
	getReports,
	updateReport,
	type SubmittedReport,
} from "@/store/feedback";
import type { ReportInput } from "./body";

/** Which transport a submission would use. Signed in, the issue is authored by the user and
 *  they get GitHub's own notifications; anonymous, the worker files it on their behalf. */
export async function isSignedIn(): Promise<boolean> {
	try {
		return await cmd.githubHasSession();
	} catch {
		return false;
	}
}

/** File `body` as an issue and record it locally. The caller composes the body so the dialog
 *  can show the user exactly what will be sent. */
export async function submitReport(
	input: ReportInput,
	body: string,
	anonymous: boolean,
): Promise<SubmittedReport> {
	const ref = await cmd.feedbackSubmit(input.title, body, anonymous ? getInstallId() : null);

	const report: SubmittedReport = {
		number: ref.number,
		url: ref.url,
		title: input.title,
		kind: input.kind,
		submittedAt: new Date().toISOString(),
		anonymous,
		token: ref.token ?? undefined,
		seenReplies: 0,
		replies: 0,
		state: "open",
		stateReason: null,
	};
	addReport(report);
	return report;
}

/** What proves an anonymous report is ours; null for one filed on the user's GitHub account. */
export function replyToken(report: SubmittedReport): string | null {
	if (!report.anonymous) return null;
	if (!report.token) throw new Error("no reply token for this report");
	return report.token;
}

/** Store what a fetched thread says about its report. `seen` marks every reply in it read. */
export function recordThread(report: SubmittedReport, thread: IssueThread, seen = false): void {
	const replies = thread.comments.filter((c) => c.author !== thread.author).length;
	const patch = {
		replies,
		state: thread.state,
		stateReason: thread.stateReason,
		seenReplies: seen ? replies : report.seenReplies,
	};
	if ((Object.keys(patch) as Array<keyof typeof patch>).some((k) => patch[k] !== report[k])) {
		updateReport(report.number, patch);
	}
}

/** Refresh everything this install has filed. The unread-reply indicator sits outside the
 *  Feedback section, so reply counts cannot wait for the user to open it. Failures are
 *  per-report: one dead thread must not stop the rest from updating. */
export async function refreshStoredReports(): Promise<void> {
	await Promise.all(
		getReports().map(async (r) => {
			try {
				recordThread(r, await cmd.feedbackThread(r.number, replyToken(r)));
			} catch (e) {
				log.debug(`[feedback] refresh failed for #${r.number}: ${e}`);
			}
		}),
	);
}
