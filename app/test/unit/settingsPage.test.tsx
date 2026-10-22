// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { act, type ReactNode } from "react";
import { mountAsync, typeInto } from "./fixtures/harness";
import { initLocale } from "@/lib/i18n";
import { setLocal } from "@/lib/hooks/useLocalStorage";
import type { SubmittedReport } from "@/store/feedback";
import { useDialog } from "@/store/dialogBus";
import type { MapMeta, MapPreferences } from "@/bindings.gen";
import { cmd } from "@/lib/commands";

vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/util/updateCheck", () => ({
	useUpdateState: () => ({ phase: "idle" }),
	describeUpdate: () => ({ status: "", action: null, pending: false }),
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
		feedbackThread: vi.fn().mockRejectedValue(new Error("offline")),
		storeGetMapDefaults: vi.fn().mockResolvedValue(null),
		storeSetMapDefaults: vi.fn().mockResolvedValue(null),
	},
}));
let openMap: MapMeta | null = null;
vi.mock("@/store/store", async (importOriginal) => {
	const store = await importOriginal<typeof import("@/store/store")>();
	return {
		Store: {
			...store.Store,
			use: <T,>(select: (state: ReturnType<typeof store.Store.get>) => T) =>
				select({ ...store.Store.get(), map: openMap }),
		},
	};
});

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
// The log plugin invokes Tauri, which is absent here.
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { SettingsPage, UnreadReplyDot } = await import("@/components/dialogs/SettingsPage");

let unmount: (() => void) | null = null;

/** Queries run against the whole document, so a leaked dialog would be read as the next
 *  test's DOM. Unmount from afterEach rather than at the end of each test body. */
async function mount(node: ReactNode = <SettingsPage open onOpenChange={() => {}} />) {
	// Border/data-location effects resolve their mocked IPC on the microtask queue.
	unmount = (await mountAsync(node)).unmount;
}

afterEach(() => {
	unmount?.();
	unmount = null;
});

/** Radix portals the dialog to document.body, so queries run against the whole document. */
const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];

function search(text: string) {
	typeInto(q(".settings-rail__search input") as HTMLInputElement, text);
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
		expect(q(".nav-item--active")?.getAttribute("data-qa")).toBe("settings-nav-streetview");
	});
});

// Search matches the labels as rendered, so it is locale-sensitive by design.
describe("settings search", () => {
	beforeAll(async () => {
		await initLocale("en");
	});

	it("focuses the search box when the dialog opens", async () => {
		await mount();
		expect(document.activeElement).toBe(q(".settings-rail__search input"));
	});

	// "spawn" is a static binding; Command-backed ones (Undo, etc.) only register with a map open.
	it("reaches hotkeys from the dialog-wide search box", async () => {
		await mount();
		search("spawn");
		const rows = qa(".data-table tr[id^='hotkey-row-']");
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
		search("tags view mode");
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
		expect(qa(".report-status--open").length).toBe(1);
		expect(qa(".report-status--dismissed").length).toBe(1);
		expect(q(".report-status--open svg")).not.toBeNull();
	});

	it("opens a report's conversation", async () => {
		setLocal("feedbackReports", [
			{
				number: 8,
				url: "u",
				title: "a report",
				kind: "bug",
				submittedAt: "2026-08-14T00:00:00Z",
				anonymous: true,
				token: "t",
				seenReplies: 0,
				replies: 0,
			},
		]);
		const opened = vi.fn();
		function Listener() {
			useDialog("report-thread", opened);
			return null;
		}
		await mount(
			<>
				<Listener />
				<SettingsPage open onOpenChange={() => {}} />
			</>,
		);
		search("feedback");
		act(() => (q(".feedback-reports__item") as HTMLElement).click());
		expect(opened).toHaveBeenCalledWith(8);
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

	const railBadge = () => q('[data-qa="settings-nav-feedback"] .nav-item__badge');

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

// Saving defaults copies the open map's preferences; the rest of its settings refer to that map.
describe("new map defaults", () => {
	beforeAll(async () => {
		await initLocale("en");
	});

	afterEach(() => {
		openMap = null;
		vi.mocked(cmd.storeGetMapDefaults).mockReset().mockResolvedValue(null);
		vi.mocked(cmd.storeSetMapDefaults).mockReset();
	});

	const button = (label: string) =>
		qa(".setting-row button").find((b) => b.textContent === label) as HTMLButtonElement;
	const description = () => q(".setting-row__desc")?.textContent;

	it("saves the open map's settings as the defaults, then resets them", async () => {
		openMap = { id: "m", settings: { pointAlongRoad: false } } as MapMeta;
		let stored: MapPreferences | null = null;
		vi.mocked(cmd.storeSetMapDefaults).mockImplementation(async (preferences) => {
			stored = preferences;
			return null;
		});
		vi.mocked(cmd.storeGetMapDefaults).mockImplementation(async () => stored);
		await mount();
		search("new maps");
		expect(description()).toBe("New maps start from the factory preferences.");
		expect(button("Reset").disabled).toBe(true);

		await act(async () => button("Use current map").click());
		expect(cmd.storeSetMapDefaults).toHaveBeenLastCalledWith({ pointAlongRoad: false });
		expect(description()).toContain("saved preferences");

		await act(async () => button("Reset").click());
		expect(cmd.storeSetMapDefaults).toHaveBeenLastCalledWith(null);
		expect(description()).toBe("New maps start from the factory preferences.");
	});

	it("has nothing to save from with no map open", async () => {
		await mount();
		search("new maps");
		expect(button("Use current map").disabled).toBe(true);
	});

	it("offers a reset when defaults are already saved", async () => {
		vi.mocked(cmd.storeGetMapDefaults).mockResolvedValue({} as MapPreferences);
		await mount();
		search("new maps");
		expect(button("Reset").disabled).toBe(false);
	});
});
