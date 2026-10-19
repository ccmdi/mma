// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { mount } from "./fixtures/harness";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { emit, track } = await import("@/lib/events");
const { registerCommand } = await import("@/store/commands");
const { setSetting } = await import("@/store/settings");
const { PinnedToolbar } = await import("@/components/editor/map/PinnedToolbar");

describe("pinned toolbar", () => {
	it("follows whatever state a pinned command's enabled check reads", () => {
		let on = false;
		registerCommand({
			id: "test-tracked-enabled",
			label: "Tracked enabled",
			icon: "M0 0",
			group: "Selections",
			execute: () => {},
			enabled: () => {
				track("scene:changed");
				return on;
			},
		});
		setSetting("pinnedCommands", ["test-tracked-enabled"]);
		const { container } = mount(<PinnedToolbar panels={{}} />);
		const button = () => container.querySelector('[data-qa="test-tracked-enabled"]')!;

		expect(button().classList.contains("is-disabled")).toBe(true);
		on = true;
		act(() => emit("scene:changed"));
		expect(button().classList.contains("is-disabled")).toBe(false);
	});
});
