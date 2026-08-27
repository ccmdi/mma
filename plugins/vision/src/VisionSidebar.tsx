import { useState } from "react";
import type { Location } from "mma-plugin-types";
import { embed, searchText } from "./sidecar";

const { Sidebar, Field, TextInput, Button } = MMA.ui;

/** Top of the confidence slider, and so the scale every score is drawn against. */
const MAX_SCORE = 0.3;

const CSS = `
.vision-sidebar__body { padding: 8px 12px; display: flex; flex-direction: column; gap: 10px; }
.vision-sidebar__progress { font-size: 12px; color: var(--text-secondary, #999); padding: 4px 0; }
.vision-sidebar__error { font-size: 12px; color: #e55; padding: 4px 0; }
.vision-sidebar__actions { display: flex; gap: 6px; margin-top: 4px; }

.vision-result { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px; background: var(--surface-1, #2d2d28); }
.vision-result__headline { font-size: 13px; }
.vision-result__count { font-size: 15px; font-weight: 600; }
.vision-result__note { font-size: 11px; color: var(--text-secondary, #999); }
.vision-result__warn { font-size: 11px; color: #eaa; }
.vision-meter { position: relative; height: 6px; border-radius: 3px; background: var(--surface-3, #403f38); }
.vision-meter__fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--accent, #1098ad); }
.vision-meter__cut { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--text-1, #f4f3ef); }
.vision-scale { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-secondary, #999); }
`;

interface Outcome {
	/** Matches whose pano is in the open map, and so actually selected. */
	selected: number;
	/** Matches whose pano belongs to another map: the embed cache spans all of them. */
	elsewhere: number;
	/** Best score in the corpus for this query, threshold or no threshold. */
	top: number | null;
	/** The threshold this run used, so the readout still explains itself afterwards. */
	cut: number;
	/** Panos the sidecar could not embed: the corpus covers fewer than it looks. */
	failed: number;
	/** Sidecar faults that would otherwise only reach mma.log. */
	notes: string[];
}

function panoIdToLocId(locs: Location[], panoId: string): number | null {
	const loc = locs.find((l) => l.panoId === panoId);
	return loc?.id ?? null;
}

const pct = (v: number) => `${Math.min(100, (v / MAX_SCORE) * 100)}%`;

/** Best score against the slider's own scale, with the threshold marked. Sigmoid scores
 *  for real matches sit far below the top of the slider, so seeing the cut sit past every
 *  achievable score is the fastest way to understand an empty result. */
function ScoreMeter({ top, cut }: { top: number; cut: number }) {
	return (
		<>
			<div className="vision-meter">
				<div className="vision-meter__fill" style={{ width: pct(top) }} />
				<div className="vision-meter__cut" style={{ left: pct(cut) }} />
			</div>
			<div className="vision-scale">
				<span>best {top.toFixed(3)}</span>
				<span>cut {cut.toFixed(3)}</span>
			</div>
		</>
	);
}

function Result({ outcome }: { outcome: Outcome }) {
	const { selected, elsewhere, top, cut, failed, notes } = outcome;
	const belowCut = top !== null && top < cut;
	return (
		<div className="vision-result">
			<div className="vision-result__headline">
				{selected > 0 ? (
					<>
						<span className="vision-result__count">{selected}</span> location
						{selected === 1 ? "" : "s"} selected
					</>
				) : top === null ? (
					"Nothing in the corpus scored against that"
				) : belowCut ? (
					"No matches above the threshold"
				) : (
					"No matches in this map"
				)}
			</div>
			{top !== null && <ScoreMeter top={top} cut={cut} />}
			{elsewhere > 0 && (
				<div className="vision-result__note">
					{elsewhere} match{elsewhere === 1 ? "" : "es"} in other maps -- the embed cache spans
					every map
				</div>
			)}
			{selected === 0 && belowCut && (
				<div className="vision-result__note">Lower the threshold to reach it.</div>
			)}
			{failed > 0 && (
				<div className="vision-result__warn">
					{failed} pano{failed === 1 ? "" : "s"} failed to embed and are not in the search
				</div>
			)}
			{notes.map((n) => (
				<div className="vision-result__warn" key={n}>
					{n}
				</div>
			))}
		</div>
	);
}

export function VisionSidebar({ onClose }: { onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [threshold, setThreshold] = useState(0.01);

	const job = MMA.useJob<Outcome>(async ({ signal, report }) => {
		const q = query.trim();
		const cut = threshold;
		const locs = await MMA.fetchAllLocations();
		signal.throwIfAborted();

		const panoIds = locs.filter((l) => l.panoId).map((l) => l.panoId!);
		if (panoIds.length === 0) throw new Error("No locations with pano IDs");

		let embedded = 0;
		let failed = 0;
		const notes: string[] = [];
		const note = (line: string) => {
			if (!notes.includes(line)) notes.push(line);
		};
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
			onFailed: () => failed++,
			onDiagnostic: note,
		});
		signal.throwIfAborted();

		report(`Searching for "${q}"...`);
		const results = await searchText(q, null, cut, signal, note);
		const matchedIds = results
			.map((r) => panoIdToLocId(locs, r.panoId))
			.filter((id): id is number => id != null);

		if (matchedIds.length > 0) {
			await MMA.addSelections([
				{ type: "Locations", locations: matchedIds, name: `Vision: "${q}"` },
			]);
		}
		// When the threshold filtered everything out there is no score left to report, so
		// ask for the single best regardless of it.
		const top = results[0]?.score ?? (await searchText(q, 1, null, signal, note))[0]?.score ?? null;
		return {
			selected: matchedIds.length,
			elsewhere: results.length - matchedIds.length,
			top,
			cut,
			failed,
			notes,
		};
	});

	return (
		<Sidebar title="Vision" onBack={onClose}>
			<style>{CSS}</style>
			<div className="vision-sidebar__body">
				<Field label="Search for">
					<TextInput
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
						max={MAX_SCORE}
						step={0.005}
						value={threshold}
						onChange={(e) => setThreshold(Number(e.target.value))}
						style={{ width: "100%" }}
					/>
				</Field>
				<div className="vision-sidebar__actions">
					{!job.running ? (
						<Button variant="primary" disabled={!query.trim()} onClick={job.run}>
							Search
						</Button>
					) : (
						<Button onClick={job.cancel}>Cancel</Button>
					)}
				</div>

				{job.progress && <div className="vision-sidebar__progress">{job.progress}</div>}
				{job.error && <div className="vision-sidebar__error">{job.error}</div>}
				{job.result !== null && !job.running && <Result outcome={job.result} />}
			</div>
		</Sidebar>
	);
}
