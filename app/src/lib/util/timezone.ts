import { useMemo } from "react";
import tzlookup from "@photostructure/tz-lookup";
import type { ExtraFieldType, Selector } from "@/bindings.gen";
import { countIn } from "@/store/useMapStore";
import { buildSelection } from "@/store/selections";
import { t } from "@/lib/i18n";

export function resolveTimezone(lat: number, lng: number): string {
	return tzlookup(lat, lng);
}

export function useTimezone(lat: number, lng: number, enabled: boolean): string | null {
	return useMemo(() => (enabled ? tzlookup(lat, lng) : null), [lat, lng, enabled]);
}

export async function countMissingTimezone(
	selector: Selector,
	field: string,
	fieldType: ExtraFieldType,
	tzLocal: boolean,
): Promise<number> {
	if (!tzLocal || fieldType !== "date") return 0;
	const parts: Selector[] = [
		selector,
		{ type: "Filter", field, op: "has", value: null },
		{ type: "Filter", field: "timezone", op: "nothas", value: null },
	];
	return countIn({ type: "Intersection", selections: parts.map(buildSelection) });
}

export function missingTimezoneMessage(n: number): string {
	return t(
		{
			one: "{n} location skipped: no timezone. Enrich timezones, or set the date timezone to UTC.",
			other: "{n} locations skipped: no timezone. Enrich timezones, or set the date timezone to UTC.",
		},
		{ n },
	);
}
