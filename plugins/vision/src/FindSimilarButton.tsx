import { embed, searchImage } from "./sidecar";

const { Button } = MMA.ui;

const SIMILARITY_THRESHOLD = 0.85;

const statusStyle = { fontSize: 12, color: "var(--text-secondary, #999)", padding: "4px 0" };

export function FindSimilarButton() {
	const active = MMA.getMapState().activeLocation;
	const panoId = active?.panoId;

	const job = MMA.useJob<number>(async ({ signal, report }) => {
		const locs = await MMA.fetchAllLocations();
		signal.throwIfAborted();
		const panoIds = locs.filter((l) => l.panoId).map((l) => l.panoId!);

		let embedded = 0;
		let failed = 0;
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
		});
		signal.throwIfAborted();

		report(
			failed > 0 ? `Comparing... (${failed} pano${failed === 1 ? "" : "s"} failed to embed)` : "Comparing...",
		);
		const results = await searchImage(panoId!, null, SIMILARITY_THRESHOLD);
		const matchedIds = results
			.map((r) => locs.find((l) => l.panoId === r.panoId)?.id)
			.filter((id): id is number => id != null);

		if (matchedIds.length > 0) {
			await MMA.addSelections([
				{
					type: "Locations",
					locations: matchedIds,
					name: `Similar to ${panoId!.slice(0, 8)}...`,
				},
			]);
		}
		return matchedIds.length;
	});

	if (!panoId) return null;

	return (
		<>
			<Button
				small
				style={{ width: "100%" }}
				onClick={job.running ? job.cancel : job.run}
			>
				{job.running ? "Cancel" : "Find similar panos"}
			</Button>
			{job.progress && <div style={statusStyle}>{job.progress}</div>}
			{job.error && <div style={{ ...statusStyle, color: "#e55" }}>{job.error}</div>}
			{job.result !== null && !job.running && (
				<div style={statusStyle}>
					{job.result > 0 ? `${job.result} similar` : "No similar panos found"}
				</div>
			)}
		</>
	);
}
