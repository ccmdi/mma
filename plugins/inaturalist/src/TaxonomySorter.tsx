import { useState, useCallback, type ReactNode } from "react";
import {
	sortTagsByTaxonomy,
	clearTaxonomyCache,
	type SortOptions,
	type SortProgress,
	type SortResult,
} from "./taxonomy";

const LANGUAGES = [
	{ code: "en", label: "EN" },
	{ code: "fr", label: "FR" },
	{ code: "es", label: "ES" },
	{ code: "de", label: "DE" },
	{ code: "ja", label: "JA" },
] as const;

const INFO_PATH = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z";

function Label({ children, info }: { children: ReactNode; info: string }) {
	return (
		<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
			{children}
			<svg
				width={13} height={13} viewBox="0 0 24 24" fill="currentColor"
				style={{ opacity: 0.35, cursor: "help", flexShrink: 0 }}
				aria-label={info}
			>
				<title>{info}</title>
				<path d={INFO_PATH} />
			</svg>
		</span>
	);
}

const { Section, Field, SegmentedControl } = MMA.ui;

export function TaxonomySorter() {
	const storage = MMA.storage("inaturalist");
	const [lang, setLang] = useState<string>(() => storage.get("taxo_lang", "en"));
	const [deep, setDeep] = useState(true);
	const [commonNames, setCommonNames] = useState(true);

	const handleLangChange = useCallback((code: string) => {
		setLang(code);
		storage.set("taxo_lang", code);
	}, [storage]);

	const job = MMA.useJob<SortResult, SortProgress>(async ({ signal, report }) => {
		const opts: SortOptions = { lang, deep, commonNames };
		const r = await sortTagsByTaxonomy(opts, report, signal);
		MMA.toast(
			r.sorted > 0
				? `Sorted ${r.sorted} tag${r.sorted === 1 ? "" : "s"} into taxonomy folders`
				: "No tags needed sorting",
		);
		return r;
	});

	const handleClearCache = useCallback(() => {
		clearTaxonomyCache();
		MMA.toast("Taxonomy cache cleared");
	}, []);

	return (
		<Section title="Taxonomy Sorter" defaultOpen={false}>
			<Field label="Language" row>
				<SegmentedControl
					options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
					value={lang}
					onChange={handleLangChange}
				/>
			</Field>

			<Field label={<Label info="Deep = all taxonomic ranks. Flat = order + family only.">Depth</Label>} row>
				<SegmentedControl
					options={[
						{ value: "deep", label: " Deep " },
						{ value: "flat", label: " Flat " },
					]}
					value={deep ? "deep" : "flat"}
					onChange={(v) => setDeep(v === "deep")}
				/>
			</Field>

			<Field label={<Label info="Include translated common names from iNaturalist">Common names</Label>} row>
				<input
					type="checkbox"
					checked={commonNames}
					onChange={(e) => setCommonNames(e.target.checked)}
				/>
			</Field>

			<div style={{ display: "flex", gap: 6, marginTop: 4 }}>
				{job.running ? (
					<button className="button button--danger" onClick={job.cancel} style={{ flex: 1 }}>
						Cancel
					</button>
				) : (
					<button className="button button--primary" onClick={job.run} style={{ flex: 1 }}>
						Sort Tags
					</button>
				)}
				<button
					className="button"
					onClick={handleClearCache}
					disabled={job.running}
					title="Clear cached API results"
				>
					Clear Cache
				</button>
			</div>

			{job.progress && (
				<div style={{ fontSize: 11, color: "var(--text-secondary, #999)", marginTop: 6 }}>
					{job.progress.phase} ({job.progress.current}/{job.progress.total})
					{job.progress.detail && <div style={{ opacity: 0.7 }}>{job.progress.detail}</div>}
				</div>
			)}

			{job.error && (
				<div style={{ fontSize: 11, color: "#e55", marginTop: 6 }}>{job.error}</div>
			)}

			{job.result && !job.running && (
				<div style={{ fontSize: 11, color: "var(--text-secondary, #999)", marginTop: 6 }}>
					{job.result.sorted} sorted, {job.result.skipped} skipped
				</div>
			)}
		</Section>
	);
}
