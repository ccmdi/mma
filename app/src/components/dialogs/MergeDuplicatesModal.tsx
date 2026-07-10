import { useState, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { previewDuplicateGroups, mergeDuplicates } from "@/store/useMapStore";
import { toast } from "@/lib/util/toast";
import { fmt } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { useAsync } from "@/lib/hooks/useAsync";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	distance: number;
}

interface Preview {
	groups: number;
	mergedAway: number;
	largest: number;
}

export function MergeDuplicatesModal({ open, onOpenChange, distance }: Props) {
	const [merging, setMerging] = useState(false);

	const { data: preview, loading } = useAsync<Preview | null>(async () => {
		if (!open) return null;
		try {
			const groups = await previewDuplicateGroups(distance);
			const total = groups.reduce((n, g) => n + g.length, 0);
			const largest = groups.reduce((m, g) => Math.max(m, g.length), 0);
			return { groups: groups.length, mergedAway: total - groups.length, largest };
		} catch (e) {
			log.error("[merge] preview failed:", e);
			return null;
		}
	}, [open, distance]);

	const handleMerge = useCallback(async () => {
		setMerging(true);
		try {
			await mergeDuplicates(distance);
			toast(
				`Merged ${fmt.format(preview?.mergedAway ?? 0)} duplicates into ${fmt.format(preview?.groups ?? 0)} locations`,
			);
			onOpenChange(false);
		} catch (e) {
			log.error("[merge] failed:", e);
		} finally {
			setMerging(false);
		}
	}, [distance, preview, onOpenChange]);

	const nothing = !loading && preview != null && preview.groups === 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="Merge duplicates" className="merge-duplicates">
				{loading && (
					<div className="merge-duplicates__loading">
						<div className="merge-duplicates__spinner" />
					</div>
				)}
				{nothing && (
					<p className="merge-duplicates__status">No duplicate groups within {distance}m.</p>
				)}
				{!loading && preview != null && preview.groups > 0 && (
					<>
						<p className="merge-duplicates__status">
							{fmt.format(preview.groups)} group{preview.groups !== 1 ? "s" : ""} within {distance}
							m. Merging removes {fmt.format(preview.mergedAway)} location
							{preview.mergedAway !== 1 ? "s" : ""}, keeping one survivor each (tags combined).
							Largest group: {fmt.format(preview.largest)}.
						</p>
						<div className="merge-duplicates__actions">
							<button className="button" type="button" onClick={() => onOpenChange(false)}>
								Cancel
							</button>
							<button
								className="button button--primary"
								type="button"
								onClick={handleMerge}
								disabled={merging}
							>
								{merging ? "Merging..." : "Merge"}
							</button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
