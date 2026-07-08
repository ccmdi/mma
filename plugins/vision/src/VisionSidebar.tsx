import { useState, useCallback, useRef, useEffect } from "react";
import type { Location } from "mma-plugin-types";
import { spawnEmbed, spawnTextSearch } from "./sidecar";

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
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState("");
	const [error, setError] = useState("");
	const [resultCount, setResultCount] = useState<number | null>(null);
	const cancelledRef = useRef(false);
	const killRef = useRef<(() => void) | null>(null);

	const run = useCallback(async () => {
		const q = query.trim();
		if (!q) return;
		setRunning(true);
		setError("");
		setResultCount(null);
		cancelledRef.current = false;

		try {
			const locs = await MMA.fetchAllLocations();
			if (cancelledRef.current) return;
			const panoIds = locs.filter((l) => l.panoId).map((l) => l.panoId!);
			if (panoIds.length === 0) { setError("No locations with pano IDs"); return; }

			setProgress(`Embedding ${panoIds.length} panos (cached skip)...`);
			let embedDone = 0;
			const embedStart = Date.now();
			const { process: embedProc, done: embedWhen } = await spawnEmbed(panoIds, setProgress);
			killRef.current = () => embedProc.kill();
			embedProc.onStderr((line) => {
				if (line.startsWith("[vision]")) setProgress(line);
			});
			embedProc.onLine((line) => {
				try {
					const r = JSON.parse(line);
					if (r.status === "cache_hit") {
						embedDone += r.count ?? 1;
					} else {
						embedDone++;
					}
					const elapsed = (Date.now() - embedStart) / 1000;
					const rate = elapsed > 0.5 ? (embedDone / elapsed).toFixed(1) : "--";
					setProgress(`Embedding: ${embedDone}/${panoIds.length} (${rate} panos/s)`);
				} catch {}
			});
			await embedWhen;
			if (cancelledRef.current) return;

			setProgress(`Searching for "${q}"...`);
			const { process: searchProc, done: searchDone } = await spawnTextSearch(q, null, threshold);
			killRef.current = () => searchProc.kill();

			let results: { panoId: string; score: number }[] = [];
			searchProc.onLine((line) => {
				try {
					const r = JSON.parse(line);
					if (r.results) results = r.results;
				} catch {}
			});
			await searchDone;
			if (cancelledRef.current) return;

			killRef.current = null;
			const matchedIds = results
				.map((r) => panoIdToLocId(locs, r.panoId))
				.filter((id): id is number => id != null);

			if (matchedIds.length > 0) {
				await MMA.addSelections([{ type: "Locations", locations: matchedIds, name: `Vision: "${q}"` }]);
			}
			setResultCount(matchedIds.length);
			setProgress("");
		} catch (e) {
			if (!cancelledRef.current) setError(String(e));
		} finally {
			setRunning(false);
		}
	}, [query, threshold]);

	const cancel = useCallback(() => {
		cancelledRef.current = true;
		killRef.current?.();
		killRef.current = null;
		setRunning(false);
		setProgress("");
	}, []);

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
						onKeyDown={(e) => { if (e.key === "Enter" && !running) run(); }}
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
					{!running ? (
						<button className="button button--primary" disabled={!query.trim()} onClick={run}>
							Search
						</button>
					) : (
						<button className="button" onClick={cancel}>Cancel</button>
					)}
				</div>

				{progress && <div className="vision-sidebar__progress">{progress}</div>}
				{error && <div className="vision-sidebar__error">{error}</div>}
				{resultCount !== null && !running && (
					<div className="vision-sidebar__results">{resultCount} locations selected</div>
				)}
			</div>
		</Sidebar>
	);
}
