// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";

vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

const stageImage = vi.hoisted(() =>
	vi.fn(async (_session: string, file: File, index: number) => ({
		id: `${index}`,
		name: file.name,
		path: `staged/${index}`,
		preview: "",
		size: file.size,
	})),
);

vi.mock("@/lib/commands", () => ({
	cmd: {
		feedbackLogTail: vi.fn().mockResolvedValue(""),
		storeUploadBegin: vi.fn().mockResolvedValue("session"),
		storeUploadAbort: vi.fn().mockResolvedValue(undefined),
	},
}));
vi.mock("@/lib/feedback/attachments", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/feedback/attachments")>()),
	stageImage,
}));
vi.mock("@/lib/diagnostics", () => ({ collectDiagnostics: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/feedback/submit", () => ({
	isSignedIn: vi.fn().mockResolvedValue(false),
	submitReport: vi.fn(),
}));
vi.mock("@/lib/feedback/body", () => ({ buildIssueBody: () => "" }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { ReportDialog } = await import("@/components/dialogs/ReportDialog");

/** A browser empties a paste's file list once the event returns. */
function pasteFiles(target: Element, files: File[]) {
	const list = [...files];
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", { value: { files: list } });
	target.dispatchEvent(event);
	list.length = 0;
}

describe("ReportDialog images", () => {
	it("attaches the very first pasted image", async () => {
		await mountAsync(<ReportDialog open onOpenChange={() => {}} />);
		await act(async () => {});
		const dialog = document.querySelector(".report-dialog")!;
		expect(dialog).not.toBeNull();

		await act(async () => {
			pasteFiles(dialog, [new File(["x"], "shot.png", { type: "image/png" })]);
		});

		expect(stageImage).toHaveBeenCalledTimes(1);
		expect(document.querySelectorAll(".report-dialog__image")).toHaveLength(1);
	});
});
