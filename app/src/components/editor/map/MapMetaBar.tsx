import { useState, useCallback } from "react";
import { useDialog, useDialogState } from "@/store/dialogBus";
import { Tooltip } from "@/components/primitives/Tooltip";
import { useMapState, undo, redo, commitMap } from "@/store/useMapStore";
import { getSettings } from "@/store/settings";
import { CommitDialog } from "@/components/dialogs/CommitDialog";
import { useCommitDiff, hasCommitDiff } from "@/store/commitDiff";
import { beginImportFromPath } from "@/store/importStaging";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ExportDialog } from "@/components/dialogs/ExportDialog";
import { VersionHistory } from "@/components/dialogs/VersionHistory";
import { SeenDialog } from "@/components/dialogs/SeenDialog";
import { CopyToMapDialog } from "@/components/editor/CopyToMapDialog";
import { QuickCopyToMapDialog } from "@/components/editor/QuickCopyToMapDialog";
import { loadSeenPano } from "@/lib/sv/panoSingleton";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { mdiUndo, mdiRedo } from "@mdi/js";
import { fmt } from "@/lib/util/format";
import { t } from "@/lib/i18n";

function LocationTotal() {
	const locationCount = useMapState((s) => s.locationCount);
	return (
		<span className="map-meta__total">
			<span className="mono">{fmt.format(locationCount)}</span> locations
		</span>
	);
}

function CommitControls() {
	const diff = useCommitDiff();
	const hasDiff = hasCommitDiff();
	const [showCommit, setShowCommit] = useState(false);
	const requestCommit = useCallback(() => {
		if (getSettings().askCommitMessage) setShowCommit(true);
		else void commitMap();
	}, []);
	useDialog("commit", () => hasCommitDiff() && requestCommit());
	return (
		<>
			<Button variant="primary" disabled={!hasDiff} onClick={requestCommit}>
				{t("Commit")}
			</Button>
			{showCommit && <CommitDialog onClose={() => setShowCommit(false)} />}
			{hasDiff && (
				<span className="map-meta__count mono">
					<span className="map-meta__count--added">+{fmt.format(diff.added)}</span>{" "}
					<span className="map-meta__count--removed">-{fmt.format(diff.removed)}</span>{" "}
					<span className="map-meta__count--updated">&plusmn;{fmt.format(diff.modified)}</span>
				</span>
			)}
		</>
	);
}

function UndoRedoControls() {
	const canUndo = useMapState((s) => s.canUndo);
	const canRedo = useMapState((s) => s.canRedo);
	return (
		<>
			<Tooltip content={t("Undo")}>
				<button
					type="button"
					className="icon-button"
					disabled={!canUndo}
					style={{ color: canUndo ? undefined : "var(--text-3)" }}
					aria-label={t("Undo")}
					onClick={undo}
				>
					<Icon path={mdiUndo} />
				</button>
			</Tooltip>
			<Tooltip content={t("Redo")}>
				<button
					type="button"
					className="icon-button"
					disabled={!canRedo}
					style={{ color: canRedo ? undefined : "var(--text-3)" }}
					aria-label={t("Redo")}
					onClick={redo}
				>
					<Icon path={mdiRedo} />
				</button>
			</Tooltip>
		</>
	);
}

export function MapMetaBar() {
	const map = useMapState((s) => s.map);
	const [showExport, setShowExport] = useDialogState("export");
	const [showHistory, setShowHistory] = useDialogState("history");
	const [showSeen, setShowSeen] = useDialogState("seen");
	const [showCopyToMap, setShowCopyToMap] = useDialogState("copy-to-map");
	const [quickCopyId, setQuickCopyId] = useState<number | null>(null);

	const importFile = useCallback(async () => {
		const path = await openFileDialog({
			multiple: false,
			filters: [{ name: t("Map data"), extensions: ["json", "csv"] }],
		});
		if (!path || typeof path !== "string") return;
		await beginImportFromPath(path);
	}, []);
	useDialog("import", importFile);
	useDialog("quick-copy-to-map", (id) => setQuickCopyId(id));

	if (!map) return null;

	return (
		<>
			<LocationTotal />
			<span className="map-meta__actions">
				<CommitControls />
				<UndoRedoControls />
			</span>
			<span className="map-meta__spacer"></span>
			<div className="map-meta__import">
				<Button onClick={() => setShowSeen(true)}>{t("Seen")}</Button>
				<Button onClick={() => setShowHistory(true)}>{t("History")}</Button>
				<Button onClick={importFile}>{t("Import file")}</Button>
				<Button onClick={() => setShowExport(true)}>{t("Export")}</Button>
			</div>
			{showExport && <ExportDialog onClose={() => setShowExport(false)} />}
			{showHistory && <VersionHistory onClose={() => setShowHistory(false)} />}
			{showSeen && <SeenDialog open onOpenChange={setShowSeen} onLoadPano={loadSeenPano} />}
			{showCopyToMap && <CopyToMapDialog onClose={() => setShowCopyToMap(false)} />}
			{quickCopyId != null && (
				<QuickCopyToMapDialog locationId={quickCopyId} onClose={() => setQuickCopyId(null)} />
			)}
		</>
	);
}
