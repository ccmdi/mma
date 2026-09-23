import type { Selector } from "@/bindings.gen";
import type { FieldType } from "@/bindings.consts";
import { cmd } from "@/lib/commands";
import { useAsync } from "@/lib/hooks/useAsync";
import { query } from "@/store/useMapStore";
import { all, has, lacks } from "@/store/selections";
import { t } from "@/lib/i18n";

export function resolveTimezone(lat: number, lng: number): Promise<string | null> {
	return cmd.timezoneAt(lat, lng);
}

export function useTimezone(lat: number, lng: number, enabled: boolean): string | null {
	return useAsync(() => (enabled ? resolveTimezone(lat, lng) : null), [lat, lng, enabled]).data;
}

export async function countMissingTimezone(
	selector: Selector,
	field: string,
	fieldType: FieldType,
	tzLocal: boolean,
): Promise<number> {
	if (!tzLocal || fieldType !== "date") return 0;
	return query(all(selector, has(field), lacks("timezone"))).count();
}

export function missingTimezoneMessage(n: number): string {
	return t(
		{
			one: "{n} location skipped: no timezone. Enrich timezones, or set the date timezone to UTC.",
			other:
				"{n} locations skipped: no timezone. Enrich timezones, or set the date timezone to UTC.",
		},
		{ n },
	);
}
