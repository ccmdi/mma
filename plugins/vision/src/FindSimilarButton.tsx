import { embed, searchImage } from "./sidecar";

const {
	ui: { Button },
	getActiveLocation,
	useJob,
	fetchAllLocations,
	applySelectionUpdate,
	addSelection,
} = MMA;

const SIMILARITY_THRESHOLD = 0.85;

export function FindSimilarButton() {
	const active = getActiveLocation();
	const panoId = active?.panoId;

	const job = useJob<number, string>();
	const findSimilar = () =>
		job.run(async ({ signal, report }) => {
			const locs = await fetchAllLocations();
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
				failed > 0
					? `Comparing... (${failed} pano${failed === 1 ? "" : "s"} failed to embed)`
					: "Comparing...",
			);
			const results = await searchImage(panoId!, null, SIMILARITY_THRESHOLD);
			const matchedIds = results
				.map((r) => locs.find((l) => l.panoId === r.panoId)?.id)
				.filter((id): id is number => id != null);

			if (matchedIds.length > 0) {
				await applySelectionUpdate(
					addSelection({
						type: "Locations",
						locations: matchedIds,
						name: `Similar to ${panoId!.slice(0, 8)}...`,
					}),
				);
			}
			return matchedIds.length;
		});
	const running = job.status === "loading";
	const found = job.ok();

	if (!panoId) return null;

	return (
		<>
			<Button small className="vision-find-similar" onClick={running ? job.cancel : findSimilar}>
				{running ? "Cancel" : "Find similar panos"}
			</Button>
			{running && job.progress && <div className="vision-status">{job.progress}</div>}
			{job.status === "error" && (
				<div className="vision-status vision-status--error">{job.error.message}</div>
			)}
			{found !== null && (
				<div className="vision-status">
					{found > 0 ? `${found} similar` : "No similar panos found"}
				</div>
			)}
		</>
	);
}
