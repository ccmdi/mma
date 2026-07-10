import { useState, useEffect, useCallback, useRef } from "react";
import type { Location } from "@/bindings.gen";
import { Sidebar, SegmentedControl } from "@/components/primitives/Sidebar";
import { cmd } from "@/lib/commands";
import { getSettings } from "@/store/settings";
import { fetchAllLocations } from "@/store/useMapStore";
import { subscribeMany, LOCATION_DATA_EVENTS } from "@/lib/events";
import { usePluginState, createPluginStorage } from "@/plugins/registry";
import "./distribution.css";

type Source = "coords" | "metadata";

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

function getCountryName(code: string): string {
	try {
		return countryNames.of(code) ?? code;
	} catch {
		return code;
	}
}

interface CountryEntry {
	code: string;
	name: string;
	count: number;
}

function computeDistribution(locations: Location[]): { entries: CountryEntry[]; unknown: number } {
	const counts = new Map<string, number>();
	let unknown = 0;

	for (const loc of locations) {
		const code = loc.extra?.countryCode as string | undefined;
		if (code) {
			counts.set(code, (counts.get(code) ?? 0) + 1);
		} else {
			unknown++;
		}
	}

	const entries: CountryEntry[] = [];
	for (const [code, count] of counts) {
		entries.push({ code, name: getCountryName(code), count });
	}
	entries.sort((a, b) => b.count - a.count);

	return { entries, unknown };
}

export function DistributionSidebar({ onClose }: { onClose: () => void }) {
	const [entries, setEntries] = useState<CountryEntry[]>([]);
	const [unknown, setUnknown] = useState(0);
	const [total, setTotal] = useState(0);
	const [source, setSource] = usePluginState<Source>("distribution", "source", "coords");
	const [metaAvailable, setMetaAvailable] = useState(false);
	// A persisted choice counts as already defaulted — don't auto-flip it.
	const autoDefaulted = useRef(createPluginStorage("distribution").keys().includes("source"));

	const refresh = useCallback(async () => {
		const map = MMA.getCurrentMap();
		if (!map) return;
		const locs = await fetchAllLocations();
		setTotal(locs.length);

		const meta = computeDistribution(locs);
		const hasMeta = locs.length > 0 && meta.unknown < locs.length;
		setMetaAvailable(hasMeta);

		// One-time: prefer enriched metadata when it's actually present, else stay on
		// coordinates (offline geocoder) so the view works with zero enrichment.
		let active = source;
		if (!autoDefaulted.current) {
			autoDefaulted.current = true;
			if (hasMeta) {
				active = "metadata";
				setSource("metadata");
			}
		}
		if (active === "metadata" && !hasMeta) active = "coords";

		if (active === "metadata") {
			setEntries(meta.entries);
			setUnknown(meta.unknown);
		} else {
			const counts = await cmd.storeCountryDistribution(getSettings().borderDetail);
			setEntries(
				counts
					.map(([code, count]) => ({ code, name: getCountryName(code), count }))
					.sort((a, b) => b.count - a.count),
			);
			setUnknown(0);
		}
	}, [source, setSource]);

	useEffect(() => {
		refresh();
		return subscribeMany(LOCATION_DATA_EVENTS, refresh);
	}, [refresh]);

	const maxCount = entries.length > 0 ? entries[0].count : 1;

	return (
		<Sidebar title="Distribution" onBack={onClose} className="distribution-sidebar">
			<SegmentedControl<Source>
				value={metaAvailable ? source : "coords"}
				onChange={setSource}
				options={[
					{ value: "coords", label: "Coordinates" },
					{
						value: "metadata",
						label: "Metadata",
						disabled: !metaAvailable,
						title: metaAvailable ? undefined : "Enrich metadata fields to enable",
					},
				]}
			/>
			<div className="distribution-sidebar__summary">
				{total} location{total !== 1 ? "s" : ""} across {entries.length} countr
				{entries.length !== 1 ? "ies" : "y"}
				{unknown > 0 && (
					<span className="distribution-sidebar__unknown"> ({unknown} without country data)</span>
				)}
			</div>

			<div className="distribution-sidebar__list">
				{entries.map((e) => (
					<div key={e.code} className="distribution-row">
						<div className="distribution-row__label">
							<span className="distribution-row__name">
								<img
									src={`/flags/${e.code.toUpperCase()}.svg`}
									alt={e.code}
									width={20}
									height={15}
									style={{ borderRadius: 2, flexShrink: 0 }}
								/>
								{e.name}
							</span>
							<span className="distribution-row__count">{e.count}</span>
						</div>
						<div className="distribution-row__bar-track">
							<div
								className="distribution-row__bar-fill"
								style={{ width: `${(e.count / maxCount) * 100}%` }}
							/>
						</div>
					</div>
				))}
			</div>
		</Sidebar>
	);
}
