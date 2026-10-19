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
		<span className="inat-sidebar__info">
			{children}
			<svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-label={info}>
				<title>{info}</title>
				<path d={INFO_PATH} />
			</svg>
		</span>
	);
}

const {
	ui: { Section, Field, SegmentedControl, Button, Checkbox, ProgressRow },
	storage,
	useJob,
	toast,
} = MMA;

export function TaxonomySorter() {
	const store = storage("inaturalist");
	const [lang, setLang] = useState<string>(() => store.get("taxo_lang", "en"));
	const [deep, setDeep] = useState(true);
	const [commonNames, setCommonNames] = useState(true);

	const handleLangChange = useCallback((code: string) => {
		setLang(code);
		store.set("taxo_lang", code);
	}, [store]);

	const job = useJob<SortResult, SortProgress>();
	const sort = () =>
		job.run(async ({ signal, report }) => {
			const opts: SortOptions = { lang, deep, commonNames };
			const r = await sortTagsByTaxonomy(opts, report, signal);
			toast(
				r.sorted > 0
					? `Sorted ${r.sorted} tag${r.sorted === 1 ? "" : "s"} into taxonomy folders`
					: "No tags needed sorting",
			);
			return r;
		});
	const running = job.status === "loading";
	const progress = running ? job.progress : null;
	const result = job.ok();

	const handleClearCache = useCallback(() => {
		clearTaxonomyCache();
		toast("Taxonomy cache cleared");
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
				<Checkbox checked={commonNames} onChange={(e) => setCommonNames(e.target.checked)} />
			</Field>

			<div className="inat-sidebar__run">
				{running ? (
					<Button variant="destructive" onClick={job.cancel}>
						Cancel
					</Button>
				) : (
					<Button variant="primary" onClick={sort}>
						Sort Tags
					</Button>
				)}
				<Button
					onClick={handleClearCache}
					disabled={running}
					title="Forget saved iNaturalist taxonomy results"
				>
					Clear Cache
				</Button>
			</div>

			{progress && (
				<ProgressRow
					className="inat-sidebar__status"
					label={progress.phase}
					count={`${progress.current}/${progress.total}`}
					value={progress.total > 0 ? progress.current / progress.total : 0}
				>
					{progress.detail && <div className="inat-sidebar__detail">{progress.detail}</div>}
				</ProgressRow>
			)}

			{job.status === "error" && (
				<div className="inat-sidebar__error">{job.error.message}</div>
			)}

			{result && (
				<div className="inat-sidebar__status">
					{result.sorted} sorted, {result.skipped} skipped
				</div>
			)}
		</Section>
	);
}
