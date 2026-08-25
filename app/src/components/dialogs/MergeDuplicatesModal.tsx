import { useState, useCallback } from "react";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { previewDuplicateGroups, mergeDuplicates } from "@/store/useMapStore";
import { toast } from "@/lib/util/toast";
import { fmt } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { useAsync } from "@/lib/hooks/useAsync";
import { t } from "@/lib/i18n";

interface Props extends DialogProps {
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
				t("Merged {merged} duplicates into {groups} locations", {
					merged: fmt.format(preview?.mergedAway ?? 0),
					groups: fmt.format(preview?.groups ?? 0),
				}),
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
			<DialogContent title={t("Merge duplicates")} className="merge-duplicates">
				{loading && (
					<div className="merge-duplicates__loading">
						<div className="merge-duplicates__spinner" />
					</div>
				)}
				{nothing && (
					<p className="merge-duplicates__status">
						{t("No duplicate groups within {distance}m.", { distance })}
					</p>
				)}
				{!loading && preview != null && preview.groups > 0 && (
					<>
						<p className="merge-duplicates__status">
							{t(
								{ one: "{n} group within {distance}m.", other: "{n} groups within {distance}m." },
								{ n: preview.groups, distance },
							)}{" "}
							{t(
								{
									one: "Merging removes {n} location, keeping one survivor each (tags combined).",
									other:
										"Merging removes {n} locations, keeping one survivor each (tags combined).",
								},
								{ n: preview.mergedAway },
							)}{" "}
							{t("Largest group: {n}.", { n: preview.largest })}
						</p>
						<div className="merge-duplicates__actions">
							<Button onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
							<Button variant="primary" onClick={() => void handleMerge()} disabled={merging}>
								{merging ? t("Merging...") : t("Merge")}
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
