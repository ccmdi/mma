// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, useEffect, useRef, useState } from "react";
import { mount } from "./fixtures/harness";

const h = vi.hoisted(() => ({ mounted: [] as HTMLElement[] }));

vi.mock("@/lib/hooks/usePano", () => {
	const pano = {
		configure: () => {},
		showCrosshair: () => () => {},
		mount: (el: HTMLElement) => {
			h.mounted.push(el);
			return () => {
				h.mounted = h.mounted.filter((m) => m !== el);
			};
		},
	};
	return { usePano: () => pano, usePanoEvent: () => {} };
});
vi.mock("@/store/settings", () => ({
	useSettings: () => ({}),
	getSettings: () => ({}),
	panoDisplayOptions: () => ({}),
}));
vi.mock("@/components/editor/location/PanoControls", () => ({ sendHideCar: () => {} }));

import { usePanoDisplay } from "@/components/editor/location/usePanoDisplay";

let toggle!: (shown: boolean) => void;

function Viewer() {
	const containerRef = useRef<HTMLDivElement>(null);
	const panoMount = usePanoDisplay(containerRef);
	const [shown, setShown] = useState(true);
	useEffect(() => {
		toggle = setShown;
	}, []);
	return shown ? <div data-testid="pano" ref={panoMount} /> : null;
}

describe("the pano container", () => {
	it("takes the pano with it when it unmounts and mounts again", () => {
		const { container } = mount(<Viewer />);
		const first = container.querySelector("[data-testid=pano]");
		expect(h.mounted).toEqual([first]);

		act(() => toggle(false));
		expect(h.mounted).toEqual([]);

		act(() => toggle(true));
		const second = container.querySelector("[data-testid=pano]");
		expect(second).not.toBe(first);
		expect(h.mounted).toEqual([second]);
	});
});
