import { useState } from "react";
import {
	Dialog,
	DialogActions,
	DialogContent,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";
import { DiffCounts } from "@/components/primitives/DiffCounts";
import { EmptyState } from "@/components/primitives/Sidebar";
import { useMapState, checkoutCommit } from "@/store/useMapStore";
import { beginCommitDiffPreview } from "@/store/commitDiff";
import { cmd } from "@/lib/commands";
import { useAsync } from "@/lib/hooks/useAsync";
import type { CommitInfo } from "@/bindings.gen";
import { t } from "@/lib/i18n";
import { fmt, dateTimeFmt } from "@/lib/util/format";

export function VersionHistory({ open, onOpenChange }: DialogProps) {
	const map = useMapState((s) => s.map);
	const [restoring, setRestoring] = useState<string | null>(null);
	const { data: commits } = useAsync(() => (map ? cmd.storeListCommits(map.id) : null), [map?.id]);

	if (!map || !commits) return null;

	const viewDiff = async (commit: CommitInfo) => {
		await beginCommitDiffPreview(commit);
		onOpenChange(false);
	};

	const restore = async (commit: CommitInfo) => {
		setRestoring(commit.id);
		await checkoutCommit(commit.id);
		setRestoring(null);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Version history")} size="xl">
				{commits.length === 0 ? (
					<>
						<EmptyState>
							{t("No commits yet. Press Commit to create your first version.")}
						</EmptyState>
						<DialogActions cancel={{ label: t("Close") }} />
					</>
				) : (
					<table className="data-table">
						<thead>
							<tr>
								<th>{t("Date")}</th>
								<th>{t("Hash")}</th>
								<th className="data-table__fill">{t("Changes")}</th>
								<th className="data-table__num">{t("Locations")}</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{commits.map((c, i) => {
								const hasDiff = c.added > 0 || c.removed > 0 || c.modified > 0;
								return (
									<tr
										key={c.id}
										className={hasDiff ? "data-table__row--link" : undefined}
										onClick={hasDiff ? () => void viewDiff(c) : undefined}
										title={hasDiff ? t("View changes on the map") : undefined}
									>
										<td className="mono">{dateTimeFmt.format(new Date(c.createdAt))}</td>
										<td className="mono text-muted">{c.id.slice(0, 7)}</td>
										<td className={hasDiff || c.message ? undefined : "text-muted"}>
											{c.message}
											{c.message && hasDiff && " "}
											{hasDiff ? (
												<DiffCounts
													added={c.added}
													removed={c.removed}
													modified={c.modified}
													hideZero
												/>
											) : (
												!c.message && (i === 0 ? t("(latest)") : t("(no changes)"))
											)}
										</td>
										<td className="mono data-table__num">{fmt.format(c.locationCount)}</td>
										<td>
											<ConfirmButton
												small
												disabled={restoring !== null}
												onConfirm={() => void restore(c)}
											>
												{restoring === c.id
													? t("Restoring...")
													: i === 0
														? t("Revert")
														: t("Restore")}
											</ConfirmButton>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</DialogContent>
		</Dialog>
	);
}
