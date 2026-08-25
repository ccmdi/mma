import { useState } from "react";
import type { Location } from "mma-plugin-types";
import { embed, searchText } from "./sidecar";

const { Sidebar, Field } = MMA.ui;

const CSS = `
.vision-sidebar__body { padding: 8px 12px; display: flex; flex-direction: column; gap: 10px; }
.vision-sidebar__progress { font-size: 12px; color: var(--text-secondary, #999); padding: 4px 0; }
.vision-sidebar__results { font-size: 12px; padding: 4px 0; }
.vision-sidebar__error { font-size: 12px; color: #e55; padding: 4px 0; }
.vision-sidebar__actions { display: flex; gap: 6px; margin-top: 4px; }
`;

function panoIdToLocId(locs: Location[], panoId: string): number | null {
	const loc = locs.find((l) => l.panoId === panoId);
	return loc?.id ?? null;
}

export function VisionSidebar({ onClose }: { onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [threshold, setThreshold] = useState(0.01);

	const job = MMA.useJob<number>(async ({ signal, report }) => {
		const q = query.trim();
		const locs = await MMA.fetchAllLocations();
		signal.throwIfAborted();

		const panoIds = locs.filter((l) => l.panoId).map((l) => l.panoId!);
		if (panoIds.length === 0) throw new Error("No locations with pano IDs");

		let embedded = 0;
		const start = Date.now();
		await embed(panoIds, {
			signal,
			onStatus: report,
			onUnit: (count) => {
				embedded += count;
				const elapsed = (Date.now() - start) / 1000;
				const rate = elapsed > 0.5 ? (embedded / elapsed).toFixed(1) : "--";
				report(`Embedding: ${embedded}/${panoIds.length} (${rate} panos/s)`);
			},
		});
		signal.throwIfAborted();

		report(`Searching for "${q}"...`);
		const results = await searchText(q, null, threshold, signal);
		const matchedIds = results
			.map((r) => panoIdToLocId(locs, r.panoId))
			.filter((id): id is number => id != null);

		if (matchedIds.length > 0) {
			await MMA.addSelections([
				{ type: "Locations", locations: matchedIds, name: `Vision: "${q}"` },
			]);
		}
		return matchedIds.length;
	});

	return (
		<Sidebar title="Vision" onBack={onClose}>
			<style>{CSS}</style>
			<div className="vision-sidebar__body">
				<Field label="Search for">
					<input
						className="input"
						placeholder="cars, snow, indoor..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !job.running && query.trim()) job.run();
						}}
					/>
				</Field>
				<Field label={`Min confidence: ${threshold.toFixed(3)}`}>
					<input
						type="range"
						min={0}
						max={0.3}
						step={0.005}
						value={threshold}
						onChange={(e) => setThreshold(Number(e.target.value))}
						style={{ width: "100%" }}
					/>
				</Field>
				<div className="vision-sidebar__actions">
					{!job.running ? (
						<button
							className="button button--primary"
							disabled={!query.trim()}
							onClick={job.run}
						>
							Search
						</button>
					) : (
						<button className="button" onClick={job.cancel}>Cancel</button>
					)}
				</div>

				{job.progress && <div className="vision-sidebar__progress">{job.progress}</div>}
				{job.error && <div className="vision-sidebar__error">{job.error}</div>}
				{job.result !== null && !job.running && (
					<div className="vision-sidebar__results">{job.result} locations selected</div>
				)}
			</div>
		</Sidebar>
	);
}
