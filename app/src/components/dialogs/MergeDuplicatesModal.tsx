import { useState, useCallback } from "react";
import { Store } from "@/store/store";
import { Location } from "@/store/location";
import { Edit } from "@/store/edit";
import {
	Dialog,
	DialogActions,
	DialogContent,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Notice } from "@/components/primitives/Hint";
import { toast } from "@/lib/util/toast";
import { fmt, formatDistance } from "@/lib/util/format";
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

	const found = useAsync<Preview | null>(async () => {
		if (!open) return null;
		const groups = await Location.duplicateGroups(distance);
		const total = groups.reduce((n, g) => n + g.length, 0);
		const largest = groups.reduce((m, g) => Math.max(m, g.length), 0);
		return { groups: groups.length, mergedAway: total - groups.length, largest };
	}, [open, distance]);
	const preview = found.ok();

	const handleMerge = useCallback(async () => {
		setMerging(true);
		try {
			await Edit.work(
				{ type: "Everything" },
				{
					kind: "merge",
					groups: await Location.duplicateGroups(distance),
					score: Store.get().map?.settings.duplicateScore ?? null,
				},
			);
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

	const nothing = preview != null && preview.groups === 0;

	if (found.status === "loading") return null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Merge duplicates")}>
				{found.status === "error" && (
					<>
						<Notice tone="error">{found.error.message}</Notice>
						<DialogActions cancel={{ label: t("Close") }} />
					</>
				)}
				{nothing && (
					<>
						<EmptyState>
							{t("No duplicate groups within {distance}.", { distance: formatDistance(distance) })}
						</EmptyState>
						<DialogActions cancel={{ label: t("Close") }} />
					</>
				)}
				{preview != null && preview.groups > 0 && (
					<>
						<p className="modal__message">
							{t(
								{ one: "{n} group within {distance}.", other: "{n} groups within {distance}." },
								{ n: preview.groups, distance: formatDistance(distance) },
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
						<DialogActions
							cancel
							primary={{
								label: merging ? t("Merging...") : t("Merge"),
								disabled: merging,
								onClick: () => void handleMerge(),
							}}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
