import { useState } from "react";
import { Popover } from "@base-ui-components/react/popover";
import { RgbColorPicker } from "react-colorful";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import { rgbCss, type RGB } from "@/lib/util/color";
import { t } from "@/lib/i18n";

/** The picker surface itself, debounced. Sole place the `{r,g,b}` shape react-colorful
 *  wants exists -- every caller in the app passes and receives an [r, g, b] tuple. */
export function RgbPicker({ color, onChange }: { color: RGB; onChange: (color: RGB) => void }) {
	const debounced = useDebouncedCallback(onChange, 60, { flush: true });
	const [r, g, b] = color;
	return <RgbColorPicker color={{ r, g, b }} onChange={(c) => debounced([c.r, c.g, c.b])} />;
}

/** A color swatch that opens the picker in a popover on click. */
export function ColorPicker({
	color,
	onChange,
	ariaLabel = t("Pick color"),
}: {
	color: RGB;
	onChange: (color: RGB) => void;
	ariaLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				className="color-picker__swatch"
				aria-label={ariaLabel}
				style={{ backgroundColor: rgbCss(color) }}
			/>
			<Popover.Portal>
				<Popover.Positioner
					className="picker-positioner"
					sideOffset={4}
					align="start"
					collisionPadding={8}
				>
					<Popover.Popup className="color-picker__popover">
						<RgbPicker color={color} onChange={onChange} />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
