// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	buildIssueBody,
	parseReportBody,
	type Attachments,
	type ReportInput,
} from "@/lib/feedback/body";
import { changedFrom, type Diagnostics } from "@/lib/diagnostics";
import { refreshStoredReports, submitReport } from "@/lib/feedback/submit";
import { cmd } from "@/lib/commands";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import {
	ATTACHMENT_PREFS,
	getReports,
	reportStatus,
	unreadReplyCount,
	type SubmittedReport,
} from "@/store/feedback";
import { DEFAULTS as SETTINGS_DEFAULTS, PRIVATE_SETTINGS } from "@/store/settings";
import { reportKind } from "../../../workers/feedback/src/index";
import { leadingZeroBits } from "../../../workers/feedback/src/verify";

vi.mock("@/lib/commands", async (orig) => ({
	...(await orig()),
	cmd: {
		githubCreateIssue: vi.fn(async () => ({ number: 7, url: "https://x/7" })),
		feedbackRequestLabel: vi.fn(async () => null),
		githubMe: vi.fn(async () => ({ login: "me", avatarUrl: null })),
		githubIssueThread: vi.fn(async () => ({
			state: "open" as const,
			stateReason: null,
			comments: [{ author: "maintainer", body: "b", createdAt: "2026-08-14T00:00:00Z" }],
		})),
	},
}));

// The issue body is the whole product of this feature: it is what the maintainer reads and
// what any automation over these issues parses. These pin the two guarantees it makes --
// the machine block survives a round trip, and the body never exceeds what GitHub accepts.

const diagnostics: Diagnostics = {
	appVersion: "0.8.3",
	buildMode: "production",
	userAgent: "Mozilla/5.0 (Windows NT 10.0)",
	webglRenderer: "ANGLE (NVIDIA)",
	viewport: "1920x1080",
	devicePixelRatio: 2,
	opensvVersion: "3.63",
	startupMs: 1600,
	uptimeSecs: 3720,
	jsHeap: { usedBytes: 120_000_000, limitBytes: 4_294_967_296 },
	db: {
		maps: 3,
		locations: 12000,
		tags: 40,
		commits: 7,
		sizeBytes: 5_000_000,
		journalMode: "wal",
		foreignKeys: true,
	},
	plugins: ["vali@1.2.0", "generator"],
	changedSettings: { showRoadLabels: true },
	map: {
		locationCount: 500,
		tagCount: 4,
		dirtyCount: 2,
		changedSettings: { movementMode: "nmpz" },
	},
};

const ALL: Attachments = { diagnostics: true, settings: true, log: true };

const input: ReportInput = {
	kind: "bug",
	title: "Markers vanish at zoom 16",
	description: "They disappear when I zoom in.",
	steps: "1. open a map\n2. zoom to 16",
};

describe("issue body", () => {
	it("round-trips the machine-readable block", () => {
		const body = buildIssueBody(input, diagnostics, { anonymous: true, attach: ALL });
		const parsed = parseReportBody(body);
		expect(parsed).not.toBeNull();
		expect(parsed!.v).toBe(1);
		expect(parsed!.kind).toBe("bug");
		expect(parsed!.anonymous).toBe(true);
		expect(parsed!.diagnostics).toEqual(diagnostics);
	});

	it("survives a diagnostic value that would close the HTML comment early", () => {
		// An unescaped "-->" inside the JSON would terminate the comment and split the payload.
		const hostile = { ...diagnostics, webglRenderer: "evil --> renderer" };
		const body = buildIssueBody(input, hostile, { anonymous: false, attach: ALL });
		expect(parseReportBody(body)?.diagnostics?.webglRenderer).toBe("evil --> renderer");
	});

	it("carries the description, steps and diagnostics for a human reader", () => {
		const body = buildIssueBody(input, diagnostics, { anonymous: false, attach: ALL });
		expect(body).toContain("They disappear when I zoom in.");
		expect(body).toContain("Steps to reproduce");
		expect(body).toContain("ANGLE (NVIDIA)");
		expect(body).toContain("0.8.3");
	});

	it("omits the steps heading for suggestions", () => {
		const body = buildIssueBody({ ...input, kind: "idea" }, diagnostics, {
			anonymous: false,
			attach: ALL,
		});
		expect(body).not.toContain("Steps to reproduce");
		expect(parseReportBody(body)?.kind).toBe("idea");
	});

	it("only includes settings sections when something is non-default", () => {
		const clean: Diagnostics = { ...diagnostics, changedSettings: {}, map: null };
		expect(buildIssueBody(input, clean, { anonymous: false, attach: ALL })).not.toContain(
			"Non-default settings",
		);
		expect(buildIssueBody(input, diagnostics, { anonymous: false, attach: ALL })).toContain(
			"Non-default settings",
		);
	});

	it("attaches the log only when one is given", () => {
		const without = buildIssueBody(input, diagnostics, { anonymous: false, attach: ALL });
		expect(without).not.toContain("<summary>Log</summary>");
		const withLog = buildIssueBody(input, diagnostics, {
			anonymous: false,
			attach: ALL,
			logTail: "some log line",
		});
		expect(withLog).toContain("some log line");
	});

	it("truncates an oversized log instead of overflowing GitHub's body limit", () => {
		const body = buildIssueBody(input, diagnostics, {
			anonymous: false,
			attach: ALL,
			logTail: "x".repeat(200_000),
		});
		expect(body.length).toBeLessThanOrEqual(65_000);
		// The machine block must survive the truncation -- it is appended after the log.
		expect(parseReportBody(body)).not.toBeNull();
	});

	it("stays under the limit when the diagnostics themselves are huge", () => {
		// Settings are unbounded (custom CSS, saved selections with polygon geometry). Budgeting
		// only the log let these overflow the body on their own, which GitHub 422s.
		const bloated: Diagnostics = {
			...diagnostics,
			changedSettings: { customCss: "z".repeat(200_000) },
		};
		const body = buildIssueBody(input, bloated, { anonymous: false, attach: ALL });
		expect(body.length).toBeLessThanOrEqual(65_000);
		expect(parseReportBody(body)).not.toBeNull();
	});

	it("drops the log rather than emitting a useless fragment of it", () => {
		const bloated: Diagnostics = {
			...diagnostics,
			changedSettings: { customCss: "z".repeat(64_000) },
		};
		const body = buildIssueBody(input, bloated, {
			anonymous: false,
			attach: ALL,
			logTail: "a".repeat(5000),
		});
		expect(body.length).toBeLessThanOrEqual(65_000);
		expect(body).not.toContain("<summary>Log</summary>");
	});

	it("sends nothing a user withheld, in either the readable or the machine block", () => {
		// Settings appear twice -- the table and the payload -- so honouring the checkbox in one
		// place only would leak them through the other.
		const body = buildIssueBody(input, diagnostics, {
			anonymous: false,
			attach: { diagnostics: false, settings: false, log: false },
			logTail: "a log line they did not attach",
		});
		expect(body).not.toContain("ANGLE (NVIDIA)");
		expect(body).not.toContain("showRoadLabels");
		expect(body).not.toContain("a log line they did not attach");
		const parsed = parseReportBody(body);
		expect(parsed?.diagnostics).toBeNull();
		expect(parsed?.diagnosticsOmitted).toBe("declined");
		expect(body).toContain("They disappear when I zoom in.");
	});

	it("keeps the diagnostics when only the settings are withheld", () => {
		const body = buildIssueBody(input, diagnostics, {
			anonymous: false,
			attach: { diagnostics: true, settings: false, log: true },
		});
		expect(body).toContain("ANGLE (NVIDIA)");
		expect(body).not.toContain("Non-default settings");
		const parsed = parseReportBody(body);
		expect(parsed?.diagnostics?.webglRenderer).toBe("ANGLE (NVIDIA)");
		expect(parsed?.diagnostics?.changedSettings).toEqual({});
		expect(parsed?.diagnostics?.map?.changedSettings).toEqual({});
	});

	it("references attached images in the order the user arranged them", () => {
		const body = buildIssueBody(input, diagnostics, {
			anonymous: false,
			attach: ALL,
			images: [
				{ name: "first.png", url: "https://example.test/a.png" },
				{ name: "second.png", url: "https://example.test/b.png" },
			],
		});
		expect(body).toContain("![first.png](https://example.test/a.png)");
		expect(body).toContain("![second.png](https://example.test/b.png)");
		expect(body.indexOf("first.png")).toBeLessThan(body.indexOf("second.png"));
		// A screenshot is read before the diagnostics, so it goes above them.
		expect(body.indexOf("first.png")).toBeLessThan(body.indexOf("<summary>Diagnostics"));
	});

	it("returns null for a body with no machine block", () => {
		expect(parseReportBody("just a normal issue someone filed by hand")).toBeNull();
	});
});

describe("settings diff", () => {
	it("keeps only the keys that differ from the defaults", () => {
		const defaults = { a: 1, b: "two", c: false, d: [1, 2] };
		const current = { a: 1, b: "changed", c: true, d: [1, 2] };
		expect(changedFrom(current, defaults)).toEqual({ b: "changed", c: true });
	});

	it("compares structurally rather than by reference", () => {
		expect(changedFrom({ a: [1, 2] }, { a: [1, 2] })).toEqual({});
		expect(changedFrom({ a: [1, 3] }, { a: [1, 2] })).toEqual({ a: [1, 3] });
	});

	it("summarizes oversized values instead of carrying them", () => {
		const css = changedFrom({ customCss: "z".repeat(50_000) }, { customCss: "" });
		expect(css.customCss).toMatch(/^<omitted: 50000 chars, [\d.]+ KB>$/);

		const selections = changedFrom(
			{ saved: Array.from({ length: 300 }, (_, i) => ({ poly: [i, i, i, i, i] })) },
			{ saved: [] },
		);
		expect(selections.saved).toMatch(/^<omitted: 300 items, [\d.]+ KB>$/);
	});

	it("leaves values under the threshold intact", () => {
		expect(changedFrom({ a: "short" }, { a: "" })).toEqual({ a: "short" });
	});

	it("never emits the value of a private setting", () => {
		// remoteApiKey and nominatimApiKey are credentials; a report that carries them hands
		// them to whoever reads the issue.
		const got = changedFrom(
			{ remoteApiKey: "super-secret-value", tagGap: 4 },
			{ remoteApiKey: "", tagGap: 2 },
			(k) => k === "remoteApiKey",
		);
		expect(JSON.stringify(got)).not.toContain("super-secret-value");
		expect(got.remoteApiKey).toBe("<set, redacted>");
		// Redacted, not dropped: knowing one is configured is useful, its value never is.
		expect(got.tagGap).toBe(4);
	});

	it("says nothing about a private setting left at its default", () => {
		const got = changedFrom({ remoteApiKey: "" }, { remoteApiKey: "" }, () => true);
		expect(got).toEqual({});
	});
});

describe("private settings registry", () => {
	it("covers every credential-shaped key in AppSettings", () => {
		// A new secret added to DEFAULTS without registering it here would silently ship in
		// every report, which is exactly how remoteApiKey leaked.
		const suspicious = Object.keys(SETTINGS_DEFAULTS).filter((k) =>
			/key|token|secret|password|credential/i.test(k),
		);
		expect(suspicious.length).toBeGreaterThan(0);
		for (const k of suspicious) {
			expect(PRIVATE_SETTINGS.has(k as keyof typeof SETTINGS_DEFAULTS)).toBe(true);
		}
	});
});

describe("report status", () => {
	const report = (patch: Partial<SubmittedReport>): SubmittedReport => ({
		number: 1,
		url: "https://github.com/x/y/issues/1",
		title: "t",
		kind: "bug",
		submittedAt: "2026-08-14T00:00:00Z",
		anonymous: false,
		seenReplies: 0,
		replies: 0,
		...patch,
	});

	it("shows nothing until a refresh has said what became of the report", () => {
		// Reports filed before status existed, and threads that have never been reachable.
		expect(reportStatus(report({}))).toBeNull();
	});

	it("distinguishes closed-as-done from closed-as-not-planned", () => {
		expect(reportStatus(report({ state: "open" }))?.tone).toBe("open");
		expect(reportStatus(report({ state: "closed", stateReason: "completed" }))?.tone).toBe("done");
		expect(reportStatus(report({ state: "closed", stateReason: "not_planned" }))?.tone).toBe(
			"dismissed",
		);
	});

	it("treats a closed issue with no recorded reason as done", () => {
		// GitHub only started recording reasons in 2022; older issues carry none.
		expect(reportStatus(report({ state: "closed", stateReason: null }))?.tone).toBe("done");
	});

	it("gives a report a status the moment it is filed", async () => {
		// GitHub has just created the issue, so waiting for a refresh to learn it is open left
		// a freshly sent report with no status until the settings page was reopened.
		localStorage.clear();
		const filed = await submitReport({ kind: "bug", title: "t", description: "d" }, "body", false);
		expect(reportStatus(filed)?.tone).toBe("open");
		expect(reportStatus(getReports()[0])?.tone).toBe("open");
	});
});

describe("what a report attaches", () => {
	it("starts a suggestion with nothing attached and a bug with everything", () => {
		expect(Object.values(ATTACHMENT_PREFS.defaults.idea).some(Boolean)).toBe(false);
		expect(Object.values(ATTACHMENT_PREFS.defaults.bug).every(Boolean)).toBe(true);
	});

	it("remembers each kind's choice separately", () => {
		localStorage.clear();
		const prefs = getLocal(ATTACHMENT_PREFS);
		setLocal(ATTACHMENT_PREFS, { ...prefs, idea: { ...prefs.idea, diagnostics: true } });
		expect(getLocal(ATTACHMENT_PREFS).idea.diagnostics).toBe(true);
		expect(getLocal(ATTACHMENT_PREFS).bug).toEqual(ATTACHMENT_PREFS.defaults.bug);
	});
});

// The unread indicator is only as good as the counts behind it, and it is refreshed for every
// stored report at once.
describe("refreshing filed reports", () => {
	const stored = (number: number): SubmittedReport => ({
		number,
		url: `https://github.com/x/y/issues/${number}`,
		title: `t${number}`,
		kind: "bug",
		submittedAt: "2026-08-14T00:00:00Z",
		anonymous: false,
		seenReplies: 0,
		replies: 0,
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("asks who the user is once, not once per report", async () => {
		// The login is what filters the reporter's own comments out of the reply count; resolving
		// it inside the per-report fetch made a refresh N identical round trips.
		setLocal("feedbackReports", [stored(1), stored(2), stored(3)]);
		await refreshStoredReports();
		expect(vi.mocked(cmd.githubMe)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(cmd.githubIssueThread)).toHaveBeenCalledTimes(3);
	});

	it("records what it finds as unread", async () => {
		setLocal("feedbackReports", [stored(1)]);
		await refreshStoredReports();
		expect(unreadReplyCount(getReports())).toBe(1);
	});

	it("touches the network only when something has been filed", async () => {
		setLocal("feedbackReports", []);
		await refreshStoredReports();
		expect(vi.mocked(cmd.githubMe)).not.toHaveBeenCalled();
	});
});

describe("worker label parity", () => {
	// The worker reads the kind back out of the body the app composed, so the marker and the
	// escaping are a matched pair across two codebases. It is also the worker's only
	// authorization check: anything it cannot recognise, it refuses to label.
	it("reads the kind out of a body the app actually composed", () => {
		const bug = buildIssueBody(input, diagnostics, { anonymous: true, attach: ALL });
		expect(reportKind(bug)).toBe("bug");
		const idea = buildIssueBody({ ...input, kind: "idea" }, diagnostics, {
			anonymous: true,
			attach: ALL,
		});
		expect(reportKind(idea)).toBe("idea");
	});

	it("refuses anything that is not one of our reports", () => {
		expect(reportKind("an issue someone filed by hand")).toBeNull();
		// A client writes the body, so a kind outside the allowlist must not become a label.
		expect(reportKind('<!-- mma-report {"v":1,"kind":"security"} -->')).toBeNull();
		expect(reportKind("<!-- mma-report not json -->")).toBeNull();
	});
});

describe("proof-of-work parity", () => {
	// The worker verifies what Rust solves. These are the same vectors asserted in
	// `app/src-tauri/src/feedback.test.rs`; if the two implementations drift, spam control
	// silently stops matching and every real submission is rejected.
	it("counts leading zero bits the same way Rust does", () => {
		expect(leadingZeroBits(new Uint8Array(32).fill(0xff))).toBe(0);
		const d = new Uint8Array(32);
		d[1] = 0b0001_0000;
		expect(leadingZeroBits(d)).toBe(11);
		expect(leadingZeroBits(new Uint8Array(32))).toBe(256);
	});
});
