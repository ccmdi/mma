// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";

vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

// A GIF is staged as-is, so no canvas is needed to re-encode it.
const staged = vi.fn(async () => new Response(null, { status: 200 }));
vi.stubGlobal("fetch", staged);
URL.createObjectURL = () => "blob:preview";
URL.revokeObjectURL = () => {};

vi.mock("@/lib/commands", () => ({
	cmd: {
		feedbackLogTail: vi.fn().mockResolvedValue(""),
		githubMe: vi.fn().mockResolvedValue(null),
		storeUploadBegin: vi.fn().mockResolvedValue("session"),
		storeUploadAbort: vi.fn().mockResolvedValue(undefined),
	},
}));
vi.mock("@/lib/diagnostics", () => ({ collectDiagnostics: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/feedback/submit", () => ({
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
			pasteFiles(dialog, [new File(["x"], "shot.gif", { type: "image/gif" })]);
		});

		expect(staged).toHaveBeenCalledTimes(1);
		expect(document.querySelectorAll(".report-images__chip")).toHaveLength(1);
	});

	it("opens an attached image large, where it can be removed", async () => {
		await mountAsync(<ReportDialog open onOpenChange={() => {}} />);
		await act(async () => {});
		await act(async () => {
			pasteFiles(document.querySelector(".report-dialog")!, [
				new File(["x"], "shot.gif", { type: "image/gif" }),
			]);
		});
		await act(async () => {
			(document.querySelector(".report-images__chip > button") as HTMLElement).click();
		});
		expect(document.querySelector(".lightbox__image")?.getAttribute("alt")).toBe("shot.gif");
		await act(async () => {
			(document.querySelector(".lightbox .button--destructive") as HTMLElement).click();
		});
		expect(document.querySelectorAll(".report-images__chip")).toHaveLength(0);
		expect(document.querySelector(".lightbox__image")).toBeNull();
	});
});
