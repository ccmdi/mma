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

/** Refresh state and reply counts for every stored report. Failures are per-report: one dead
 *  thread must not stop the rest from updating. */
export async function refreshReports(reports: SubmittedReport[]): Promise<void> {
	await Promise.all(
		reports.map(async (r) => {
			try {
				const token = r.anonymous ? r.token : null;
				if (token === undefined) throw new Error("no reply token for this report");
				const { state, stateReason, comments } = await cmd.feedbackThread(r.number, token);
				if (comments.length !== r.replies || state !== r.state || stateReason !== r.stateReason) {
					updateReport(r.number, { replies: comments.length, state, stateReason });
				}
			} catch (e) {
				log.debug(`[feedback] refresh failed for #${r.number}: ${e}`);
			}
		}),
	);
}

/** Refresh everything this install has filed. The unread-reply indicator sits outside the
 *  Feedback section, so reply counts cannot wait for the user to open it. */
export async function refreshStoredReports(): Promise<void> {
	const reports = getReports();
	if (reports.length) await refreshReports(reports);
}
