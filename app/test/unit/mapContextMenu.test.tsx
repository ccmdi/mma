// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import { mount } from "./fixtures/harness";

vi.mock("@/store/location", () => ({ Location: {} }));
vi.mock("@/store/tag", () => ({ Tag: {} }));
vi.mock("@/lib/map/useCountrySelect", () => ({ selectBorderAt: vi.fn() }));
vi.mock("@/lib/map/useDeletePolygon", () => ({
	polygonsAt: vi.fn(async () => []),
	deletePolygonsAt: vi.fn(),
}));
vi.mock("@/store/dialogBus", () => ({ openDialog: vi.fn() }));
vi.mock("@/lib/sv/streetView", async (original) => ({
	StreetView: {
		...(await original<typeof import("@/lib/sv/streetView")>()).StreetView,
		mapsUrl: vi.fn(),
		appendLinkTags: vi.fn(),
		copyLink: vi.fn(),
		download: vi.fn(),
	},
}));
vi.mock("@/lib/util/toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/util/log", () => ({ log: { error: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({ t: (s: string) => s, msg: (s: string) => s }));
vi.mock("@/lib/commands", () => ({ cmd: {} }));

import { MapContextMenuContent } from "@/components/editor/map/MapContextMenu";
import { MapMenu } from "@/lib/map/mapMenu";
import { MapHost } from "@/lib/map/mapHost";
import { Measure } from "@/lib/map/measure";
import { polygonsAt } from "@/lib/map/useDeletePolygon";
import { selectBorderAt } from "@/lib/map/useCountrySelect";
import type { LatLng } from "@/types";

const host = {
	container: document.createElement("div"),
	setDraggable: vi.fn(),
	setCursor: vi.fn(),
} as unknown as MapHost;

function MeasureInteraction() {
	Measure.useInteraction(host);
	return null;
}

function mountMenu() {
	const mounted = mount(
		<ContextMenu.Root>
			<ContextMenu.Trigger data-testid="map">Map</ContextMenu.Trigger>
			<MapContextMenuContent />
			<MeasureInteraction />
		</ContextMenu.Root>,
	);
	return async (at: LatLng) => {
		await act(async () => {
			// Match the map handler: save the geographic target, then open the menu
			// at client pixels. Opening must not require a parent React rerender.
			MapMenu.openAt(at);
			mounted.container
				.querySelector('[data-testid="map"]')!
				.dispatchEvent(
					new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 400, clientY: 200 }),
				);
		});
	};
}

async function choose(label: string) {
	const item = [...document.querySelectorAll('[role="menuitem"]')].find(
		(el) => el.textContent === label,
	);
	expect(item).toBeDefined();
	await act(async () => {
		item!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
	});
}

afterEach(() => {
	act(() => {
		Measure.end();
		Measure.setAnchor(null);
	});
	vi.clearAllMocks();
});

const A = { lat: 48.85, lng: 2.35 };
const B = { lat: 35.68, lng: 139.76 };

describe("map context menu measurement origin", () => {
	it("starts at the fresh right-click and the first map click adds only point two", async () => {
		MapMenu.openAt({ lat: 0, lng: 0 });
		const open = mountMenu();
		await open(A);
		await choose("Start measurement");
		expect(Measure.points()).toEqual([[A.lng, A.lat]]);
		act(() => {
			expect(MapHost.tryInterceptClick(A.lat + 0.001, A.lng + 0.001)).toBe(true);
		});
		expect(Measure.points()).toEqual([
			[A.lng, A.lat],
			[A.lng + 0.001, A.lat + 0.001],
		]);
	});

	it("uses the new right-click when reopening after an earlier measurement", async () => {
		MapMenu.openAt(A);
		const open = mountMenu();
		await open(A);
		await choose("Start measurement");
		act(() => Measure.end());
		await open(B);
		await choose("Start measurement");
		expect(Measure.points()).toEqual([[B.lng, B.lat]]);
	});

	it("also refreshes coordinate actions and polygon hit tests on reopen", async () => {
		MapMenu.openAt(A);
		const open = mountMenu();
		await open(A);
		await choose("Select this country");
		await open(B);
		expect(polygonsAt).toHaveBeenLastCalledWith(B.lat, B.lng);
		await choose("Select this country");
		expect(selectBorderAt).toHaveBeenLastCalledWith(B.lat, B.lng, false);
	});
});
