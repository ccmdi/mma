import { useState, useEffect, useCallback } from "react";
import {
	searchTaxa,
	selectTaxon,
	getCurrentTaxon,
	getObservations,
	isVisible,
	toggleVisibility,
	clearData,
	importToMap,
	setOnUpdate,
	type Taxon,
} from "./inat";
import { TaxonomySorter } from "./TaxonomySorter";
import "./INatSidebar.css";

const { ui: { Sidebar, Section, TextInput, Button }, toast } = MMA;

export function INatSidebar({ onClose }: { onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Taxon[]>([]);
	const [searching, setSearching] = useState(false);
	const [, bump] = useState(0);

	const refresh = useCallback(() => bump((n) => n + 1), []);

	useEffect(() => {
		setOnUpdate(refresh);
		return () => {
			setOnUpdate(null);
		};
	}, [refresh]);

	const doSearch = async () => {
		const q = query.trim();
		if (!q) return;
		setSearching(true);
		try {
			setResults(await searchTaxa(q));
		} catch {
			toast("Failed to search iNaturalist");
		}
		setSearching(false);
	};

	const handleSelect = (taxon: Taxon) => {
		selectTaxon(taxon);
		setResults([]);
		setQuery("");
	};

	const handleImport = () => {
		const n = importToMap();
		if (n > 0) toast(`Imported ${n} observations as locations`);
		else toast("No observations to import");
	};

	const taxon = getCurrentTaxon();
	const count = getObservations().length;
	const vis = isVisible();

	return (
		<Sidebar title="iNaturalist" onBack={onClose}>
			<Section title="Observations">
				<div className="inat-sidebar__search">
					<TextInput
						placeholder="Search species..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") doSearch();
							e.stopPropagation();
						}}
						style={{ flex: 1 }}
					/>
					<Button onClick={doSearch} disabled={searching || !query.trim()}>
						{searching ? "..." : "Search"}
					</Button>
				</div>

				{results.length > 0 && (
					<div className="inat-sidebar__results">
						{results.map((t) => (
							<div key={t.id} className="inat-sidebar__taxon" onClick={() => handleSelect(t)}>
								{t.photoUrl && <img className="inat-sidebar__taxon-photo" src={t.photoUrl} />}
								<div className="inat-sidebar__taxon-info">
									<div className="inat-sidebar__taxon-name">{t.name}</div>
									<div className="inat-sidebar__taxon-meta">
										{t.commonName && `${t.commonName} · `}
										{t.rank} · {t.count.toLocaleString()} obs
									</div>
								</div>
							</div>
						))}
					</div>
				)}

				{taxon && (
					<div className="inat-sidebar__active">
						<div className="inat-sidebar__active-name">{taxon.name}</div>
						<div className="inat-sidebar__active-count">{count.toLocaleString()} observations loaded</div>
					</div>
				)}

				<div className="inat-sidebar__actions">
					<Button onClick={toggleVisibility} disabled={!taxon}>
						{vis ? "Hide" : "Show"}
					</Button>
					<Button variant="primary" onClick={handleImport} disabled={count === 0}>
						Import{count > 0 ? ` (${count})` : ""}
					</Button>
					<Button variant="destructive" onClick={clearData} disabled={!taxon}>
						Clear
					</Button>
				</div>

				{!taxon && <div className="inat-sidebar__hint">Search for a species to visualize observations on the map.</div>}
			</Section>

			<TaxonomySorter />
		</Sidebar>
	);
}
