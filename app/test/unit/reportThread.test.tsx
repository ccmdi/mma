// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";
import { initLocale } from "@/lib/i18n";
import { cmd } from "@/lib/commands";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import type { IssueThread } from "@/bindings.gen";
import type { SubmittedReport } from "@/store/feedback";

vi.mock("@/lib/commands", () => ({
	cmd: {
		feedbackThread: vi.fn(),
		feedbackReply: vi.fn(),
		feedbackLogTail: vi.fn().mockResolvedValue("a log line"),
		storeUploadAbort: vi.fn().mockResolvedValue(null),
	},
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { ReportThread } = await import("@/components/dialogs/ReportThread");

const BOT = "mma-feedback[bot]";

const report = (patch: Partial<SubmittedReport> = {}): SubmittedReport => ({
	number: 3,
	url: "https://github.com/x/y/issues/3",
	title: "Markers vanish",
	kind: "bug",
	submittedAt: "2026-09-01T00:00:00Z",
	anonymous: true,
	token: "tok",
	seenReplies: 1,
	replies: 1,
	state: "open",
	stateReason: null,
	...patch,
});

const thread = (patch: Partial<IssueThread> = {}): IssueThread => ({
	state: "open",
	stateReason: null,
	author: BOT,
	locked: false,
	body: 'They disappear.\n\n<details>\n<summary>Log</summary>\n\nx\n\n</details>\n\n<!-- mma-report {"v":1} -->',
	comments: [
		{ author: "ccmdi", avatarUrl: null, body: "Which version?", createdAt: "2026-09-02T00:00:00Z" },
		{ author: BOT, avatarUrl: null, body: "0.11.2", createdAt: "2026-09-03T00:00:00Z" },
		{ author: "ccmdi", avatarUrl: null, body: "Fixed.", createdAt: "2026-09-04T00:00:00Z" },
	],
	...patch,
});

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
const bylines = () => qa(".report-thread__byline strong").map((n) => n.textContent);

async function open(r: SubmittedReport) {
	setLocal("feedbackReports", [r]);
	await mountAsync(<ReportThread number={r.number} open onOpenChange={() => {}} />);
	await act(async () => {});
}

function type(el: HTMLTextAreaElement, value: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeAll(async () => {
	await initLocale("en");
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(cmd.feedbackThread).mockResolvedValue(thread());
});

describe("ReportThread", () => {
	it("shows the report, then the conversation, with the reporter's own words as theirs", async () => {
		await open(report());
		expect(cmd.feedbackThread).toHaveBeenCalledWith(3, "tok");
		expect(bylines()).toEqual(["You", "ccmdi", "You", "ccmdi"]);
		const first = q(".report-thread__entry .markdown")!;
		expect(first.textContent).toBe("They disappear.");
	});

	it("marks where unread replies start, and counts them read once shown", async () => {
		await open(report());
		const order = qa(".report-thread__new, .report-thread__byline strong").map((n) =>
			n.classList.contains("report-thread__new") ? "|new|" : n.textContent,
		);
		expect(order).toEqual(["You", "ccmdi", "You", "|new|", "ccmdi"]);
		const [stored] = getLocal<SubmittedReport[]>("feedbackReports", []);
		expect(stored.replies).toBe(2);
		expect(stored.seenReplies).toBe(2);
	});

	it("posts a reply as the reporter, with the log when asked", async () => {
		vi.mocked(cmd.feedbackReply).mockResolvedValue({
			author: BOT,
			avatarUrl: null,
			body: "here",
			createdAt: "2026-09-05T00:00:00Z",
		});
		await open(report());
		type(q(".report-thread__draft") as HTMLTextAreaElement, "here");
		act(() => (q('[aria-label="Attach recent log"]') as HTMLElement).click());
		await act(async () => {
			(q(".report-thread__tools .button--primary") as HTMLElement).click();
		});
		const [number, token, body] = vi.mocked(cmd.feedbackReply).mock.calls[0];
		expect([number, token]).toEqual([3, "tok"]);
		expect(body).toContain("here");
		expect(body).toContain("a log line");
		expect(bylines().at(-1)).toBe("You");
		expect((q(".report-thread__draft") as HTMLTextAreaElement).value).toBe("");
	});

	it("replies as the signed-in user on a report filed from their account", async () => {
		await open(report({ anonymous: false, token: undefined }));
		expect(cmd.feedbackThread).toHaveBeenCalledWith(3, null);
	});

	it("offers no reply box on a locked conversation", async () => {
		vi.mocked(cmd.feedbackThread).mockResolvedValue(thread({ locked: true }));
		await open(report());
		expect(q(".report-thread__composer")).toBeNull();
		expect(q(".report-thread__locked")).not.toBeNull();
	});

	it("says why the thread could not be read", async () => {
		vi.mocked(cmd.feedbackThread).mockRejectedValue(new Error("offline"));
		await open(report());
		expect(q(".notice--error")?.textContent).toContain("offline");
		expect(q(".report-thread__composer")).toBeNull();
	});
});
