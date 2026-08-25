import { useState, useEffect, useCallback, useRef } from "react";
import { Sidebar, SegmentedControl } from "@/components/primitives/Sidebar";
import { cmd } from "@/lib/commands";
import { getSettings } from "@/store/settings";
import { countBy } from "@/store/useMapStore";
import { subscribeMany, LOCATION_DATA_EVENTS } from "@/lib/events";
import { usePluginState, createPluginStorage } from "@/plugins/registry";
import "./distribution.css";
import { t } from "@/lib/i18n";
import { countryName } from "@/lib/util/format";

type Source = "coords" | "metadata";

interface CountryEntry {
	code: string;
	name: string;
	count: number;
}

/** Country counts from the enriched `countryCode` field, grouped in Rust. `unknown` is
 *  whatever the grouping didn't account for. */
function toDistribution(
	counts: [string, number][],
	total: number,
): { entries: CountryEntry[]; unknown: number } {
	const entries = counts
		.map(([code, count]) => ({ code, name: countryName(code), count }))
		.sort((a, b) => b.count - a.count);
	const known = entries.reduce((sum, e) => sum + e.count, 0);
	return { entries, unknown: total - known };
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
		const map = MMA.getMapState().map;
		if (!map) return;
		const count = MMA.getMapState().locationCount;
		setTotal(count);

		const meta = toDistribution(
			await countBy({ kind: "all" }, "countryCode", { kind: "value" }),
			count,
		);
		const hasMeta = count > 0 && meta.unknown < count;
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
			const counts = await cmd.storeCountryDistribution(
				{ kind: "all" },
				getSettings().borderDetail,
			);
			setEntries(
				counts
					.map(([code, count]) => ({ code, name: countryName(code), count }))
					.sort((a, b) => b.count - a.count),
			);
			setUnknown(0);
		}
	}, [source, setSource]);

	useEffect(() => {
		const run = () => void refresh();
		run();
		return subscribeMany(LOCATION_DATA_EVENTS, run);
	}, [refresh]);

	const maxCount = entries.length > 0 ? entries[0].count : 1;

	return (
		<Sidebar title={t("Distribution")} onBack={onClose} className="distribution-sidebar">
			<SegmentedControl<Source>
				value={metaAvailable ? source : "coords"}
				onChange={setSource}
				options={[
					{ value: "coords", label: t("Coordinates") },
					{
						value: "metadata",
						label: t("Metadata"),
						disabled: !metaAvailable,
						title: metaAvailable ? undefined : t("Enrich metadata fields to enable"),
					},
				]}
			/>
			<div className="distribution-sidebar__summary">
				{t({ one: "{n} location", other: "{n} locations" }, { n: total })}{" "}
				{t({ one: "across {n} country", other: "across {n} countries" }, { n: entries.length })}
				{unknown > 0 && (
					<span className="distribution-sidebar__unknown">
						{" "}
						{t("({n} without country data)", { n: unknown })}
					</span>
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
