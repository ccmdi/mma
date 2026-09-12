// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { mountAsync } from "./fixtures/harness";
import type { RoundResult, Session } from "@/plugins/localguessr/game";

const loadSeenPano = vi.fn();
const viewer = { name: "tree viewer" };

vi.mock("@/lib/seen/seen", () => ({
	loadSeenPano: (...a: unknown[]) => loadSeenPano(...a),
}));
vi.mock("@/lib/hooks/usePano", () => ({ usePano: () => viewer }));
vi.mock("@/plugins/localguessr/storage", () => ({ roundThumbnails: async () => new Map() }));
vi.mock("@/plugins/localguessr/TagButton", () => ({
	TagButton: () => createElement("button", { type: "button", className: "tag" }, "tag"),
}));

import { Summary } from "@/plugins/localguessr/Summary";

const result: RoundResult = {
	location: { id: 7, lat: 1, lng: 2, heading: 90, pitch: 5, zoom: 1, panoId: null },
	guess: null,
	distanceMeters: null,
	score: 0,
	truth: { city: "", admin: "", country_code: "FR" },
	guessed: null,
	streakHit: null,
	elapsedMs: 0,
};

const session: Session = {
	config: {
		movementMode: "moving",
		roundMode: "classic",
		rounds: 1,
		timerMode: "off",
		timeLimit: 60,
		streakMode: "off",
	},
	mapId: "m",
	mapName: "Map",
	maxError: 1,
	results: [result],
	totalScore: 0,
	bestStreak: 0,
	startedAt: 0,
	finishedAt: 0,
};

async function renderRow() {
	const { container } = await mountAsync(
		createElement(Summary, { session, onPlayAgain: () => {}, onBack: () => {} }),
	);
	return container.querySelector<HTMLElement>(".lg-summary__row")!;
}

beforeEach(() => loadSeenPano.mockClear());

describe("breakdown rows", () => {
	it("open their round through the seen pano path on the tree's viewer", async () => {
		const row = await renderRow();
		act(() => row.click());
		expect(loadSeenPano).toHaveBeenCalledWith(
			{
				locationId: 7,
				panoId: null,
				lat: 1,
				lng: 2,
				heading: 90,
				pitch: 5,
				zoom: 1,
				countryCode: "FR",
			},
			viewer,
		);
	});

	it("open on Enter", async () => {
		const row = await renderRow();
		act(() => {
			row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(loadSeenPano).toHaveBeenCalledOnce();
	});

	it("leave their buttons to themselves", async () => {
		const row = await renderRow();
		act(() => row.querySelector<HTMLElement>("button.tag")!.click());
		expect(loadSeenPano).not.toHaveBeenCalled();
	});
});
