import { useIsMeasuring, useMeasureLength, endMeasure } from "@/lib/sv/measure";
import { computeScore, useScoreMaxError } from "@/lib/geo/scoring";
import { formatDistance } from "@/lib/util/format";
import { useSetting } from "@/store/settings";
import { t } from "@/lib/i18n";
import { Button } from "./Button";

export function MeasurementBar() {
	const isMeasuring = useIsMeasuring();
	const length = useMeasureLength();
	const maxError = useScoreMaxError();
	// Read so a units change re-renders the live readout.
	useSetting("units");

	if (!isMeasuring) return null;

	return (
		<div
			className="embed-controls__control"
			style={{ bottom: "40px", left: "50%", transform: "translateX(-50%)" }}
		>
			<div className="map-control measurement-control">
				<p className="measurement-control__measurements">
					{t("Distance:")} {formatDistance(length)}
					<br />
					{t("Score:")} {computeScore(length, maxError)}
				</p>
				<Button onClick={endMeasure}>{t("End")}</Button>
			</div>
		</div>
	);
}
