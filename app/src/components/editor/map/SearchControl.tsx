import { useState, useCallback } from "react";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { parseCoordinates } from "@/lib/data/importExport";
import { cmd } from "@/lib/commands";
import type { ParsedLocation } from "@/bindings.gen";
import type { LatLng } from "@/types";
import { t } from "@/lib/i18n";
import { latest } from "@/lib/util/latest";
import { log } from "@/lib/util/log";
import { delay } from "@/lib/util/concurrent";

type PlaceResult = LatLng & {
	name: string;
};

export function SearchControl({
	onResult,
	onAddLocation,
}: {
	onResult: (lat: number, lng: number, name: string) => void;
	onAddLocation: (parsed: ParsedLocation) => void | Promise<void>;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PlaceResult[]>([]);
	const [lookups] = useState(() =>
		latest<PlaceResult[]>({
			publish: setResults,
			failed: (error) => log.debug("[search] place lookup failed:", error),
		}),
	);

	const search = useCallback(
		(q: string) =>
			void lookups.replace(async (signal) => {
				if (q.length < 3) return [];
				await delay(300, signal);
				const res = await fetch(
					`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
					{ headers: { "Accept-Language": "en" }, signal },
				);
				if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
				const data: { display_name: string; lat: string; lon: string }[] = await res.json();
				return data.map((r) => ({
					name: r.display_name,
					lat: parseFloat(r.lat),
					lng: parseFloat(r.lon),
				}));
			}),
		[lookups],
	);

	// a Maps URL or coordinate resolves to a location, otherwise default geocode
	const resolveOrSearch = useCallback(
		async (q: string) => {
			const parsed = (await cmd.parseMapsUrl(q)) ?? parseCoordinates(q);
			if (parsed) {
				lookups.cancel();
				setResults([]);
				setQuery("");
				await onAddLocation(parsed);
				return;
			}
			search(q);
		},
		[lookups, search, onAddLocation],
	);

	const primaryOf = (name: string) => name.split(",")[0].trim();

	return (
		<SuggestInput
			containerClassName="map-control search-control"
			inputClassName="search-control__input"
			placeholder={t("Search for places...")}
			value={query}
			onChange={(v) => {
				setQuery(v);
				void resolveOrSearch(v);
			}}
			suggestions={results}
			getKey={(r) => `${r.lat},${r.lng},${r.name}`}
			onPick={(r) => {
				onResult(r.lat, r.lng, r.name);
				setQuery(primaryOf(r.name));
			}}
			listStyle={{ top: "40px", zIndex: 10 }}
			renderItem={(r) => {
				const parts = r.name
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				const context = parts.slice(1).join(", ");
				return (
					<>
						<strong>{parts[0]}</strong>
						{context && (
							<>
								<br />
								<span className="search-result__context truncate">{context}</span>
							</>
						)}
					</>
				);
			}}
		/>
	);
}
