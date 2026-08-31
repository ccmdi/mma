/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useMemo } from "react";
import type { Selection, FilterOp, ExtraFieldDef } from "@/bindings.gen";
import { NSelect } from "@/components/primitives/NSelect";
import {
	fieldLabel,
	fieldValueLabel,
	getAllFieldDefs,
	isListableField,
	getKnownFieldKeys,
} from "@/lib/data/fieldDefRegistry";
import { useEvent } from "@/lib/events";
import { pickPeriodEnd, hasTimeOfDay, dateParts, partsToEpoch } from "@/lib/util/date";
import { addSelections, fieldValues } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import { OP_LABELS } from "@/store/selections";
import { DatePicker, type DateFlagProps } from "@/components/primitives/DatePicker";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { mdiArrowRight, mdiArrowLeft } from "@mdi/js";
import { t, msg } from "@/lib/i18n";

const ALL_OPS: FilterOp[] = ["eq", "neq", "gt", "lt", "gte", "lte", "between", "has", "nothas"];
const EQUALITY_OPS: FilterOp[] = ["eq", "neq", "has", "nothas"];
const DATE_OPS: FilterOp[] = ["between", "gt", "lt", "gte", "lte", "has", "nothas"];
const ARRAY_OPS: FilterOp[] = [
	"contains",
	"notcontains",
	"eq",
	"neq",
	"gt",
	"lt",
	"gte",
	"lte",
	"between",
	"has",
	"nothas",
];
const ARRAY_OP_LABELS: Partial<Record<FilterOp, string>> = {
	eq: msg("length ="),
	neq: msg("length !="),
	gt: msg("length >"),
	lt: msg("length <"),
	gte: msg("length >="),
	lte: msg("length <="),
	between: msg("length between"),
};
const filterBuilderState = new Map<
	string,
	{
		field: string;
		op: FilterOp;
		value: string;
		value2: string;
		anyYear?: boolean;
		anyTime?: boolean;
		tzLocal?: boolean;
	}
>();

function opsForType(type: string | undefined): FilterOp[] {
	if (type === "enum") return EQUALITY_OPS;
	if (type === "date") return DATE_OPS;
	if (type === "array") return ARRAY_OPS;
	return ALL_OPS;
}

export interface FieldEntry {
	key: string;
	label: string;
	def: ExtraFieldDef;
}

export function useExtraFieldKeys(): FieldEntry[] {
	const defsVersion = useEvent("fields:changed");
	return useMemo(() => {
		const allDefs = getAllFieldDefs();
		const seen = new Set<string>();
		const entries: FieldEntry[] = [];
		for (const key of getKnownFieldKeys()) {
			seen.add(key);
			entries.push({ key, label: fieldLabel(key), def: allDefs[key] ?? { type: "string" } });
		}
		for (const [key, def] of Object.entries(allDefs)) {
			if (!seen.has(key) && isListableField(key))
				entries.push({ key, label: fieldLabel(key), def });
		}
		entries.sort((a, b) => a.label.localeCompare(b.label));
		return entries;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the registry's change signal
	}, [defsVersion]);
}

const TIMEZONE_VALUES = Intl.supportedValuesOf("timeZone");

function useEnumValues(fieldKey: string | undefined, def: ExtraFieldDef | undefined): string[] {
	const [values, setValues] = useState<string[]>([]);
	useEffect(() => {
		if (def?.type !== "enum") {
			setValues([]);
			return;
		}
		if (def.values) {
			setValues(def.values);
			return;
		}
		if (fieldKey === "timezone") {
			setValues(TIMEZONE_VALUES);
			return;
		}
		if (!fieldKey) {
			setValues([]);
			return;
		}
		void fieldValues({ type: "Everything" }, fieldKey).then(setValues);
	}, [fieldKey, def]);
	return values;
}

function FilterValueInput({
	fieldEntry,
	op,
	value,
	onChange,
	placeholder,
	...dateFlags
}: {
	fieldEntry: FieldEntry | undefined;
	op?: FilterOp;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
} & DateFlagProps) {
	const type = fieldEntry?.def.type;
	const def = fieldEntry?.def;
	const enumValues = useEnumValues(fieldEntry?.key, def);
	const exactDateFormat = useSetting("exactDateFormat");

	if (type === "enum") {
		return (
			<NSelect value={value} onChange={(e) => onChange(e.target.value)}>
				<option value="">--</option>
				{enumValues.map((v) => (
					<option key={v} value={v}>
						{fieldValueLabel(def, v)}
					</option>
				))}
			</NSelect>
		);
	}

	if (type === "date" || type === "month") {
		return (
			<DatePicker
				{...dateFlags}
				mode={type}
				value={value}
				onChange={onChange}
				showTime={type === "date" && exactDateFormat === "datetime"}
				wallClock={dateFlags.tzLocal}
			/>
		);
	}

	if (type === "array" && (op === "contains" || op === "notcontains")) {
		return (
			<TextInput
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder ?? t("Value")}
			/>
		);
	}

	if (type === "number" || type === "array") {
		return (
			<TextInput
				type="number"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder ?? (type === "array" ? t("Length") : t("Value"))}
			/>
		);
	}

	return (
		<TextInput
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder ?? t("Value")}
		/>
	);
}

type FilterFormSeed = {
	field: string;
	op: FilterOp;
	value: string;
	value2: string;
	anyYear?: boolean;
	anyTime?: boolean;
	tzLocal?: boolean;
};

/** Reverse of FilterForm.handleAdd: turn a stored Filter selection back into editable form state. */
export function filterPropsToSeed(
	p: Extract<Selection["selector"], { type: "Filter" }>,
): FilterFormSeed {
	let op = p.op as FilterOp;
	let anyYear = false;
	let anyTime = false;
	if (op === "between_anyyear") {
		op = "between";
		anyYear = true;
	} else if (op === "between_anytime") {
		op = "between";
		anyTime = true;
	}
	return {
		field: p.field,
		op,
		value: p.value == null ? "" : String(p.value),
		value2: p.value2 == null ? "" : String(p.value2),
		anyYear,
		anyTime,
		tzLocal: p.tzLocal ?? false,
	};
}

/** Shared field/op/value editor. `onSubmit` receives parsed pieces; create mode persists
 *  draft state under `persistKey`, edit mode seeds from `initial` and shows Cancel. */
export function FilterForm({
	initial,
	persistKey,
	submitLabel,
	onSubmit,
	onClose,
}: {
	initial?: FilterFormSeed;
	persistKey?: string;
	submitLabel: string;
	onSubmit: (
		field: string,
		op: FilterOp,
		value: string | number | null,
		value2: string | number | undefined,
		tzLocal: boolean,
	) => void;
	onClose?: () => void;
}) {
	const fields = useExtraFieldKeys();
	const saved = initial ?? (persistKey ? filterBuilderState.get(persistKey) : undefined);
	const [field, setField] = useState(() => saved?.field || fields[0]?.key || "");
	const [op, setOp] = useState<FilterOp>(() => {
		const initial = saved?.op ?? "eq";
		const ops = opsForType(
			fields.find((f) => f.key === (saved?.field || fields[0]?.key))?.def.type,
		);
		return ops.includes(initial) ? initial : ops[0];
	});
	const [value, setValue] = useState(saved?.value ?? "");
	const [value2, setValue2] = useState(saved?.value2 ?? "");
	const [anyYear, setAnyYear] = useState(saved?.anyYear ?? false);
	const [anyTime, setAnyTime] = useState(saved?.anyTime ?? false);
	const [tzLocal, setTzLocal] = useState(saved?.tzLocal ?? false);
	const fieldEntry = fields.find((f) => f.key === field);
	const isArrayContains =
		fieldEntry?.def.type === "array" && (op === "contains" || op === "notcontains");
	const isNumeric =
		fieldEntry?.def.type === "number" ||
		fieldEntry?.def.type === "date" ||
		(fieldEntry?.def.type === "array" && !isArrayContains);
	const isDateLike = fieldEntry?.def.type === "date" || fieldEntry?.def.type === "month";
	const isExactDate = fieldEntry?.def.type === "date";
	const availableOps = opsForType(fieldEntry?.def.type);
	const isBetween = op === "between" || op === "between_anyyear" || op === "between_anytime";

	useEffect(() => {
		if (persistKey)
			filterBuilderState.set(persistKey, { field, op, value, value2, anyYear, anyTime, tzLocal });
	}, [persistKey, field, op, value, value2, anyYear, anyTime, tzLocal]);

	const handleFieldChange = (key: string) => {
		setField(key);
		const entry = fields.find((f) => f.key === key);
		const ops = opsForType(entry?.def.type);
		const newOp = ops.includes(op) ? op : ops[0];
		if (newOp !== op) setOp(newOp);
		setValue("");
		setValue2("");
		setAnyYear(false);
		setAnyTime(false);
		setTzLocal(false);
	};

	// tzLocal is an independent toggle: it survives op changes (the values' encoding
	// frame never silently flips) and composes with anyYear/anyTime.
	const handleOpChange = (newOp: FilterOp) => {
		setOp(newOp);
		if (newOp !== "between") {
			setAnyYear(false);
			setAnyTime(false);
		}
	};

	// Toggle wall-clock-in-location-timezone mode. The picker re-encodes between a
	// local-time instant (off) and a wall-clock-as-UTC instant (on); convert the
	// existing values so the displayed wall-clock numbers are preserved.
	const handleTzLocalToggle = (checked: boolean) => {
		setTzLocal(checked);
		// Re-encode epoch values between frames; anyYear/anyTime string values
		// ("MM-DD"/"HH:MM") pass through the NaN guard untouched.
		const convert = (v: string): string => {
			const n = Number(v);
			if (!v || isNaN(n)) return v;
			return String(partsToEpoch(dateParts(n, !checked), checked));
		};
		setValue(convert(value));
		setValue2(convert(value2));
	};

	const handleAnyYearToggle = (checked: boolean) => {
		setAnyYear(checked);
		if (checked) {
			setAnyTime(false);
			const convert = (v: string): string => {
				if (!v) return "";
				if (isExactDate) {
					const n = Number(v);
					if (!isNaN(n) && v !== "") {
						const p = dateParts(n, tzLocal);
						return `${String(p.mo + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
					}
				}
				const ym = /^\d{4}-(\d{2})$/.exec(v);
				if (ym) return ym[1];
				return v;
			};
			setValue(convert(value));
			setValue2(convert(value2));
		} else {
			const now = new Date();
			const yr = now.getFullYear();
			const convert = (v: string): string => {
				if (!v) return "";
				if (isExactDate) {
					const md = /^(\d{2})-(\d{2})$/.exec(v);
					if (md) {
						return String(
							partsToEpoch({ y: yr, mo: Number(md[1]) - 1, d: Number(md[2]) }, tzLocal),
						);
					}
				}
				if (/^\d{2}$/.test(v)) return `${yr}-${v}`;
				return v;
			};
			setValue(convert(value));
			setValue2(convert(value2));
		}
	};

	const handleAnyTimeToggle = (checked: boolean) => {
		setAnyTime(checked);
		if (checked) {
			setAnyYear(false);
			const convert = (v: string): string => {
				if (!v) return "";
				const n = Number(v);
				if (!isNaN(n) && v !== "") {
					const p = dateParts(n, tzLocal);
					return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
				}
				return "";
			};
			setValue(convert(value));
			setValue2(convert(value2));
		} else {
			setValue("");
			setValue2("");
		}
	};

	const needsValue = op !== "has" && op !== "nothas";
	const toMonthDay = (v: string): string => {
		if (!v) return "";
		if (/^\d{2}-\d{2}$/.test(v)) return v;
		if (/^\d{2}$/.test(v)) return `${v}-01`;
		const n = Number(v);
		if (!isNaN(n) && v !== "") {
			const d = new Date(n * 1000);
			return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		}
		const ym = /^\d{4}-(\d{2})$/.exec(v);
		if (ym) return `${ym[1]}-01`;
		return v;
	};
	const handleAdd = () => {
		if (!field) return;
		if (needsValue && !value) return;
		let finalOp: FilterOp = op;
		if (isBetween && anyYear) finalOp = "between_anyyear";
		if (isBetween && anyTime) finalOp = "between_anytime";
		let parsed: string | number | null;
		let parsed2: string | number | undefined;
		if (anyYear && isBetween) {
			parsed = toMonthDay(value);
			parsed2 = toMonthDay(value2);
		} else if (anyTime && isBetween) {
			parsed = value;
			parsed2 = value2;
		} else {
			parsed = needsValue ? (isNumeric ? Number(value) : value) : null;
			parsed2 = isBetween ? (isNumeric ? Number(value2) : value2) : undefined;
		}
		if (
			isBetween &&
			!anyYear &&
			!anyTime &&
			isNumeric &&
			parsed != null &&
			parsed2 != null &&
			Number(parsed) > Number(parsed2)
		) {
			[parsed, parsed2] = [parsed2, parsed];
		}
		// A date pick denotes a period: midnight = the day, an explicit time = the minute.
		// Bounds that mean "through the end of the pick" expand to the period end.
		if (isExactDate && !anyYear && !anyTime) {
			const grain = (v: number): "day" | "minute" => (hasTimeOfDay(v, tzLocal) ? "minute" : "day");
			if (isBetween && typeof parsed2 === "number") {
				parsed2 = pickPeriodEnd(parsed2, grain(parsed2), tzLocal);
			} else if ((op === "gt" || op === "lte") && typeof parsed === "number") {
				parsed = pickPeriodEnd(parsed, grain(parsed), tzLocal);
			}
		}
		onSubmit(field, finalOp, parsed, parsed2, isExactDate && tzLocal);
		onClose?.();
	};

	const showAnyYear = isBetween && isDateLike;
	const showAnyTime = isBetween && isExactDate;
	const showTzLocal = isExactDate;

	const handleYearSelect =
		isBetween && fieldEntry?.def.type === "month"
			? (year: number) => {
					setValue(`${year}-01`);
					setValue2(`${year}-12`);
				}
			: undefined;

	return (
		<form
			className="extra-filter-builder"
			onSubmit={(e) => {
				e.preventDefault();
				handleAdd();
			}}
		>
			<label>{t("Filter by metadata:")}</label>
			<NSelect value={field} onChange={(e) => handleFieldChange(e.target.value)}>
				{fields.length === 0 && <option value="">{t("No metadata yet")}</option>}
				{fields.map((f) => (
					<option key={f.key} value={f.key}>
						{t(f.label)}
					</option>
				))}
			</NSelect>
			<NSelect value={op} onChange={(e) => handleOpChange(e.target.value as FilterOp)}>
				{availableOps.map((o) => (
					<option key={o} value={o}>
						{t((fieldEntry?.def.type === "array" && ARRAY_OP_LABELS[o]) || OP_LABELS[o])}
					</option>
				))}
			</NSelect>
			{needsValue && (
				<FilterValueInput
					fieldEntry={fieldEntry}
					op={op}
					value={value}
					onChange={setValue}
					anyYear={anyYear}
					onAnyYearToggle={handleAnyYearToggle}
					showAnyYear={showAnyYear}
					anyTime={anyTime}
					onAnyTimeToggle={handleAnyTimeToggle}
					showAnyTime={showAnyTime}
					tzLocal={tzLocal}
					onTzLocalToggle={handleTzLocalToggle}
					showTzLocal={showTzLocal}
					onYearSelect={handleYearSelect}
				/>
			)}
			{needsValue && isBetween && (
				<span className="extra-filter-builder__copy">
					<button
						type="button"
						title={t("Copy to max")}
						disabled={!value}
						onClick={() => setValue2(value)}
					>
						<Icon path={mdiArrowRight} size={12} />
					</button>
					<button
						type="button"
						title={t("Copy to min")}
						disabled={!value2}
						onClick={() => setValue(value2)}
					>
						<Icon path={mdiArrowLeft} size={12} />
					</button>
				</span>
			)}
			{isBetween && (
				<FilterValueInput
					fieldEntry={fieldEntry}
					op={op}
					value={value2}
					onChange={setValue2}
					placeholder={t("Max")}
					anyYear={anyYear}
					anyTime={anyTime}
					tzLocal={tzLocal}
				/>
			)}
			<Button type="submit">{submitLabel}</Button>
			{onClose && <Button onClick={onClose}>{t("Cancel")}</Button>}
		</form>
	);
}

export function FilterBuilder({ mapId }: { mapId: string }) {
	return (
		<FilterForm
			persistKey={mapId}
			submitLabel={t("Add filter")}
			onSubmit={(field, op, value, value2, tzLocal) =>
				void addSelections([{ type: "Filter", field, op, value, value2, tzLocal }])
			}
		/>
	);
}
