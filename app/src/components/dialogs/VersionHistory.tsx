import { useState, type ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { useMapState, checkoutCommit } from "@/store/useMapStore";
import { beginCommitDiffPreview } from "@/store/commitDiff";
import { cmd } from "@/lib/commands";
import { useAsync } from "@/lib/hooks/useAsync";
import type { CommitInfo } from "@/bindings.gen";
import { t } from "@/lib/i18n";
import { fmt, dateTimeFmt } from "@/lib/util/format";

function diffLabel(c: CommitInfo): ReactNode | null {
	const parts: ReactNode[] = [];
	if (c.added > 0)
		parts.push(
			<span key="a" style={{ color: "var(--constructive)" }}>
				+{c.added}
			</span>,
		);
	if (c.removed > 0)
		parts.push(
			<span key="r" style={{ color: "var(--destructive)" }}>
				-{c.removed}
			</span>,
		);
	if (c.modified > 0)
		parts.push(
			<span key="m" style={{ color: "var(--accent)" }}>
				~{c.modified}
			</span>,
		);
	return parts.length > 0 ? (
		<span className="mono" style={{ display: "inline-flex", gap: 6 }}>
			{parts}
		</span>
	) : null;
}

export function VersionHistory({ onClose }: { onClose: () => void }) {
	const map = useMapState((s) => s.map);
	const [restoring, setRestoring] = useState<string | null>(null);
	const [confirmingId, setConfirmingId] = useState<string | null>(null);
	const { data: commits } = useAsync(() => (map ? cmd.storeListCommits(map.id) : null), [map?.id]);

	if (!map || !commits) return null;

	const viewDiff = async (commit: CommitInfo) => {
		await beginCommitDiffPreview(commit);
		onClose();
	};

	const handleRestore = async (commit: CommitInfo) => {
		if (confirmingId !== commit.id) {
			setConfirmingId(commit.id);
			return;
		}
		setConfirmingId(null);
		setRestoring(commit.id);
		await checkoutCommit(commit.id);
		setRestoring(null);
		onClose();
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title={t("Version history")} className="version-history-modal">
				{commits.length === 0 && (
					<p className="text-muted">
						{t("No commits yet. Press Commit to create your first version.")}
					</p>
				)}
				{commits.length > 0 && (
					<div style={{ maxHeight: 400, overflowY: "auto" }}>
						<table style={{ width: "100%", borderCollapse: "collapse" }}>
							<thead>
								<tr
									style={{
										textAlign: "left",
										borderBottom: "1px solid var(--border-subtle)",
									}}
								>
									<th style={{ padding: "6px 8px" }}>{t("Date")}</th>
									<th style={{ padding: "6px 8px" }}>{t("Hash")}</th>
									<th style={{ padding: "6px 8px" }}>{t("Changes")}</th>
									<th style={{ padding: "6px 8px", textAlign: "right" }}>{t("Locations")}</th>
									<th style={{ padding: "6px 8px" }}></th>
								</tr>
							</thead>
							<tbody>
								{commits.map((c, i) => {
									const diff = diffLabel(c);
									const msg = c.message;
									const hasDiff = c.added > 0 || c.removed > 0 || c.modified > 0;
									return (
										<tr
											key={c.id}
											onClick={() => {
												if (hasDiff) void viewDiff(c);
											}}
											title={hasDiff ? t("View changes on the map") : undefined}
											style={{
												borderBottom: "1px solid var(--border-subtle)",
												cursor: hasDiff ? "pointer" : "default",
											}}
										>
											<td className="mono" style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
												{dateTimeFmt.format(new Date(c.createdAt))}
											</td>
											<td
												className="mono"
												style={{
													padding: "6px 8px",
													color: "var(--text-2)",
												}}
											>
												{c.id.slice(0, 7)}
											</td>
											<td
												style={{
													padding: "6px 8px",
													color: diff ? undefined : msg ? undefined : "var(--text-3)",
												}}
											>
												{msg}
												{msg && diff && " "}
												{diff ?? (msg ? null : i === 0 ? t("(latest)") : t("(no changes)"))}
											</td>
											<td className="mono" style={{ padding: "6px 8px", textAlign: "right" }}>
												{fmt.format(c.locationCount)}
											</td>
											<td style={{ padding: "6px 8px" }}>
												<Button
													variant={confirmingId === c.id ? "destructive" : undefined}
													disabled={restoring !== null}
													onClick={(e) => {
														e.stopPropagation();
														void handleRestore(c);
													}}
													onBlur={() => confirmingId === c.id && setConfirmingId(null)}
												>
													{restoring === c.id
														? t("Restoring...")
														: confirmingId === c.id
															? t("Are you sure?")
															: i === 0
																? t("Revert")
																: t("Restore")}
												</Button>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
