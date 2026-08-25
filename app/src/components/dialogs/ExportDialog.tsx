import { useState, useId } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Radio } from "@/components/primitives/Radio";
import { TextInput } from "@/components/primitives/TextInput";
import { useMapState, getVisibleTags } from "@/store/useMapStore";
import { selectorForPick, type SelectorPick } from "@/store/selectorPick";
import { useMapSetting } from "@/store/useMapSetting";
import { cmd } from "@/lib/commands";
import { saveExportTempFile } from "@/lib/util/tauri";
import { mmaBufUrl } from "@/lib/util/util";
import { getAllFieldDefs } from "@/lib/data/fieldDefRegistry";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import { t } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";

interface Props {
	onClose: () => void;
}

export function ExportDialog({ onClose }: Props) {
	const map = useMapState((s) => s.map);
	const selectedIds = useMapState((s) => s.selectedLocationIds);
	const locationCount = useMapState((s) => s.locationCount);
	const uid = useId();

	const [pick, setPick] = useState<SelectorPick>({ pick: "all" });
	// Derived, not stored: "the selection" has to follow the live one.
	const selector = selectorForPick(pick);
	const [saveZoom, setSaveZoom] = useMapSetting("exportZoom");
	const [saveExtras, setSaveExtras] = useMapSetting("exportExtras");
	const [bypassUnpanned, setBypassUnpanned] = useMapSetting("exportUnpanned");
	const [fileName, setFileName] = useState(map?.meta.name ?? "");
	const selCount = selectedIds.size;

	if (!map) return null;

	const baseName = fileName || map.meta.name || "export";

	const tagsJson = () => JSON.stringify(Object.fromEntries(getVisibleTags().map((t) => [t.id, t])));

	const jsonPath = () =>
		cmd.storeExportJson({
			exportZoom: saveZoom,
			exportUnpanned: bypassUnpanned,
			exportExtras: saveExtras,
			selector: selector,
			mapName: map.meta.name,
			tagsJson: tagsJson(),
			extraFieldsJson: JSON.stringify(getAllFieldDefs()),
		});
	const csvPath = () => cmd.storeExportCsv(selector);
	const geojsonPath = () => cmd.storeExportGeojson(selector, tagsJson());

	const saveToFile = (srcPath: string, ext: string) =>
		saveExportTempFile(srcPath, `${baseName}.${ext}`);

	const withFeedback = (run: () => Promise<boolean | void>, success: string) => async () => {
		try {
			const ok = await run();
			if (ok !== false) toast(success);
		} catch (e) {
			log.error("[export] failed:", e);
			toast(t("Export failed"));
		}
	};

	const copyJson = withFeedback(
		async () =>
			navigator.clipboard.writeText(await (await fetch(mmaBufUrl(await jsonPath()))).text()),
		t("Copied JSON to clipboard"),
	);
	const downloadJson = withFeedback(
		async () => saveToFile(await jsonPath(), "json"),
		t("Downloaded {file}", { file: `${baseName}.json` }),
	);

	const copyCsv = withFeedback(
		async () =>
			navigator.clipboard.writeText(await (await fetch(mmaBufUrl(await csvPath()))).text()),
		t("Copied CSV to clipboard"),
	);
	const downloadCsv = withFeedback(
		async () => saveToFile(await csvPath(), "csv"),
		t("Downloaded {file}", { file: `${baseName}.csv` }),
	);

	const downloadGeoJson = withFeedback(
		async () => saveToFile(await geojsonPath(), "geojson"),
		t("Downloaded {file}", { file: `${baseName}.geojson` }),
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title={t("Export")} className="export-modal">
				<div className="export-modal__settings">
					<div className="export-modal__filename">
						<label htmlFor={`${uid}name`}>{t("File name:")}</label>
						<TextInput
							id={`${uid}name`}
							type="text"
							name="name"
							value={fileName}
							onChange={(e) => setFileName(e.target.value)}
							autoFocus
						/>
					</div>
					<div className="export-modal__fieldset">
						<label>
							<Radio
								name="selection"
								value="all"
								checked={pick.pick === "all"}
								onChange={() => setPick({ pick: "all" })}
							/>
							{t(
								{
									one: "Export everything ({n} location)",
									other: "Export everything ({n} locations)",
								},
								{ n: locationCount },
							)}
						</label>
						<label>
							<Radio
								name="selection"
								value="selected"
								checked={pick.pick === "selection"}
								onChange={() => setPick({ pick: "selection" })}
								disabled={selCount === 0}
							/>
							<span style={selCount === 0 ? { opacity: 0.7 } : undefined}>
								{t(
									{
										one: "Export selection ({n} location)",
										other: "Export selection ({n} locations)",
									},
									{ n: selCount },
								)}
							</span>
						</label>
					</div>
					<div className="export-modal__fieldset">
						<label>
							<Checkbox
								name="zoom"
								checked={saveZoom}
								onChange={(e) => setSaveZoom(e.target.checked)}
							/>

							{t("Save zoom levels")}
						</label>
						<label>
							<Checkbox
								name="extras"
								checked={saveExtras}
								onChange={(e) => setSaveExtras(e.target.checked)}
							/>

							{t("Save app data")}
							<br />
							<small className="export-modal__help">
								{t(
									"Include app-specific data like tags. Not including this makes the file smaller,\n\t\t\t\t\t\t\t\twhich can help when uploading maps with 100K+ locations to GeoGuessr.",
								)}
							</small>
						</label>
						<label>
							<Checkbox
								name="unpanned"
								checked={bypassUnpanned}
								onChange={(e) => setBypassUnpanned(e.target.checked)}
							/>

							{t("Bypass GeoGuessr auto-panning for locations with 0 heading")}
							<br />
							<small className="export-modal__help">
								{t(
									"GeoGuessr auto-pans locations that point straight north along the road. To keep your\n\t\t\t\t\t\t\t\tunpanned locations unpanned, enable this option.",
								)}
							</small>
						</label>
					</div>
				</div>
				<div className="export-modal__formats">
					<div className="export-modal__format">
						<h3 className="export-modal__subhead">{t("As JSON (recommended)")}</h3>
						<div className="export-modal__export-buttons">
							<Button
								onClick={() => void copyJson()}
								disabled={!navigator.clipboard}
								data-qa="json-copy"
							>
								{t("Copy")}
							</Button>
							<Button onClick={() => void downloadJson()} data-qa="json-dl">
								{t("Download")}
							</Button>
						</div>
					</div>
					<div className="export-modal__format">
						<h3 className="export-modal__subhead">{t("As CSV")}</h3>
						<p>
							<Trans
								msg={"CSV exports do {not} retain camera orientation and pano\u00A0IDs."}
								not={<em>{t("not")}</em>}
							/>
						</p>
						<div className="export-modal__export-buttons">
							<Button
								onClick={() => void copyCsv()}
								disabled={!navigator.clipboard}
								data-qa="csv-copy"
							>
								{t("Copy")}
							</Button>
							<Button onClick={() => void downloadCsv()} data-qa="csv-dl">
								{t("Download")}
							</Button>
						</div>
					</div>
					<div className="export-modal__format">
						<h3 className="export-modal__subhead">{t("As GeoJSON")}</h3>
						<p>{t("For use in non-GeoGuessr mapping tools.")}</p>
						<div className="export-modal__export-buttons">
							<Button onClick={() => void downloadGeoJson()} data-qa="geojson-download">
								{t("Download")}
							</Button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
