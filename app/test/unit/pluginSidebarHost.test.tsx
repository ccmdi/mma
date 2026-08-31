// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let workArea = "plugin";
let activePluginId: string | null = null;

vi.mock("@/store/useMapStore", () => ({
	useMapState: (sel: (s: { workArea: string; activePluginId: string | null }) => unknown) =>
		sel({ workArea, activePluginId }),
	exitPluginMode: vi.fn(),
}));

import { PluginSidebarHost } from "@/components/editor/PluginSidebarHost";
import { registerPlugin, unregisterPlugin, setPluginEnabled } from "@/plugins/registry";

const normalPlugin = {
	id: "normal-p",
	name: "Normal",
	icon: "i",
	activate: vi.fn(),
	sidebar: () => <div className="normal-sidebar" />,
};

const keepAlivePlugin = {
	id: "keep-p",
	name: "Keep",
	icon: "i",
	activate: vi.fn(),
	keepAlive: true,
	sidebar: () => <div className="keep-sidebar" />,
};

let container: HTMLDivElement;
let root: Root;

function render() {
	act(() => root.render(<PluginSidebarHost />));
}

beforeEach(() => {
	registerPlugin(normalPlugin);
	registerPlugin(keepAlivePlugin);
	setPluginEnabled(normalPlugin.id, true);
	setPluginEnabled(keepAlivePlugin.id, true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	unregisterPlugin(normalPlugin.id);
	unregisterPlugin(keepAlivePlugin.id);
	localStorage.clear();
});

describe("PluginSidebarHost work-area gating", () => {
	it("renders the active plugin sidebar in plugin mode", () => {
		workArea = "plugin";
		activePluginId = normalPlugin.id;
		render();
		expect(container.querySelector(".normal-sidebar")).not.toBeNull();
	});

	it("does not render the sidebar when a location is active but the plugin stays open", () => {
		workArea = "plugin";
		activePluginId = normalPlugin.id;
		render();
		workArea = "location";
		render();
		expect(container.querySelector(".normal-sidebar")).toBeNull();
	});

	it("keeps a keepAlive sidebar mounted but hidden outside plugin mode", () => {
		workArea = "plugin";
		activePluginId = keepAlivePlugin.id;
		render();
		const sidebar = container.querySelector(".keep-sidebar");
		expect(sidebar).not.toBeNull();
		expect((sidebar!.parentElement as HTMLElement).style.display).toBe("contents");

		workArea = "location";
		render();
		const hidden = container.querySelector(".keep-sidebar");
		expect(hidden).not.toBeNull();
		expect((hidden!.parentElement as HTMLElement).style.display).toBe("none");

		workArea = "plugin";
		render();
		const shown = container.querySelector(".keep-sidebar");
		expect((shown!.parentElement as HTMLElement).style.display).toBe("contents");
	});
});
