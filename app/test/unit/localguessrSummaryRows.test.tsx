// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { mountAsync } from "./fixtures/harness";
import type { RoundResult, Session } from "@/plugins/localguessr/game";

const loadSeenPano = vi.fn();
const viewer = { name: "tree viewer" };

vi.mock("@/lib/seen/seenRecorder", () => ({
	loadSeenPano: (...a: unknown[]) => loadSeenPano(...a),
}));
vi.mock("@/lib/hooks/usePano", () => ({ usePano: () => viewer }));
vi.mock("@/plugins/localguessr/storage", () => ({ useStartingThumbnails: () => [] }));
vi.mock("@/plugins/localguessr/TagButton", () => ({
	TagButton: () => createElement("button", { type: "button", className: "tag" }, "tag"),
}));
const replay = vi.hoisted(() => ({
	props: null as null | { highlighted: number | null; onOpenRound: (round: number) => void },
}));
vi.mock("@/plugins/localguessr/ReplayMap", () => ({
	ReplayMap: (props: typeof replay.props) => {
		replay.props = props;
		return null;
	},
}));

import { Summary } from "@/plugins/localguessr/Summary";

const result: RoundResult = {
	location: { id: 7, lat: 1, lng: 2, heading: 90, pitch: 5, zoom: 1, panoId: null },
	guess: null,
	distanceMeters: null,
	score: 0,
	truth: { admin: "", country_code: "FR" },
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

	it("keep a round highlighted on the replay map until the pointer leaves the list", async () => {
		const { container } = await mountAsync(
			createElement(Summary, {
				session: { ...session, results: [result, result] },
				onPlayAgain: () => {},
				onBack: () => {},
			}),
		);
		const list = container.querySelector<HTMLElement>(".lg-summary__rounds")!;
		const [first, second] = container.querySelectorAll<HTMLElement>(".lg-summary__row");
		const move = (from: HTMLElement, to: HTMLElement | null) =>
			act(() => {
				from.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: to }));
			});

		expect(replay.props?.highlighted).toBeNull();
		move(list, first);
		expect(replay.props?.highlighted).toBe(0);
		move(first, list);
		expect(replay.props?.highlighted).toBe(0);
		move(list, second);
		expect(replay.props?.highlighted).toBe(1);
		move(second, null);
		expect(replay.props?.highlighted).toBeNull();
	});
});

describe("replay map pins", () => {
	it("open their round through the same path as its row", async () => {
		await renderRow();
		act(() => replay.props!.onOpenRound(0));
		expect(loadSeenPano).toHaveBeenCalledWith(expect.objectContaining({ locationId: 7 }), viewer);
	});
});
