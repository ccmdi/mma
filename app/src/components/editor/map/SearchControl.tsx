import { useState, useCallback, useRef } from "react";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { parseMapsUrl, parseCoordinates, type ParsedLocation } from "@/lib/data/importExport";
import type { LatLng } from "@/types";
import { t } from "@/lib/i18n";

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
	const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const acRef = useRef<AbortController>(undefined);

	const search = useCallback((q: string) => {
		if (q.length < 3) {
			setResults([]);
			return;
		}
		clearTimeout(timerRef.current);
		// Debouncing alone can't order responses: two queries typed 300ms apart both go out
		// and Nominatim may answer them out of order.
		acRef.current?.abort();
		const ac = (acRef.current = new AbortController());
		timerRef.current = setTimeout(
			() =>
				void (async () => {
					try {
						const res = await fetch(
							`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
							{ headers: { "Accept-Language": "en" }, signal: ac.signal },
						);
						if (!res.ok) return;
						const data = await res.json();
						setResults(
							data.map((r: { display_name: string; lat: string; lon: string }) => ({
								name: r.display_name,
								lat: parseFloat(r.lat),
								lng: parseFloat(r.lon),
							})),
						);
					} catch {
						// A failed lookup shows no results.
					}
				})(),
			300,
		);
	}, []);

	// a Maps URL or coordinate resolves to a location, otherwise default geocode
	const resolveOrSearch = useCallback(
		async (q: string) => {
			const parsed = (await parseMapsUrl(q)) ?? parseCoordinates(q);
			if (parsed) {
				clearTimeout(timerRef.current);
				setResults([]);
				setQuery("");
				await onAddLocation(parsed);
				return;
			}
			search(q);
		},
		[search, onAddLocation],
	);

	const primaryOf = (name: string) => name.split(",")[0].trim();

	return (
		<SuggestInput
			containerClassName="map-control search-control"
			inputClassName="search-control__input"
			placeholder={t("Search for places…")}
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
								<span className="search-result__context">{context}</span>
							</>
						)}
					</>
				);
			}}
		/>
	);
}
