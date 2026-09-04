import { memo, useCallback } from "react";
import { useSetting } from "@/store/settings";
import { dateFmt } from "@/lib/util/format";
import { civilToDate } from "@/lib/util/date";
import type { Pano } from "@/types";
import { useCameraType, type FullCameraType } from "./useCameraType";
import { usePanoViewer, usePanoDates, viewerPosition } from "./PanoViewerContext";
import { useMapState } from "@/store/useMapStore";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import { useTimezone } from "@/lib/util/timezone";
import { NSelect } from "@/components/primitives/NSelect";
import { getLocale, t } from "@/lib/i18n";

/** "Jun 2024" for a pano's civil capture date, "" when there is none. */
function monthLabel(civil: string | undefined): string {
	const d = civil ? civilToDate(civil) : null;
	return d ? dateFmt.format(d) : "";
}

function PanoBadge({ cameraType }: { cameraType: FullCameraType | null }) {
	switch (cameraType) {
		case "unofficial":
			return <span className="pano-option__badge badge badge--unofficial">{t("unofficial")}</span>;
		case "gen1":
			return <span className="pano-option__badge badge badge--gen1">{t("Gen1")}</span>;
		case "gen2":
			return <span className="pano-option__badge badge badge--gen2">{t("Gen2/3")}</span>;
		case "gen4":
			return <span className="pano-option__badge badge badge--gen4">{t("Gen4")}</span>;
		case "badcam":
			return <span className="pano-option__badge badge badge--badcam">{t("Badcam")}</span>;
		case "tripod":
			return <span className="pano-option__badge badge badge--tripod">{t("Tripod")}</span>;
		case "trekker":
			return <span className="pano-option__badge badge badge--rb">{t("Trekker")}</span>;
		default:
			return null;
	}
}

function PanoOption({ pano, date }: Pano["time"][number]) {
	const showBadges = useSetting("showCameraBadges");
	const cameraType = useCameraType(pano);
	return (
		<option value={pano} className="pano-option">
			<span>{monthLabel(date)}</span>
			{(cameraType === "unofficial" || showBadges) && <PanoBadge cameraType={cameraType} />}
		</option>
	);
}

export const PanoDatePicker = memo(function PanoDatePicker({
	onChange,
}: {
	onChange: (panoId: string | null) => void;
}) {
	const { draft, meta, enriching } = usePanoViewer();
	const exactTs = (draft?.extra?.datetime as number | undefined) ?? null;
	const location = useMapState((s) => s.activeLocation);
	const enrichFields = useMapState((s) => s.map?.settings.enrichFields ?? null);
	// An exact date is on its way: the field is on, and what the draft holds is not this pano's yet.
	const resolvingExact =
		enriching &&
		isFieldEnabled(enrichFields, "datetime") &&
		(exactTs == null || draft?.panoId !== location?.panoId);

	const { defaultEntry, sorted, currentEntry, isDefault, displayDate, triggerPanoId } =
		usePanoDates();
	const displayLabel = displayDate
		? isDefault
			? t("Default ({date})", { date: dateFmt.format(displayDate) })
			: dateFmt.format(displayDate)
		: "";

	const handleValueChange = useCallback(
		(value: string) => {
			if (value === "default") onChange(null);
			else onChange(value);
		},
		[onChange],
	);

	const showBadges = useSetting("showCameraBadges");
	const exactDateFormat = useSetting("exactDateFormat");
	const dateTimezone = useSetting("dateTimezone");
	const { lat, lng } = viewerPosition(draft, location);
	const resolvedTz = useTimezone(lat, lng, dateTimezone === "location");
	const triggerCameraType = useCameraType(triggerPanoId, meta);
	const tzOption = dateTimezone === "utc" ? "UTC" : (resolvedTz ?? undefined);
	const exactLabel = exactTs
		? exactDateFormat === "datetime"
			? new Date(exactTs * 1000).toLocaleString(getLocale(), {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					timeZone: tzOption,
				})
			: new Date(exactTs * 1000).toLocaleDateString(getLocale(), {
					year: "numeric",
					month: "short",
					day: "numeric",
					timeZone: tzOption,
				})
		: null;

	if (sorted.length === 0) {
		return (
			<NSelect className="pano-date-select" disabled>
				<button type="button" className="pano-date-select__trigger">
					<span className="pano-value">{t("No dates")}</span>
				</button>
			</NSelect>
		);
	}

	return (
		<NSelect
			className="pano-date-select"
			data-side="top"
			value={isDefault ? "default" : (currentEntry?.pano ?? "default")}
			onChange={(e) => {
				const select = e.currentTarget;
				handleValueChange(e.target.value);
				requestAnimationFrame(() => select.blur());
			}}
		>
			<button type="button" className="pano-date-select__trigger">
				<span className="pano-value">
					{resolvingExact ? displayLabel : (exactLabel ?? displayLabel)}
					<span style={{ display: "flex", gap: 4, alignItems: "center" }}>
						{resolvingExact && <span className="badge">...</span>}
						{(triggerCameraType === "unofficial" || showBadges) && (
							<PanoBadge cameraType={triggerCameraType} />
						)}
					</span>
					<span className="badge badge--number">{sorted.length}</span>
				</span>
			</button>
			<optgroup label={t("Specific Panorama")}>
				{sorted.map((d) => (
					<PanoOption key={d.pano} {...d} />
				))}
			</optgroup>
			<optgroup label={t("Default / auto-updating")}>
				<option value="default" className="pano-option">
					<span>
						{t("Default")}
						{monthLabel(defaultEntry?.date ?? sorted[sorted.length - 1]?.date)
							? ` (${monthLabel(defaultEntry?.date ?? sorted[sorted.length - 1]?.date)})`
							: ""}
					</span>
				</option>
			</optgroup>
		</NSelect>
	);
});
