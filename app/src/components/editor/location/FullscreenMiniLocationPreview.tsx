/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { mdiMinus, mdiPlus } from "@mdi/js";
import { useSetting, setSetting } from "@/store/settings";
import { range, clamp } from "@/types/util";
import { useHoverExpand } from "@/lib/hooks/useHoverExpand";
import { t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";

const PREVIEW_SCALE = range([0.5, 2]);
const PREVIEW_SCALE_STEP = 0.5;
const PREVIEW_BASE_W = 480;
const PREVIEW_BASE_H = 270;
const PREVIEW_COLLAPSED_W = 250;
const PREVIEW_CLOSE_DELAY = 500;

/** Portal target for the chip */
export const ChipHostContext = createContext<HTMLElement | null>(null);

/** Floating chip chrome for fullscreen-map mode: hover-expand + scale buttons. */
export function FullscreenMiniLocationPreview({ children }: { children: ReactNode }) {
	const host = useContext(ChipHostContext);
	const scale = useSetting("fullscreenMiniLocationScale");
	const boxRef = useRef<HTMLDivElement>(null);
	const { expanded, hoverProps } = useHoverExpand(boxRef, PREVIEW_CLOSE_DELAY);
	const width = Math.round(PREVIEW_BASE_W * scale);

	const prevWidth = useRef(width);
	useLayoutEffect(() => {
		const el = boxRef.current;
		const from = prevWidth.current;
		prevWidth.current = width;
		if (!el || from === width) return;
		el.style.transition = "none";
		el.style.setProperty("--fs-mini-flip", String(from / width));
		void el.offsetWidth;
		el.style.transition = "";
		el.style.setProperty("--fs-mini-flip", "1");
	}, [width]);

	const setScale = (next: number) => {
		const clamped = clamp(next, PREVIEW_SCALE);
		setSetting("fullscreenMiniLocationScale", Math.round(clamped * 100) / 100);
	};

	if (!host) return null;

	const sizeVars = {
		"--fs-mini-loc-w": `${width}px`,
		"--fs-mini-loc-h": `${Math.round(PREVIEW_BASE_H * scale)}px`,
		// Never above 1: at the smallest scale the expanded box is already
		// narrower than the collapsed target, and scaling up would blur it.
		"--fs-mini-k": Math.min(1, PREVIEW_COLLAPSED_W / width),
	} as React.CSSProperties;

	return createPortal(
		<div
			ref={boxRef}
			className={`fullscreen-mini-location${expanded ? " is-expanded" : ""}`}
			style={sizeVars}
			{...hoverProps}
		>
			{children}
			<div className="fullscreen-mini-location__size">
				<IconButton
					className="fullscreen-mini-location__size-btn"
					icon={mdiMinus}
					size={16}
					label={t("Smaller location preview")}
					tooltip={false}
					overlay
					disabled={scale <= PREVIEW_SCALE.min}
					onClick={() => setScale(scale - PREVIEW_SCALE_STEP)}
				/>
				<IconButton
					className="fullscreen-mini-location__size-btn"
					icon={mdiPlus}
					size={16}
					label={t("Larger location preview")}
					tooltip={false}
					overlay
					disabled={scale >= PREVIEW_SCALE.max}
					onClick={() => setScale(scale + PREVIEW_SCALE_STEP)}
				/>
			</div>
		</div>,
		host,
	);
}
