import type { GeneratorSettings } from "../engine/types";
import { DatePicker } from "@/components/primitives/DatePicker";
import { NSelect } from "@/components/primitives/NSelect";
import { Radio } from "@/components/primitives/Radio";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Section, SegmentedControl } from "@/components/primitives/Sidebar";
import { t } from "@/lib/i18n";
import { TextInput } from "@/components/primitives/TextInput";
import { distanceUnit } from "@/lib/util/format";
import { useSetting } from "@/store/settings";

function Check({
	label,
	checked,
	onChange,
	title,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	title?: string;
}) {
	return (
		<label className="generator-settings__check" title={title}>
			<Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />
			{label}
		</label>
	);
}

function NumberInput({
	label,
	value,
	onChange,
	min,
	max,
	step,
	indent,
}: {
	label: string;
	value: number;
	onChange: (v: number) => void;
	min?: number;
	max?: number;
	step?: number;
	indent?: boolean;
}) {
	return (
		<label className={`generator-settings__number ${indent ? "generator-settings__indent" : ""}`}>
			{label}
			<TextInput
				type="number"
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				min={min}
				max={max}
				step={step}
			/>
		</label>
	);
}

/** A metric-stored distance field shown in the user's units. `base` is the unit the setting
 *  is stored in, never what the field displays. */
function DistanceInput({
	label,
	base,
	value,
	onChange,
	min,
	max,
	indent,
}: {
	label?: string;
	base: "m" | "km";
	value: number;
	onChange: (v: number) => void;
	min?: number;
	max?: number;
	indent?: boolean;
}) {
	useSetting("units");
	const unit = distanceUnit(base);
	return (
		<NumberInput
			label={label ? `${label} (${unit.label})` : unit.label}
			value={unit.toDisplay(value)}
			onChange={(v) => onChange(unit.fromDisplay(v))}
			min={min != null ? unit.toDisplay(min) : undefined}
			max={max != null ? unit.toDisplay(max) : undefined}
			indent={indent}
		/>
	);
}

function RadioGroup({
	name,
	options,
	value,
	onChange,
	indent,
}: {
	name: string;
	options: { value: string; label: string }[];
	value: string;
	onChange: (v: string) => void;
	indent?: boolean;
}) {
	return (
		<div className={`generator-settings__radios ${indent ? "generator-settings__indent" : ""}`}>
			{options.map((opt) => (
				<label key={opt.value} className="generator-settings__radio">
					<Radio name={name} checked={value === opt.value} onChange={() => onChange(opt.value)} />
					{opt.label}
				</label>
			))}
		</div>
	);
}

export function SettingsPanel({
	settings,
	onChange,
}: {
	settings: GeneratorSettings;
	onChange: (patch: Partial<GeneratorSettings>) => void;
}) {
	const set = <K extends keyof GeneratorSettings>(key: K, val: GeneratorSettings[K]) =>
		onChange({ [key]: val });

	return (
		<div className="generator-settings">
			<Section title={t("Coverage settings")}>
				{!settings.rejectOfficial && (
					<>
						<Check
							label={t("Reject unofficial")}
							checked={settings.rejectUnofficial}
							onChange={(v) => set("rejectUnofficial", v)}
						/>
						<Check
							label={t("Reject gen 1")}
							checked={settings.rejectGen1}
							onChange={(v) => set("rejectGen1", v)}
						/>
					</>
				)}
				{settings.rejectUnofficial && !settings.rejectOfficial && !settings.rejectGen1 && (
					<>
						<Check
							label={t("Find generation")}
							checked={settings.findGeneration}
							onChange={(v) => set("findGeneration", v)}
						/>
						{settings.findGeneration && (
							<div className="generator-settings__indent">
								<SegmentedControl
									value={String(settings.generation)}
									onChange={(v) => set("generation", Number(v) as 1 | 23 | 4)}
									options={[
										{ value: "1", label: t("Gen 1") },
										{ value: "23", label: t("Gen 2/3") },
										{ value: "4", label: t("Gen 4") },
									]}
								/>
							</div>
						)}
						<Check
							label={t("Find trekker coverage")}
							checked={settings.rejectDescription}
							onChange={(v) => set("rejectDescription", v)}
						/>
					</>
				)}
				<Check
					label={t("Find unofficial coverage")}
					checked={settings.rejectOfficial}
					onChange={(v) => set("rejectOfficial", v)}
				/>
			</Section>

			<Section title={t("Location settings")}>
				{settings.rejectUnofficial && !settings.rejectOfficial && (
					<Check
						label={t("Reject locations without date")}
						checked={settings.rejectDateless}
						onChange={(v) => set("rejectDateless", v)}
					/>
				)}
				{settings.rejectUnofficial && !settings.rejectOfficial && !settings.rejectDescription && (
					<Check
						label={t("Reject locations without description")}
						checked={settings.rejectNoDescription}
						onChange={(v) => set("rejectNoDescription", v)}
					/>
				)}
				{settings.rejectUnofficial && !settings.rejectOfficial && (
					<>
						<Check
							label={t("Only one panorama on location")}
							checked={settings.onlyOneInTimeframe}
							onChange={(v) => set("onlyOneInTimeframe", v)}
							title={t("Only allow locations that don't have other nearby coverage in timeframe.")}
						/>
						<Check
							label={t("Check linked panos")}
							checked={settings.checkLinks}
							onChange={(v) => set("checkLinks", v)}
						/>
						{settings.checkLinks && (
							<NumberInput
								label={t("Depth")}
								value={settings.linksDepth}
								onChange={(v) => set("linksDepth", v)}
								min={1}
								max={10}
								indent
							/>
						)}
					</>
				)}
			</Section>

			<Section title={t("Map making settings")}>
				{settings.rejectUnofficial && !settings.rejectOfficial && (
					<>
						<Check
							label={t("Find intersection locations")}
							checked={settings.getIntersection}
							onChange={(v) => set("getIntersection", v)}
						/>
						<Check
							label={t("Find curve locations")}
							checked={settings.pinpointSearch}
							onChange={(v) => set("pinpointSearch", v)}
						/>
						{settings.pinpointSearch && (
							<NumberInput
								label={t("Pinpointable angle")}
								value={settings.pinpointAngle}
								onChange={(v) => set("pinpointAngle", v)}
								min={45}
								max={180}
								indent
							/>
						)}
						<Check
							label={t("Adjust heading")}
							checked={settings.adjustHeading}
							onChange={(v) => set("adjustHeading", v)}
						/>
						{settings.adjustHeading && (
							<>
								<RadioGroup
									name="headRef"
									indent
									value={settings.headingReference}
									onChange={(v) => set("headingReference", v as "link" | "forward" | "backward")}
									options={[
										{ value: "link", label: t("Along road") },
										{ value: "forward", label: t("To front of car") },
										{ value: "backward", label: t("To back of car") },
									]}
								/>
								<NumberInput
									label={t("Deviation")}
									value={settings.headingDeviation}
									onChange={(v) => set("headingDeviation", v)}
									min={0}
									max={360}
									indent
								/>
							</>
						)}
						<Check
							label={t("Adjust pitch")}
							checked={settings.adjustPitch}
							onChange={(v) => set("adjustPitch", v)}
						/>
						{settings.adjustPitch && (
							<NumberInput
								label={t("Pitch deviation")}
								value={settings.pitchDeviation}
								onChange={(v) => set("pitchDeviation", v)}
								min={-90}
								max={90}
								indent
							/>
						)}
						<Check
							label={t("Adjust zoom")}
							checked={settings.adjustZoom}
							onChange={(v) => set("adjustZoom", v)}
						/>
						{settings.adjustZoom && (
							<NumberInput
								label={t("Zoom level")}
								value={settings.zoomLevel}
								onChange={(v) => set("zoomLevel", v)}
								min={0}
								max={5}
								step={1}
								indent
							/>
						)}
						<Check
							label={t("Choose random date in time range")}
							checked={settings.randomInTimeline}
							onChange={(v) => set("randomInTimeline", v)}
						/>
					</>
				)}
			</Section>

			<Section title={t("General settings")}>
				<DistanceInput
					label={t("Radius")}
					base="m"
					value={settings.radius}
					onChange={(v) => set("radius", v)}
					min={10}
					max={1000000}
				/>
				<label className="generator-settings__number">
					{t("Sampling")}
					<SegmentedControl
						value={settings.samplingMode}
						onChange={(v) => set("samplingMode", v as GeneratorSettings["samplingMode"])}
						options={[
							{ value: "random", label: t("Random") },
							{ value: "poisson", label: t("Uniform") },
							{ value: "blueline", label: t("Coverage") },
							{ value: "kernels", label: t("Grow") },
						]}
					/>
				</label>
				<NumberInput
					label={t("Generators")}
					value={settings.numGenerators}
					onChange={(v) => set("numGenerators", v)}
					min={1}
					max={10}
				/>
				<NumberInput
					label={t("Speed")}
					value={settings.speed}
					onChange={(v) => set("speed", v)}
					min={1}
					max={1000}
				/>
				<Check
					label={t("Only check one country/polygon at a time")}
					checked={settings.oneCountryAtATime}
					onChange={(v) => set("oneCountryAtATime", v)}
				/>
				{!settings.selectMonths && (
					<div className="generator-settings__date-range">
						<label className="generator-settings__date-label">
							{t("From")}{" "}
							<DatePicker
								mode="month"
								value={settings.fromDate}
								onChange={(v) => set("fromDate", v)}
							/>
						</label>
						<label className="generator-settings__date-label">
							{t("To")}{" "}
							<DatePicker mode="month" value={settings.toDate} onChange={(v) => set("toDate", v)} />
						</label>
					</div>
				)}
				{!settings.rejectOfficial && (
					<>
						<Check
							label={t("Filter by month")}
							checked={settings.selectMonths}
							onChange={(v) => set("selectMonths", v)}
						/>
						{settings.selectMonths && (
							<div className="generator-settings__indent">
								<div className="generator-settings__date-range">
									<label className="generator-settings__date-label">
										{t("From month")}{" "}
										<TextInput
											style={{ width: "3rem" }}
											value={settings.fromMonth}
											onChange={(e) => set("fromMonth", e.target.value)}
										/>
									</label>
									<label className="generator-settings__date-label">
										{t("to")}{" "}
										<TextInput
											style={{ width: "3rem" }}
											value={settings.toMonth}
											onChange={(e) => set("toMonth", e.target.value)}
										/>
									</label>
								</div>
								<div className="generator-settings__date-range">
									<label className="generator-settings__date-label">
										{t("Between years")}{" "}
										<TextInput
											style={{ width: "4rem" }}
											value={settings.fromYear}
											onChange={(e) => set("fromYear", e.target.value)}
										/>
									</label>
									<label className="generator-settings__date-label">
										{t("and")}{" "}
										<TextInput
											style={{ width: "4rem" }}
											value={settings.toYear}
											onChange={(e) => set("toYear", e.target.value)}
										/>
									</label>
								</div>
							</div>
						)}
					</>
				)}
				{!settings.rejectOfficial && (
					<>
						<Check
							label={t("Filter by minimum distance from locations")}
							checked={settings.findRegions}
							onChange={(v) => set("findRegions", v)}
						/>
						{settings.findRegions && (
							<DistanceInput
								base="km"
								value={settings.regionRadius}
								onChange={(v) => set("regionRadius", v)}
								min={1}
								indent
							/>
						)}
					</>
				)}
				<Check
					label={t("Skip near existing map locations")}
					checked={settings.skipExisting}
					onChange={(v) => set("skipExisting", v)}
				/>
				{settings.skipExisting && (
					<DistanceInput
						base="m"
						value={settings.skipExistingRadius}
						onChange={(v) => set("skipExistingRadius", v)}
						min={1}
						indent
					/>
				)}
				<Check
					label={t("Check all dates")}
					checked={settings.checkAllDates}
					onChange={(v) => set("checkAllDates", v)}
				/>
			</Section>
			<Section title={t("Advanced filters")} defaultOpen={false}>
				<Check
					label={t("Search in panorama description")}
					checked={settings.searchInDescription}
					onChange={(v) => set("searchInDescription", v)}
				/>
				{settings.searchInDescription && (
					<div className="generator-settings__indent generator-settings__desc-search">
						<div className="generator-settings__desc-search-row">
							<SegmentedControl
								value={settings.searchFilterType}
								onChange={(v) => set("searchFilterType", v as "include" | "exclude")}
								options={[
									{ value: "include", label: t("Include") },
									{ value: "exclude", label: t("Exclude") },
								]}
							/>
							<NSelect
								className="nselect--compact"
								value={settings.searchMode}
								onChange={(e) =>
									set("searchMode", e.target.value as GeneratorSettings["searchMode"])
								}
							>
								<option value="contains">{t("Contains")}</option>
								<option value="fullword">{t("Full word")}</option>
								<option value="startswith">{t("Starts with")}</option>
								<option value="endswith">{t("Ends with")}</option>
								<option value="sectionmatch">{t("Section match")}</option>
							</NSelect>
						</div>
						<TextInput
							type="text"
							placeholder={t("Comma-separated terms")}
							value={settings.searchTerms}
							onChange={(e) => set("searchTerms", e.target.value)}
						/>
					</div>
				)}
				<Check
					label={t("Filter by number of links")}
					checked={settings.filterByLinks}
					onChange={(v) => set("filterByLinks", v)}
				/>
				{settings.filterByLinks && (
					<div className="generator-settings__indent generator-settings__date-range">
						<NumberInput
							label={t("Min")}
							value={settings.minLinks}
							onChange={(v) => set("minLinks", v)}
							min={0}
							max={10}
						/>
						<NumberInput
							label={t("Max")}
							value={settings.maxLinks}
							onChange={(v) => set("maxLinks", v)}
							min={0}
							max={10}
						/>
					</div>
				)}
			</Section>

			<Section title={t("Visualization")} defaultOpen={false}>
				<Check
					label={t("Show search coverage")}
					checked={settings.showSearchOverlay}
					onChange={(v) => set("showSearchOverlay", v)}
					title={t(
						"Draw where the generator has searched, as a growing overlay. Clears when you stop.",
					)}
				/>
			</Section>
		</div>
	);
}
