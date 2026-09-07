// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";
import { initLocale } from "@/lib/i18n";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

// cmdk observes its list's size and scrolls the selection into view; jsdom has neither.
vi.stubGlobal(
	"ResizeObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);
Element.prototype.scrollIntoView = () => {};

const { registerPlugin, unregisterPlugin, setPluginEnabled } = await import("@/plugins/registry");
const { openDialog, useDialog } = await import("@/store/dialogBus");
const { getMapState } = await import("@/store/useMapStore");
const { CommandPalette } = await import("@/components/editor/CommandPalette");

function ModalProbe({ spy }: { spy: (id: string) => void }) {
	useDialog("plugin-modal", spy);
	return null;
}

const paletteItems = () => [...document.querySelectorAll(".command-palette__item")];

const itemFor = (label: string) =>
	paletteItems().find((el) => el.textContent?.includes(label)) as HTMLElement | undefined;

describe("command palette plugin entries", () => {
	beforeAll(async () => {
		await initLocale("en");
		registerPlugin({
			id: "test-sidebar",
			name: "Sidebar Plugin",
			description: "",
			icon: "M0 0",
			activate: () => {},
			sidebar: () => null,
		});
		registerPlugin({
			id: "test-modal",
			name: "Modal Plugin",
			description: "",
			icon: "M0 0",
			activate: () => {},
			modal: () => null,
		});
		registerPlugin({
			id: "test-background",
			name: "Background Plugin",
			description: "",
			icon: "M0 0",
			activate: () => {},
		});
		for (const id of ["test-sidebar", "test-modal", "test-background"])
			setPluginEnabled(id, true);
	});

	afterAll(() => {
		for (const id of ["test-sidebar", "test-modal", "test-background"]) {
			setPluginEnabled(id, false);
			unregisterPlugin(id);
		}
	});

	it("lists every openable enabled plugin, and only those", async () => {
		await mountAsync(<CommandPalette />);
		act(() => openDialog("command-palette"));
		expect(itemFor("Sidebar Plugin")).toBeTruthy();
		expect(itemFor("Modal Plugin")).toBeTruthy();
		expect(itemFor("Background Plugin")).toBeUndefined();
	});

	it("a sidebar plugin entry enters plugin mode, exactly like its toolbar button", async () => {
		await mountAsync(<CommandPalette />);
		act(() => openDialog("command-palette"));
		act(() => itemFor("Sidebar Plugin")!.click());
		expect(getMapState().activePluginId).toBe("test-sidebar");
		expect(getMapState().workArea).toBe("plugin");
	});

	it("a modal plugin entry opens its modal through the dialog bus", async () => {
		const spy = vi.fn();
		await mountAsync(
			<>
				<CommandPalette />
				<ModalProbe spy={spy} />
			</>,
		);
		act(() => openDialog("command-palette"));
		act(() => itemFor("Modal Plugin")!.click());
		expect(spy).toHaveBeenCalledWith("test-modal");
	});
});
