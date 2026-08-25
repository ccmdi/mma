import { useState } from "react";
import { NSelect } from "@/components/primitives/NSelect";
import type { KeySpec, DatePart } from "@/bindings.gen";
import { resolveFieldLabels } from "@/lib/data/procedures";
import { projectionsForType, partitionKeyOptions, RANGE_ID } from "@/lib/data/fieldOps";
import { useExtraFieldKeys } from "@/components/editor/map/FilterBuilder";
import { createTags, partition, resolveIds } from "@/store/useMapStore";
import { useSelectorPick } from "@/store/selectorPick";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import { useSetting } from "@/store/settings";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { Checkbox } from "@/components/primitives/Checkbox";
import { t } from "@/lib/i18n";

export function ApplyFieldAsTagsDialog({ open, onOpenChange }: DialogProps) {
	const tzDefault = useSetting("dateTimezone") === "location";
	const [field, setField] = useState("");
	const [projectionId, setProjectionId] = useState("");
	const [width, setWidth] = useState("");
	const [tzLocal, setTzLocal] = useState(tzDefault);
	const [tagMissing, setTagMissing] = useState(false);
	const picker = useSelectorPick();
	const fields = useExtraFieldKeys();

	const fieldType = fields.find((f) => f.key === field)?.def.type ?? "string";
	const projOptions = partitionKeyOptions(fieldType, false);
	const isRange = projectionId === RANGE_ID;
	const selectedProj = projectionsForType(fieldType).find((p) => p.id === projectionId);
	const hasTzData = fields.some((f) => f.key === "timezone");
	const showTz = !isRange && selectedProj?.needsTz === true && fieldType === "date";
	const showWidth = isRange;
	const widthValid = !showWidth || Number(width) > 0;

	const handleFieldChange = (key: string) => {
		setField(key);
		const type = fields.find((f) => f.key === key)?.def.type ?? "string";
		setProjectionId(projectionsForType(type)[0]?.id ?? "");
		setWidth("");
		setTzLocal(tzDefault);
	};

	const fieldLabel = fields.find((f) => f.key === field)?.label ?? field;
	const missingName = t("No {field} data", { field: t(fieldLabel) });

	const handleApply = async () => {
		if (!field || !widthValid) return;

		const key: KeySpec = isRange
			? { kind: "numericBin", binning: { by: "width", w: Number(width) } }
			: projectionId === "value"
				? { kind: "value" }
				: { kind: "datePart", part: projectionId as DatePart, tzLocal: tzLocal && hasTzData };

		const groups = await partition(field, key, picker.selector);

		// Rust drops rows whose key does not resolve, so whatever the groups miss is exactly
		// the set with no value for this field.
		let missing: number[] = [];
		if (tagMissing) {
			const grouped = new Set(groups.flatMap((g) => g.ids));
			missing = (await resolveIds(picker.selector)).filter((id) => !grouped.has(id));
		}
		if (groups.length === 0 && missing.length === 0) return;

		// Two groups can share a label, so ids are merged by name first.
		const labels = await resolveFieldLabels(
			field,
			groups.map((g) => g.key),
		);
		const idsByName = new Map<string, number[]>();
		groups.forEach((g, i) => {
			const name = labels[i];
			const ids = idsByName.get(name);
			if (ids) ids.push(...g.ids);
			else idsByName.set(name, [...g.ids]);
		});
		if (missing.length > 0) idsByName.set(missingName, missing);

		for (const [name, ids] of idsByName)
			await createTags([name], { type: "Locations", locations: ids, name: null });
		onOpenChange(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				onOpenChange(v);
				if (!v) {
					setField("");
					setProjectionId("");
					setWidth("");
					setTzLocal(tzDefault);
					setTagMissing(false);
				}
			}}
		>
			<DialogContent title={t("Apply metadata as tags")}>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void handleApply();
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
				>
					<SelectorPicker ctl={picker} />
					<div style={{ display: "flex", gap: "0.5rem" }}>
						<NSelect
							className="nselect--compact"
							value={field}
							onChange={(e) => handleFieldChange(e.target.value)}
							style={{ flex: 1 }}
							autoFocus
						>
							<option value="">{t("Select a field...")}</option>
							{fields.map((f) => (
								<option key={f.key} value={f.key}>
									{t(f.label)}
								</option>
							))}
						</NSelect>
						{field && projOptions.length > 1 && (
							<NSelect
								className="nselect--compact"
								value={projectionId}
								onChange={(e) => setProjectionId(e.target.value)}
							>
								{projOptions.map((p) => (
									<option key={p.id} value={p.id}>
										{t(p.label)}
									</option>
								))}
							</NSelect>
						)}
					</div>
					{showWidth && (
						<TextInput
							type="number"
							min="0"
							value={width}
							onChange={(e) => setWidth(e.target.value)}
							placeholder={t("Bucket width...")}
						/>
					)}
					{showTz && (
						<label
							style={{
								display: "flex",
								alignItems: "center",
								gap: "0.5rem",
								opacity: hasTzData ? 1 : 0.5,
							}}
							title={hasTzData ? undefined : t("No locations have timezone data")}
						>
							<Checkbox
								checked={tzLocal && hasTzData}
								disabled={!hasTzData}
								onChange={(e) => setTzLocal(e.target.checked)}
							/>

							{t("Location timezone")}
						</label>
					)}
					{field && (
						<label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
							<Checkbox checked={tagMissing} onChange={(e) => setTagMissing(e.target.checked)} />
							{t("Tag locations with no value as “{name}”", { name: missingName })}
						</label>
					)}
					<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
						<Button onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
						<Button variant="primary" type="submit" disabled={!field || !widthValid}>
							{t("Apply")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
