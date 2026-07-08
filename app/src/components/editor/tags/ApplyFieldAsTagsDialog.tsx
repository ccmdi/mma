import { useState, useMemo } from "react";
import { NSelect } from "@/components/primitives/NSelect";
import type {
	ExtraFieldDef,
	KeySpec,
	DatePart,
	Update,
	LocationPatch_Deserialize as LocationPatch,
} from "@/bindings.gen";
import { getFieldDef, fieldLabel } from "@/lib/data/fieldDefRegistry";
import { getProviderForField } from "@/lib/data/fieldDefs";
import { projectionsForType, partitionKeyOptions, RANGE_ID } from "@/lib/data/fieldOps";
import {
	useKnownFieldKeys,
	fetchLocationsByIds,
	partition,
	useScope,
	createTags,
	updateLocations,
} from "@/store/useMapStore";
import { ScopeSelector } from "@/components/primitives/ScopeSelector";
import { useSetting } from "@/store/settings";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";

export function ApplyFieldAsTagsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const tzDefault = useSetting("dateTimezone") === "location";
	const [field, setField] = useState("");
	const [projectionId, setProjectionId] = useState("");
	const [width, setWidth] = useState("");
	const [tzLocal, setTzLocal] = useState(tzDefault);
	const scopeCtl = useScope();
	const keys = useKnownFieldKeys();
	const fields = useMemo(() => {
		const entries: { key: string; label: string; type: ExtraFieldDef["type"] }[] = [];
		for (const key of keys) {
			const def = getFieldDef(key);
			entries.push({ key, label: fieldLabel(key), type: def?.type ?? "string" });
		}
		return entries;
	}, [keys]);

	const fieldType = fields.find((f) => f.key === field)?.type ?? "string";
	const projOptions = partitionKeyOptions(fieldType, false);
	const isRange = projectionId === RANGE_ID;
	const selectedProj = projectionsForType(fieldType).find((p) => p.id === projectionId);
	const hasTzData = keys.has("timezone");
	const showTz = !isRange && selectedProj?.needsTz === true && fieldType === "date";
	const showWidth = isRange;
	const widthValid = !showWidth || Number(width) > 0;

	const handleFieldChange = (key: string) => {
		setField(key);
		const type = fields.find((f) => f.key === key)?.type ?? "string";
		setProjectionId(projectionsForType(type)[0]?.id ?? "");
		setWidth("");
		setTzLocal(tzDefault);
	};

	const validateCopyrightYear = (imageDate: string, copyrightYear: string) => {
		if (imageDate && copyrightYear && Number(imageDate.slice(0, 4)) > Number(copyrightYear)) {
			return false;
		}
		return true;
	};

	const handleApply = async () => {
		if (!field || !widthValid) return;

		const key: KeySpec = isRange
			? { kind: "numericBin", binning: { by: "width", w: Number(width) } }
			: projectionId === "value"
				? { kind: "value" }
				: { kind: "datePart", part: projectionId as DatePart, tzLocal: tzLocal && hasTzData };

		const groups = await partition(field, key, scopeCtl.scope);
		if (groups.length === 0) return;

		const transform = getProviderForField(field)?.transform;
		const locs = await fetchLocationsByIds(groups.flatMap((g) => g.ids));
		const locById = new Map(locs.map((l) => [l.id, l]));

		const tagNames = new Set<string>();
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
				}
			}}
		>
			<DialogContent title="Apply metadata as tags">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleApply();
					}}
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}
				>
					<ScopeSelector ctl={scopeCtl} />
					<div style={{ display: "flex", gap: "0.5rem" }}>
						<NSelect
							className="nselect--compact"
							value={field}
							onChange={(e) => handleFieldChange(e.target.value)}
							onWheel={(e) => e.stopPropagation()}
							style={{ flex: 1 }}
							autoFocus
						>
							<option value="">Select a field...</option>
							{fields.map((f) => (
								<option key={f.key} value={f.key}>
									{f.label}
								</option>
							))}
						</NSelect>
						{field && projOptions.length > 1 && (
							<NSelect
								className="nselect--compact"
								value={projectionId}
								onChange={(e) => setProjectionId(e.target.value)}
								onWheel={(e) => e.stopPropagation()}
							>
								{projOptions.map((p) => (
									<option key={p.id} value={p.id}>
										{p.label}
									</option>
								))}
							</NSelect>
						)}
					</div>
					{showWidth && (
						<input
							className="input"
							type="number"
							min="0"
							value={width}
							onChange={(e) => setWidth(e.target.value)}
							placeholder="Bucket width..."
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
							title={hasTzData ? undefined : "No locations have timezone data"}
						>
							<input
								type="checkbox"
								checked={tzLocal && hasTzData}
								disabled={!hasTzData}
								onChange={(e) => setTzLocal(e.target.checked)}
							/>
							Location timezone
						</label>
					)}
					<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
						<button className="button" type="button" onClick={() => onOpenChange(false)}>
							Cancel
						</button>
						<button
							className="button button--primary"
							type="submit"
							disabled={!field || !widthValid}
						>
							Apply
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
