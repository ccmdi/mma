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

/** What became of one report and what has been said on it, whichever transport filed it.
 *  `me` is the signed-in login, or null for signed out; omit it to look it up. */
export async function fetchThread(
	report: SubmittedReport,
	me?: string | null,
): Promise<IssueThread> {
	if (report.anonymous) {
		if (!report.token) throw new Error("no reply token for this report");
		return cmd.feedbackAnonymousThread(report.number, report.token);
	}
	const login = me === undefined ? ((await cmd.githubMe())?.login ?? null) : me;
	const thread = await cmd.githubIssueThread(report.number);
	// The reporter's own comments are not replies to themselves.
	return { ...thread, comments: thread.comments.filter((c) => c.author !== login) };
}

/** Refresh state and reply counts for every stored report. Failures are per-report: one dead
 *  thread must not stop the rest from updating. */
export async function refreshReports(reports: SubmittedReport[]): Promise<void> {
	// One identity lookup for the sweep -- fetchThread would otherwise ask per report.
	const me = reports.some((r) => !r.anonymous)
		? await cmd
				.githubMe()
				.then((u) => u?.login ?? null)
				.catch(() => null)
		: null;
	await Promise.all(
		reports.map(async (r) => {
			try {
				const { state, stateReason, comments } = await fetchThread(r, me);
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
