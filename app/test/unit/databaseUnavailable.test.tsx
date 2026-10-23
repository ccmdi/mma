// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { mountAsync } from "./fixtures/harness";

vi.stubGlobal("__APP_VERSION__", "0.0.0-test");

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(), Command: {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/plugins", () => ({}));
vi.mock("@/components/editor/MapEditor", () => ({ MapEditor: () => null }));
vi.mock("@/components/manual/Manual", () => ({ Manual: () => null }));
vi.mock("@/components/manual/ManualSearch", () => ({ ManualSearch: () => null }));
vi.mock("@/lib/remote/host", () => ({ initRemoteHost: vi.fn() }));
vi.mock("@/lib/discord/presence", () => ({ useDiscordPresence: vi.fn() }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/util/updateCheck", () => ({
	useUpdateState: () => ({
		phase: "available",
		version: "9.9.9",
		dismissed: false,
		prerelease: false,
	}),
	describeUpdate: () => ({
		status: "",
		pending: true,
		action: { label: "Update", run: vi.fn() },
	}),
	dismissUpdate: vi.fn(),
	checkForUpdate: vi.fn(),
}));
vi.mock("@/lib/commands", () => ({
	cmd: new Proxy({}, { get: () => vi.fn().mockRejectedValue(new Error("database-newer")) }),
}));

const { Database } = await import("@/lib/database");
const { default: App } = await import("@/App");

describe("the app without its database", () => {
	it("shows why, and keeps updating, settings and help within reach, but nothing that reads maps", async () => {
		Database.fail(new Error("The database is from a newer version of the app"));
		const { unmount } = await mountAsync(<App />);
		const labels = [...document.querySelectorAll("[aria-label]")].map((e) =>
			e.getAttribute("aria-label"),
		);

		expect(document.querySelector(".error-screen")?.textContent).toContain("newer version");
		expect(document.querySelector(".update-pill")?.textContent).toContain("v9.9.9");
		expect(labels).toEqual(expect.arrayContaining(["Settings", "Manual", "Join the Discord"]));
		expect(labels).not.toContain("Scratch map");
		expect(labels).not.toContain("Plugins");
		expect(document.querySelector(".map-list")).toBeNull();
		unmount();
	});
});
