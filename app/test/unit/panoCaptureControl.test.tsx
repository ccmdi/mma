// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	snapshot: vi.fn(),
	render: vi.fn(),
	toBlob: vi.fn(),
	download: vi.fn(),
	copyImage: vi.fn(),
	toast: vi.fn(),
	settings: {
		showScreenshotButton: true,
		showFullscreenButton: false,
		showJumpButtons: false,
		showCompass: false,
		showCompassTape: false,
		showZoom: false,
		showReturnToSpawn: false,
		showMapLinks: false,
		showCoordinateDisplay: false,
		showPanoMetadata: false,
		defaultMovementMode: "moving",
	},
}));

vi.mock("@/lib/sv/panoCapture", () => ({
	snapshotPanoView: mocks.snapshot,
	renderPanoView: mocks.render,
	canvasToBlob: mocks.toBlob,
}));
vi.mock("@/lib/util/util", () => ({
	downloadBlob: mocks.download,
	copyImageToClipboard: mocks.copyImage,
	schemeBase: () => "",
}));
vi.mock("@/lib/util/toast", () => ({ toast: mocks.toast }));
vi.mock("@/lib/util/log", () => ({
	log: { warn: vi.fn() },
	fireAndForget: (p: Promise<unknown> | undefined) => void p?.catch(() => {}),
}));
vi.mock("@/store/settings", () => ({ useSettings: () => mocks.settings }));
vi.mock("@/lib/util/hotkeys", () => ({ useBinding: () => "f" }));
vi.mock("@/lib/hooks/useHotkey", () => ({ useHotkeyRef: () => ({ current: null }) }));
vi.mock("@/lib/hooks/usePanoEvent", () => ({ usePanoEvent: vi.fn() }));
vi.mock("@/lib/sv/opensv", () => ({ google: { maps: {} } }));
vi.mock("@/components/primitives/Tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import { PanoControls } from "@/components/editor/location/PanoControls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const panorama = {} as google.maps.StreetViewPanorama;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderControls() {
	act(() =>
		root.render(
			<PanoControls
				panorama={panorama}
				isFullscreen={false}
				onFullscreen={vi.fn()}
				onReturnToSpawn={vi.fn()}
			/>,
		),
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.snapshot
		.mockReset()
		.mockReturnValue({ panoId: "pano-id", pov: { heading: 0, pitch: 0 }, zoom: 1 });
	mocks.render.mockReset();
	mocks.toBlob.mockReset();
	mocks.download.mockReset();
	mocks.copyImage.mockReset().mockResolvedValue(true);
	mocks.toast.mockReset();
	mocks.settings.showScreenshotButton = true;
	mocks.settings.showFullscreenButton = false;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("PanoControls screenshot button", () => {
	it("has an independent visibility setting", () => {
		renderControls();
		const screenshot = container.querySelector("[data-qa='pano-screenshot']")!;
		expect(screenshot).not.toBeNull();
		expect(screenshot.getAttribute("aria-label")).toBe("Copy screenshot to clipboard");
		expect(screenshot.closest(".map-control")?.querySelectorAll("button")).toHaveLength(1);

		mocks.settings.showScreenshotButton = false;
		renderControls();
		expect(container.querySelector("[data-qa='pano-screenshot']")).toBeNull();
	});

	it("disables during capture and copies the completed PNG once", async () => {
		let finish!: (canvas: HTMLCanvasElement) => void;
		mocks.render.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const blob = new Blob(["png"], { type: "image/png" });
		mocks.toBlob.mockResolvedValue(blob);
		renderControls();
		const button = container.querySelector<HTMLButtonElement>("[data-qa='pano-screenshot']")!;

		act(() => button.click());
		expect(button.disabled).toBe(true);
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(mocks.render).toHaveBeenCalledWith(
			{ panoId: "pano-id", pov: { heading: 0, pitch: 0 }, zoom: 1 },
			1920,
			1080,
		);

		await act(async () => finish(document.createElement("canvas")));
		expect(mocks.copyImage).toHaveBeenCalledOnce();
		expect(mocks.copyImage).toHaveBeenCalledWith(blob);
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("Screenshot copied");

		act(() => vi.advanceTimersByTime(500));
		expect(button.disabled).toBe(false);
	});

	it("downloads instead of copying on shift-click", async () => {
		const blob = new Blob(["png"], { type: "image/png" });
		mocks.render.mockResolvedValue(document.createElement("canvas"));
		mocks.toBlob.mockResolvedValue(blob);
		renderControls();
		const button = container.querySelector<HTMLButtonElement>("[data-qa='pano-screenshot']")!;

		await act(async () =>
			button.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })),
		);
		expect(mocks.copyImage).not.toHaveBeenCalled();
		expect(mocks.download).toHaveBeenCalledWith(
			blob,
			expect.stringMatching(/^pano-id_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/),
		);
		expect(mocks.toast).toHaveBeenCalledWith("Screenshot downloaded");
	});

	it("falls back to downloading when the clipboard refuses the image", async () => {
		const blob = new Blob(["png"], { type: "image/png" });
		mocks.render.mockResolvedValue(document.createElement("canvas"));
		mocks.toBlob.mockResolvedValue(blob);
		mocks.copyImage.mockResolvedValue(false);
		renderControls();
		const button = container.querySelector<HTMLButtonElement>("[data-qa='pano-screenshot']")!;

		await act(async () => button.click());
		expect(mocks.download).toHaveBeenCalledOnce();
		expect(mocks.toast).toHaveBeenCalledWith("Clipboard unavailable, downloaded instead");
	});

	it("toasts and re-enables when capture fails", async () => {
		mocks.render.mockRejectedValue(new Error("no canvas"));
		renderControls();
		const button = container.querySelector<HTMLButtonElement>("[data-qa='pano-screenshot']")!;

		await act(async () => button.click());
		expect(mocks.toast).toHaveBeenCalledWith("Screenshot failed");
		expect(mocks.download).not.toHaveBeenCalled();
		expect(button.disabled).toBe(false);
	});
});
