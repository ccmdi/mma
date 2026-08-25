import { useState } from "react";
import { NSelect } from "@/components/primitives/NSelect";
import type {
	KeySpec,
	DatePart,
	Update,
	LocationPatch_Deserialize as LocationPatch,
} from "@/bindings.gen";
import { getProviderForField } from "@/lib/data/fieldDefs";
import { projectionsForType, partitionKeyOptions, RANGE_ID } from "@/lib/data/fieldOps";
import { useExtraFieldKeys } from "@/components/editor/map/FilterBuilder";
import { fetchLocations, createTags, updateLocations, scopeIds } from "@/store/useMapStore";
import { partition, useScope } from "@/store/scope";
import { ScopeSelector } from "@/components/primitives/ScopeSelector";
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
	const scopeCtl = useScope();
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

		const groups = await partition(field, key, scopeCtl.scope);

		// Rust drops rows whose key does not resolve, so whatever the groups miss is exactly
		// the set with no value for this field.
		let missing: number[] = [];
		if (tagMissing) {
			const grouped = new Set(groups.flatMap((g) => g.ids));
			missing = (await scopeIds(scopeCtl.scope)).filter((id) => !grouped.has(id));
		}
		if (groups.length === 0 && missing.length === 0) return;

		const transform = getProviderForField(field)?.transform;
		const locs = await fetchLocations({
			kind: "ids",
			ids: [...groups.flatMap((g) => g.ids), ...missing],
		});
		const locById = new Map(locs.map((l) => [l.id, l]));

		const tagNames = new Set<string>();
		if (missing.length > 0) tagNames.add(missingName);
		for (const g of groups) {
			if (transform) {
				for (const id of g.ids) {
					const l = locById.get(id);
					if (!l) continue;
					const name = transform(field, g.key, l);
					if (name != null) tagNames.add(name);
				}
			} else {
				tagNames.add(g.key);
			}
		}

		const created = await createTags([...tagNames]);
		const tagIdByName = new Map(created.map((t) => [t.name.toLowerCase(), t.id]));
		const updates: Update<LocationPatch>[] = [];
		for (const g of groups) {
			for (const id of g.ids) {
				const l = locById.get(id);
				if (!l) continue;
				const name = transform ? transform(field, g.key, l) : g.key;
				if (name == null) continue;
				const tagId = tagIdByName.get(name.toLowerCase());
				if (tagId != null && !l.tags.includes(tagId))
					updates.push({ id, patch: { tags: [...l.tags, tagId] } });
			}
		}
		const missingTagId = tagIdByName.get(missingName.toLowerCase());
		if (missingTagId != null) {
			for (const id of missing) {
				const l = locById.get(id);
				if (l && !l.tags.includes(missingTagId))
					updates.push({ id, patch: { tags: [...l.tags, missingTagId] } });
			}
		}
		if (updates.length > 0) await updateLocations(updates);
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
					<ScopeSelector ctl={scopeCtl} />
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
