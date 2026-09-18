import type { GeneratorSettings } from "../engine/types";
import { DatePicker } from "@/components/primitives/DatePicker";
import { NSelect } from "@/components/primitives/NSelect";
import { Radio } from "@/components/primitives/Radio";
import { Checkbox } from "@/components/primitives/Checkbox";
import { SwitchRow } from "@/components/primitives/SwitchRow";
import { Section, SegmentedControl } from "@/components/primitives/Sidebar";
import { t } from "@/lib/i18n";
import { fieldValueLabel, getFieldDef } from "@/lib/data/fieldDefRegistry";
import { TextInput } from "@/components/primitives/TextInput";
import { distanceUnit } from "@/lib/util/format";
import { useSetting } from "@/store/settings";

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
				<Radio
					key={opt.value}
					name={name}
					checked={value === opt.value}
					onChange={() => onChange(opt.value)}
				>
					{opt.label}
				</Radio>
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
						<Checkbox
							checked={settings.rejectUnofficial}
							onChange={(e) => set("rejectUnofficial", e.target.checked)}
						>
							{t("Reject unofficial")}
						</Checkbox>
						<Checkbox
							checked={settings.rejectGen1}
							onChange={(e) => set("rejectGen1", e.target.checked)}
						>
							{t("Reject gen 1")}
						</Checkbox>
					</>
				)}
				{settings.rejectUnofficial && !settings.rejectOfficial && !settings.rejectGen1 && (
					<>
						<Checkbox
							checked={settings.findGeneration}
							onChange={(e) => set("findGeneration", e.target.checked)}
						>
							{t("Find generation")}
						</Checkbox>
						{settings.findGeneration && (
							<div className="generator-settings__indent">
								<SegmentedControl
									value={String(settings.generation)}
									onChange={(v) => set("generation", Number(v) as 1 | 23 | 4)}
									options={[
										{ value: "1", label: fieldValueLabel(getFieldDef("cameraType"), "gen1") },
										{ value: "23", label: fieldValueLabel(getFieldDef("cameraType"), "gen2") },
										{ value: "4", label: fieldValueLabel(getFieldDef("cameraType"), "gen4") },
									]}
								/>
							</div>
						)}
						<Checkbox
							checked={settings.rejectDescription}
							onChange={(e) => set("rejectDescription", e.target.checked)}
						>
							{t("Find trekker coverage")}
						</Checkbox>
					</>
				)}
				<Checkbox
					checked={settings.rejectOfficial}
					onChange={(e) => set("rejectOfficial", e.target.checked)}
				>
					{t("Find unofficial coverage")}
				</Checkbox>
			</Section>

			<Section title={t("Location settings")}>
				{settings.rejectUnofficial && !settings.rejectOfficial && (
					<Checkbox
						checked={settings.rejectDateless}
						onChange={(e) => set("rejectDateless", e.target.checked)}
					>
						{t("Reject locations without date")}
					</Checkbox>
				)}
				{settings.rejectUnofficial && !settings.rejectOfficial && !settings.rejectDescription && (
					<Checkbox
						checked={settings.rejectNoDescription}
						onChange={(e) => set("rejectNoDescription", e.target.checked)}
					>
						{t("Reject locations without description")}
					</Checkbox>
				)}
				{settings.rejectUnofficial && !settings.rejectOfficial && (
					<>
						<Checkbox
							checked={settings.onlyOneInTimeframe}
							onChange={(e) => set("onlyOneInTimeframe", e.target.checked)}
							title={t("Only allow locations that don't have other nearby coverage in timeframe.")}
						>
							{t("Only one panorama on location")}
						</Checkbox>
						<Checkbox
							checked={settings.checkLinks}
							onChange={(e) => set("checkLinks", e.target.checked)}
						>
							{t("Check linked panos")}
						</Checkbox>
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
						<Checkbox
							checked={settings.getIntersection}
							onChange={(e) => set("getIntersection", e.target.checked)}
						>
							{t("Find intersection locations")}
						</Checkbox>
						<Checkbox
							checked={settings.pinpointSearch}
							onChange={(e) => set("pinpointSearch", e.target.checked)}
						>
							{t("Find curve locations")}
						</Checkbox>
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
						<Checkbox
							checked={settings.adjustHeading}
							onChange={(e) => set("adjustHeading", e.target.checked)}
						>
							{t("Adjust heading")}
						</Checkbox>
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
						<Checkbox
							checked={settings.adjustPitch}
							onChange={(e) => set("adjustPitch", e.target.checked)}
						>
							{t("Adjust pitch")}
						</Checkbox>
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
						<Checkbox
							checked={settings.adjustZoom}
							onChange={(e) => set("adjustZoom", e.target.checked)}
						>
							{t("Adjust zoom")}
						</Checkbox>
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
						<Checkbox
							checked={settings.randomInTimeline}
							onChange={(e) => set("randomInTimeline", e.target.checked)}
						>
							{t("Choose random date in time range")}
						</Checkbox>
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
				<div className="generator-settings__number">
					{t("Sampling")}
					<SegmentedControl
						value={settings.samplingMode}
						onChange={(v) => set("samplingMode", v as GeneratorSettings["samplingMode"])}
						options={[
							{ value: "random", label: t("Random") },
							{ value: "poisson", label: t("Uniform") },
							{ value: "grid", label: t("Grid") },
							{ value: "blueline", label: t("Coverage") },
							{ value: "kernels", label: t("Grow") },
						]}
					/>
				</div>
				{settings.samplingMode === "blueline" && (
					<div className="generator-settings__number">
						{t("Distribution")}
						<SegmentedControl
							value={settings.distribution}
							onChange={(v) => set("distribution", v as GeneratorSettings["distribution"])}
							options={[
								{ value: "density", label: t("Density") },
								{ value: "balanced", label: t("Balanced") },
								{ value: "even", label: t("Even") },
							]}
						/>
					</div>
				)}
				<Checkbox
					checked={settings.oneCountryAtATime}
					onChange={(e) => set("oneCountryAtATime", e.target.checked)}
				>
					{t("Only check one country/polygon at a time")}
				</Checkbox>
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
						<Checkbox
							checked={settings.selectMonths}
							onChange={(e) => set("selectMonths", e.target.checked)}
						>
							{t("Filter by month")}
						</Checkbox>
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
						<Checkbox
							checked={settings.findRegions}
							onChange={(e) => set("findRegions", e.target.checked)}
						>
							{t("Filter by minimum distance from locations")}
						</Checkbox>
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
				<Checkbox
					checked={settings.skipExisting}
					onChange={(e) => set("skipExisting", e.target.checked)}
				>
					{t("Skip near existing map locations")}
				</Checkbox>
				{settings.skipExisting && (
					<DistanceInput
						base="m"
						value={settings.skipExistingRadius}
						onChange={(v) => set("skipExistingRadius", v)}
						min={1}
						indent
					/>
				)}
				<Checkbox
					checked={settings.checkAllDates}
					onChange={(e) => set("checkAllDates", e.target.checked)}
				>
					{t("Check all dates")}
				</Checkbox>
			</Section>
			<Section title={t("Advanced filters")} defaultOpen={false}>
				<Checkbox
					checked={settings.searchInDescription}
					onChange={(e) => set("searchInDescription", e.target.checked)}
				>
					{t("Search in panorama description")}
				</Checkbox>
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
								compact
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
				<Checkbox
					checked={settings.filterByLinks}
					onChange={(e) => set("filterByLinks", e.target.checked)}
				>
					{t("Filter by number of links")}
				</Checkbox>
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
				<Checkbox
					checked={settings.findCurves}
					onChange={(e) => set("findCurves", e.target.checked)}
				>
					{t("Find curves")}
				</Checkbox>
				{settings.findCurves && (
					<NumberInput
						label={t("Min curve angle")}
						value={settings.minCurveAngle}
						onChange={(v) => set("minCurveAngle", v)}
						min={5}
						max={90}
						indent
					/>
				)}
			</Section>

			<Section title={t("Visualization")} defaultOpen={false}>
				<SwitchRow
					label={t("Show search coverage")}
					checked={settings.showSearchOverlay}
					onChange={(v) => set("showSearchOverlay", v)}
				>
					<span
						title={t(
							"Draw where the generator has searched, as a growing overlay. Clears when you stop.",
						)}
					>
						{t("Show search coverage")}
					</span>
				</SwitchRow>
			</Section>
		</div>
	);
}
