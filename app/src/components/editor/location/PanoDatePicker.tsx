import { memo, useCallback } from "react";
import { Store } from "@/store/store";
import { Editor } from "@/store/editor";
import { useSetting } from "@/store/settings";
import { dateFmt } from "@/lib/util/format";
import { civilToDate } from "@/lib/util/date";
import type { Pano } from "@/bindings.gen";
import { useCameraType, type FullCameraType } from "./useCameraType";
import { usePanoViewer } from "./PanoViewerContext";
import { panoDates } from "./panoDate";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import { fieldValueLabel, getFieldDef } from "@/lib/data/fieldDefRegistry";
import { useTimezone } from "@/lib/util/timezone";
import { NSelect } from "@/components/primitives/NSelect";
import { IconButton } from "@/components/primitives/IconButton";
import { mdiRefresh } from "@mdi/js";
import { getLocale, t } from "@/lib/i18n";

/** "Jun 2024" for a pano's civil capture date, "" when there is none. */
function monthLabel(civil: string | undefined): string {
	const d = civil ? civilToDate(civil) : null;
	return d ? dateFmt.format(d) : "";
}

const BADGE_CLASS: Record<Exclude<FullCameraType, "unofficial">, string> = {
	gen1: "gen1",
	gen2: "gen2",
	gen4: "gen4",
	badcam: "badcam",
	tripod: "tripod",
	trekker: "rb",
};

function PanoBadge({ cameraType }: { cameraType: FullCameraType | null }) {
	if (cameraType === null) return null;
	if (cameraType === "unofficial") {
		return <span className="pano-option__badge badge badge--unofficial">{t("unofficial")}</span>;
	}
	return (
		<span className={`pano-option__badge badge badge--${BADGE_CLASS[cameraType]}`}>
			{fieldValueLabel(getFieldDef("cameraType"), cameraType)}
		</span>
	);
}

function PanoOption({ panoId, date }: Pano["time"][number]) {
	const showBadges = useSetting("showCameraBadges");
	const cameraType = useCameraType(panoId);
	return (
		<option value={panoId} className="pano-option">
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
	const { onScreen } = usePanoViewer();
	const shown = onScreen.ok();
	const writing = Editor.useWriting();
	const entries = shown?.timeline ?? [];
	const location = Editor.use((s) => s.open?.location ?? null);
	const exactTs = (location?.extra?.datetime as number | undefined) ?? null;
	const enrichFields = Store.use((s) => s.map?.settings.enrichFields ?? null);
	// An exact date is on its way: the field is on and the location has no date yet.
	const resolvingExact = writing && isFieldEnabled(enrichFields, "datetime") && exactTs == null;

	const { defaultEntry, currentEntry, isDefault } = panoDates(shown, location);
	const displayDate = currentEntry ? civilToDate(currentEntry.date) : null;
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
	const { lat, lng } = Editor.usePosition();
	const resolvedTz = useTimezone(lat, lng, dateTimezone === "location");
	const triggerCameraType = useCameraType(
		currentEntry?.panoId ?? shown?.currentPano?.id ?? null,
		shown?.currentPano,
	);
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

	if (onScreen.status === "error") {
		return (
			<span className="pano-date-failed">
				<NSelect className="pano-date-select" disabled>
					<button type="button" className="pano-date-select__trigger">
						<span className="pano-value">{t("Couldn't load dates")}</span>
					</button>
				</NSelect>
				<IconButton
					icon={mdiRefresh}
					size={18}
					label={t("Retry")}
					onClick={() => void onScreen.rerun()}
				/>
			</span>
		);
	}
	if (entries.length === 0) {
		return (
			<NSelect className="pano-date-select" disabled>
				<button type="button" className="pano-date-select__trigger">
					<span className="pano-value">
						{onScreen.status === "loading" ? t("Loading dates...") : t("No dates")}
					</span>
				</button>
			</NSelect>
		);
	}

	return (
		<NSelect
			className="pano-date-select"
			data-side="top"
			value={isDefault ? "default" : (currentEntry?.panoId ?? "default")}
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
					<span className="badge badge--number">{entries.length}</span>
				</span>
			</button>
			<optgroup label={t("Specific Panorama")}>
				{entries.map((d) => (
					<PanoOption key={d.panoId} {...d} />
				))}
			</optgroup>
			<optgroup label={t("Default / auto-updating")}>
				<option value="default" className="pano-option">
					<span>
						{t("Default")}
						{monthLabel(defaultEntry?.date ?? entries.at(-1)?.date)
							? ` (${monthLabel(defaultEntry?.date ?? entries.at(-1)?.date)})`
							: ""}
					</span>
				</option>
			</optgroup>
		</NSelect>
	);
});
