import { embed, searchImage } from "./sidecar";

const SIMILARITY_THRESHOLD = 0.85;

const statusStyle = { fontSize: 12, color: "var(--text-secondary, #999)", padding: "4px 0" };

export function FindSimilarButton() {
	const active = MMA.getMapState().activeLocation;
	const panoId = active?.panoId;

	const job = MMA.useJob<number>(async ({ signal, report }) => {
		const locs = await MMA.fetchAllLocations();
		signal.throwIfAborted();
		const panoIds = locs.filter((l) => l.panoId).map((l) => l.panoId!);

		await embed(panoIds, { signal, onStatus: report });
		signal.throwIfAborted();

		report("Comparing...");
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
			<button
				className="button button--small"
				style={{ width: "100%" }}
				onClick={job.running ? job.cancel : job.run}
			>
				{job.running ? "Cancel" : "Find similar panos"}
			</button>
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
