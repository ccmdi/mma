// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import {
	registerPlugin,
	unregisterPlugin,
	getPlugins,
	isBackgroundPlugin,
	setPluginEnabled,
	type Plugin,
} from "@/plugins/registry";
import { PluginButtons, PluginModal, PluginSlot } from "@/plugins/PluginPanels";
import { openDialog } from "@/store/dialogBus";
import { mount } from "./fixtures/harness";

function makePlugin(id: string, extra: Partial<Plugin> = {}): Plugin {
	return { id, name: id, description: "test", icon: "test", activate: vi.fn(), ...extra };
}

beforeEach(() => {
	for (const p of getPlugins()) {
		setPluginEnabled(p.id, false);
		unregisterPlugin(p.id);
	}
	localStorage.clear();
});

describe("plugin slots", () => {
	it("renders the layer of each enabled plugin and follows enablement", () => {
		registerPlugin(makePlugin("a", { layer: () => <div className="launch-a" /> }));
		registerPlugin(makePlugin("b", { layer: () => <div className="launch-b" /> }));
		setPluginEnabled("a", true);
		const { container } = mount(<PluginSlot slot="layer" />);

		expect(container.querySelector(".launch-a")).not.toBeNull();
		expect(container.querySelector(".launch-b")).toBeNull();

		act(() => setPluginEnabled("b", true));
		expect(container.querySelector(".launch-b")).not.toBeNull();

		act(() => setPluginEnabled("a", false));
		expect(container.querySelector(".launch-a")).toBeNull();
	});

	it("renders the header item of each enabled plugin, and nothing for one that returns null", () => {
		registerPlugin(makePlugin("a", { headerItem: () => <span className="header-a" /> }));
		registerPlugin(makePlugin("b", { headerItem: () => <span className="header-b" /> }));
		registerPlugin(makePlugin("c", { headerItem: () => null }));
		setPluginEnabled("a", true);
		setPluginEnabled("c", true);
		const { container } = mount(
			<header>
				<PluginSlot slot="headerItem" />
			</header>,
		);

		expect(container.querySelector("header")!.innerHTML).toBe('<span class="header-a"></span>');
		expect(isBackgroundPlugin("c")).toBe(false);
	});

	it("draws a plugin's badge on its button, on the map list only for a plugin that asks", () => {
		const badge = (id: string) => () => <span className={`badge-${id}`} />;
		registerPlugin(makePlugin("a", { modal: () => null, badge: badge("a"), onMapList: true }));
		registerPlugin(makePlugin("b", { sidebar: () => null, badge: badge("b") }));
		setPluginEnabled("a", true);
		setPluginEnabled("b", true);
		const editor = mount(<PluginButtons />).container;
		expect(editor.querySelector("button .badge-a")).not.toBeNull();
		expect(editor.querySelector("button .badge-b")).not.toBeNull();

		const list = mount(<PluginButtons mapList />).container;
		expect(list.querySelector("button .badge-a")).not.toBeNull();
		expect(list.querySelector("button .badge-b")).toBeNull();
	});

	it("opens a plugin's modal from its button, wherever it is, until the modal closes", () => {
		let close = () => {};
		registerPlugin(
			makePlugin("a", {
				onMapList: true,
				modal: ({ onClose }) => {
					close = onClose;
					return <div className="modal-a" />;
				},
			}),
		);
		setPluginEnabled("a", true);
		const { container } = mount(
			<>
				<PluginButtons mapList />
				<PluginModal />
			</>,
		);
		expect(container.querySelector(".modal-a")).toBeNull();
		act(() => container.querySelector("button")!.click());
		expect(container.querySelector(".modal-a")).not.toBeNull();
		act(() => close());
		expect(container.querySelector(".modal-a")).toBeNull();

		act(() => openDialog("plugin-modal", "a"));
		expect(container.querySelector(".modal-a")).not.toBeNull();
	});
});
