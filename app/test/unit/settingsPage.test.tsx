// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { initLocale } from "@/lib/i18n";
import { setLocal } from "@/lib/hooks/useLocalStorage";
import type { SubmittedReport } from "@/store/feedback";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/util/updateCheck", () => ({
	useUpdateState: () => ({ phase: "idle" }),
	checkForUpdate: vi.fn(),
	installUpdate: vi.fn(),
	relaunchApp: vi.fn(),
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		checkBorderFile: vi.fn().mockResolvedValue(true),
		downloadBorderFile: vi.fn(),
		getDataLocation: vi.fn().mockResolvedValue({ path: "/data", default_path: "/data" }),
		openDataFolder: vi.fn(),
		openLogFile: vi.fn(),
		githubMe: vi.fn().mockResolvedValue(null),
		// Unreachable on purpose: a report keeps the state it was last told, rather than losing
		// its status the moment a refresh fails.
		githubIssueThread: vi.fn().mockRejectedValue(new Error("offline")),
	},
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
// The log plugin invokes Tauri, which is absent here.
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { SettingsPage, UnreadReplyDot } = await import("@/components/dialogs/SettingsPage");

let unmount: (() => void) | null = null;

/** Queries run against the whole document, so a leaked dialog would be read as the next
 *  test's DOM. Unmount from afterEach rather than at the end of each test body. */
async function mount(node: ReactNode = <SettingsPage open onOpenChange={() => {}} />) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(node));
	// Border/data-location effects resolve their mocked IPC on the microtask queue.
	await act(async () => {});
	unmount = () => {
		act(() => root.unmount());
		container.remove();
	};
}

afterEach(() => {
	unmount?.();
	unmount = null;
});

/** Radix portals the dialog to document.body, so queries run against the whole document. */
const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];

function search(text: string) {
	const input = q(".settings-rail__search") as HTMLInputElement;
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.bind(
			input,
		);
		setter(text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("settings rail", () => {
	beforeAll(async () => {
		await initLocale("fr");
	});

	it("translates section labels", async () => {
		await mount();
		expect(q('[data-qa="settings-nav-keyboard"]')?.textContent).toContain("Clavier");
		expect(q('[data-qa="settings-nav-editing"]')?.textContent).toContain("Édition");
		expect(q('[data-qa="settings-nav-advanced"]')?.textContent).toContain("Avancé");
	});

	it("opens on Street View, not the hotkey table", async () => {
		await mount();
		expect(q(".settings-nav-item--active")?.getAttribute("data-qa")).toBe(
			"settings-nav-streetview",
		);
	});
});

// Search matches the labels as rendered, so it is locale-sensitive by design.
describe("settings search", () => {
	beforeAll(async () => {
		await initLocale("en");
	});

	// "spawn" is a static binding; Command-backed ones (Undo, etc.) only register with a map open.
	it("reaches hotkeys from the dialog-wide search box", async () => {
		await mount();
		search("spawn");
		const rows = qa(".settings-hotkey-table tr[id^='hotkey-row-']");
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) expect(r.textContent?.toLowerCase()).toContain("spawn");
	});

	it("shows the whole hotkey table when the section title itself matches", async () => {
		await mount();
		search("keyboard");
		const visible = qa('[data-qa="settings-section-keyboard"] tr[id^="hotkey-row-"]');
		expect(visible.length).toBeGreaterThan(20);
	});

	it("still filters ordinary setting rows", async () => {
		await mount();
		search("crosshair");
		const titles = qa(".setting-row__title").map((n) => n.textContent?.toLowerCase() ?? "");
		expect(titles.length).toBeGreaterThan(0);
		for (const title of titles) expect(title).toContain("crosshair");
	});

	it("a group title is part of every row's path, and the matching group keeps its heading", async () => {
		await mount();
		search("tags");
		const titles = qa(".setting-row__title").map((n) => n.textContent ?? "");
		expect(titles).toContain("View mode");
		expect(qa(".settings-group").map((n) => n.textContent)).toContain("Tags");
	});

	it("a select row is found by one of its option labels", async () => {
		await mount();
		search("tree");
		expect(qa(".setting-row__title").map((n) => n.textContent)).toContain("View mode");
	});

	it("a row match keeps its group heading, and headings with nothing under them stay listed only in the DOM", async () => {
		await mount();
		search("view mode");
		const rows = qa(".setting-row__title").map((n) => n.textContent);
		expect(rows).toEqual(["View mode"]);
		const block = q(".settings-group-block:has(.setting-row)");
		expect(block?.querySelector(".settings-group")?.textContent).toBe("Tags");
	});
});

// The report list is the only place a filed report's fate is visible in the app.
describe("feedback reports", () => {
	beforeAll(async () => {
		await initLocale("en");
	});

	it("marks each report with the state GitHub reported", async () => {
		// setLocal, not localStorage: the store keeps an in-memory authority that is read once.
		setLocal("feedbackReports", [
			{
				number: 5,
				url: "u",
				title: "open one",
				kind: "bug",
				submittedAt: "2026-08-14T00:00:00Z",
				anonymous: false,
				seenReplies: 0,
				replies: 0,
				state: "open",
				stateReason: null,
			},
			{
				number: 4,
				url: "u",
				title: "declined one",
				kind: "bug",
				submittedAt: "2026-08-14T00:00:00Z",
				anonymous: false,
				seenReplies: 0,
				replies: 0,
				state: "closed",
				stateReason: "not_planned",
			},
		]);
		await mount();
		search("feedback");
		expect(qa(".feedback-reports__status--open").length).toBe(1);
		expect(qa(".feedback-reports__status--dismissed").length).toBe(1);
		expect(q(".feedback-reports__status--open svg")).not.toBeNull();
	});
});

// A reply is undiscoverable unless something outside the Feedback section says one arrived.
describe("unread replies", () => {
	beforeAll(async () => {
		await initLocale("en");
	});

	const report = (patch: Partial<SubmittedReport>): SubmittedReport => ({
		number: 9,
		url: "u",
		title: "t",
		kind: "bug",
		submittedAt: "2026-08-14T00:00:00Z",
		anonymous: false,
		seenReplies: 0,
		replies: 0,
		...patch,
	});

	const railBadge = () => q('[data-qa="settings-nav-feedback"] .settings-nav-item__badge');

	it("counts them on the Feedback section label", async () => {
		setLocal("feedbackReports", [report({ replies: 3, seenReplies: 1 })]);
		await mount();
		expect(railBadge()?.textContent).toBe("2");
	});

	it("counts nothing once every reply has been read", async () => {
		setLocal("feedbackReports", [report({ replies: 3, seenReplies: 3 })]);
		await mount();
		expect(railBadge()).toBeNull();
	});

	it("dots the entry points that lead to the report list", async () => {
		setLocal("feedbackReports", [report({ replies: 1 })]);
		await mount(<UnreadReplyDot />);
		expect(q(".feedback-dot")).not.toBeNull();
	});

	it("leaves them undotted when nothing is unread", async () => {
		setLocal("feedbackReports", [report({ replies: 1, seenReplies: 1 })]);
		await mount(<UnreadReplyDot />);
		expect(q(".feedback-dot")).toBeNull();
	});
});
