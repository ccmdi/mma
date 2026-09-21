import { mdiMinus, mdiPlus } from "@mdi/js";
import { useSetting, setSetting } from "@/store/settings";
import { clamp, type Range } from "@/types/util";
import { IconButton } from "@/components/primitives/IconButton";

type ScaleSetting = "fullscreenMinimapScale" | "fullscreenMiniLocationScale";

/** Smaller/larger buttons that step a floating panel's scale setting within `range`.
 *  Shown while the panel is expanded. */
export function ScaleStepper({
	setting,
	range,
	step,
	labels,
}: {
	setting: ScaleSetting;
	range: Range;
	step: number;
	labels: { smaller: string; larger: string };
}) {
	const scale = useSetting(setting);
	const setScale = (next: number) =>
		setSetting(setting, Math.round(clamp(next, range) * 100) / 100);

	return (
		<div className="scale-stepper">
			<IconButton
				className="scale-stepper__btn"
				icon={mdiMinus}
				size={16}
				label={labels.smaller}
				tooltip={false}
				overlay
				disabled={scale <= range.min}
				onClick={() => setScale(scale - step)}
			/>
			<IconButton
				className="scale-stepper__btn"
				icon={mdiPlus}
				size={16}
				label={labels.larger}
				tooltip={false}
				overlay
				disabled={scale >= range.max}
				onClick={() => setScale(scale + step)}
			/>
		</div>
	);
}
