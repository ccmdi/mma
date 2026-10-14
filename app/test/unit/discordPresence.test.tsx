// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChangeEvent } from "@/bindings.gen";

const pushes = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock("@/lib/commands", () => ({
	cmd: { discordPresenceSet: pushes.set, discordPresenceClear: vi.fn() },
}));
vi.mock("@/lib/window", () => ({
	appWindow: {
		isFocused: async () => true,
		onFocusChanged: async () => () => {},
	},
}));
vi.mock("@/store/settings", () => ({ useSetting: () => "full" }));
vi.mock("@/lib/util/util", async (original) => ({
	...(await original<typeof import("@/lib/util/util")>()),
	isWeb: () => false,
}));
vi.mock("@/store/store", () => ({
	Store: { get: () => ({ map: { id: "m", name: "Map" }, locationCount: 3 }) },
}));

import { useDiscordPresence } from "@/lib/discord/presence";
import { emit } from "@/lib/events";

const change = {
	version: 1,
	derived: {} as ChangeEvent["derived"],
	added: [],
	updated: [],
	removed: [],
} satisfies ChangeEvent;

function Presence() {
	useDiscordPresence();
	return null;
}

let root: Root;

beforeEach(async () => {
	vi.useFakeTimers();
	root = createRoot(document.createElement("div"));
	await act(async () => root.render(<Presence />));
	pushes.set.mockClear();
});

afterEach(() => {
	act(() => root.unmount());
	vi.useRealTimers();
});

describe("Discord presence", () => {
	it("ignores a change that moved no locations", async () => {
		emit("store:change", change);
		await vi.advanceTimersByTimeAsync(5000);
		expect(pushes.set).not.toHaveBeenCalled();
	});

	it("pushes after a change that moved locations", async () => {
		emit("store:change", { ...change, added: [1] });
		await vi.advanceTimersByTimeAsync(5000);
		expect(pushes.set).toHaveBeenCalledTimes(1);
	});
});
