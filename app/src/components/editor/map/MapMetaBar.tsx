import { useState, useCallback } from "react";
import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { History } from "@/store/history";
import { Commit } from "@/store/commit";
import { useDialog, useDialogState } from "@/store/dialogBus";
import { CommitDialog } from "@/components/dialogs/CommitDialog";
import { CommitDiff } from "@/store/commitDiff";
import { Import } from "@/store/import";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ExportDialog } from "@/components/dialogs/ExportDialog";
import { VersionHistory } from "@/components/dialogs/VersionHistory";
import { SeenDialog } from "@/components/dialogs/SeenDialog";
import { CopyToMapDialog } from "@/components/editor/CopyToMapDialog";
import { QuickCopyToMapDialog } from "@/components/editor/QuickCopyToMapDialog";
import { SaveAsDialog } from "@/components/editor/SaveAsDialog";
import { Seen } from "@/lib/seen/seen";
import { usePano } from "@/lib/hooks/usePano";
import { Button } from "@/components/primitives/Button";
import { DiffCounts } from "@/components/primitives/DiffCounts";
import { mdiUndo, mdiRedo } from "@mdi/js";
import { fmt } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";

function LocationTotal() {
	const locationCount = Store.use((s) => s.locationCount);
	return (
		<span className="map-meta__total truncate">
			<span className="mono">{fmt.format(locationCount)}</span> locations
		</span>
	);
}

function CommitControls() {
	const diff = CommitDiff.use();
	const hasDiff = CommitDiff.has();
	const [showCommit, setShowCommit] = useState(false);
	const requestCommit = useCallback((e?: React.MouseEvent) => {
		if (e?.shiftKey) setShowCommit(true);
		else void Commit.create();
	}, []);
	useDialog("commit", () => CommitDiff.has() && requestCommit());
	return (
		<>
			<Button variant="primary" disabled={!hasDiff} onClick={requestCommit}>
				{t("Commit")}
			</Button>
			{showCommit && <CommitDialog open onOpenChange={setShowCommit} />}
			{hasDiff && <DiffCounts {...diff} />}
		</>
	);
}

function UndoRedoControls() {
	const canUndo = Store.use((s) => History.available(s.history, "undo"));
	const canRedo = Store.use((s) => History.available(s.history, "redo"));
	return (
		<>
			<IconButton
				icon={mdiUndo}
				label={t("Undo")}
				disabled={!canUndo}
				onClick={() => void History.undo()}
			/>
			<IconButton
				icon={mdiRedo}
				label={t("Redo")}
				disabled={!canRedo}
				onClick={() => void History.redo()}
			/>
		</>
	);
}

export function MapMetaBar() {
	const map = Store.use((s) => s.map);
	const pano = usePano();
	const [showExport, setShowExport] = useDialogState("export");
	const [showHistory, setShowHistory] = useDialogState("history");
	const [showSeen, setShowSeen] = useDialogState("seen");
	const [showCopyToMap, setShowCopyToMap] = useDialogState("copy-to-map");
	const [showSaveAs, setShowSaveAs] = useDialogState("save-as");
	const [quickCopyId, setQuickCopyId] = useState<number | null>(null);

	const importFile = useCallback(async () => {
		const path = await openFileDialog({
			multiple: false,
			filters: [{ name: t("Map data"), extensions: ["json", "csv"] }],
		});
		if (!path || typeof path !== "string") return;
		await Import.fromPath(path);
	}, []);
	useDialog("import", () => void importFile());
	useDialog("quick-copy-to-map", (id) => setQuickCopyId(id));

	if (!map) return null;

	const versioned = !Maps.isReserved(map.id);

	return (
		<>
			<LocationTotal />
			<span className="map-meta__actions">
				{versioned && <CommitControls />}
				<UndoRedoControls />
			</span>
			<span className="map-meta__spacer"></span>
			<div className="map-meta__import">
				<Button onClick={() => setShowSeen(true)}>{t("Seen")}</Button>
				{versioned && <Button onClick={() => setShowHistory(true)}>{t("History")}</Button>}
				<Button onClick={() => void importFile()}>{t("Import file")}</Button>
				<Button onClick={() => setShowExport(true)}>{t("Export")}</Button>
			</div>
			{showExport && <ExportDialog open onOpenChange={setShowExport} />}
			{versioned && showHistory && <VersionHistory open onOpenChange={setShowHistory} />}
			{showSeen && (
				<SeenDialog
					open
					onOpenChange={setShowSeen}
					onLoadPano={(entry) => void Seen.loadPano(entry, pano)}
				/>
			)}
			{showCopyToMap && <CopyToMapDialog open onOpenChange={setShowCopyToMap} />}
			{showSaveAs && <SaveAsDialog open onOpenChange={setShowSaveAs} />}
			{quickCopyId != null && (
				<QuickCopyToMapDialog
					open
					onOpenChange={(open) => !open && setQuickCopyId(null)}
					locationId={quickCopyId}
				/>
			)}
		</>
	);
}
