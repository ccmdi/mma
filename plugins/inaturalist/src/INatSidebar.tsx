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

const CSS = `
.inat-sidebar__search { display: flex; gap: 6px; }
.inat-sidebar__results {
  max-height: 300px; overflow-y: auto;
  border: 1px solid var(--color-divider, #333); border-radius: 4px;
  margin-top: 8px;
}
.inat-sidebar__taxon {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  cursor: pointer; border-bottom: 1px solid var(--color-divider, #333);
  font-size: 13px;
}
.inat-sidebar__taxon:last-child { border-bottom: none; }
.inat-sidebar__taxon:hover { background: rgba(255,255,255,0.05); }
.inat-sidebar__taxon-photo {
  width: 32px; height: 32px; border-radius: 4px; object-fit: cover;
  background: #333; flex-shrink: 0;
}
.inat-sidebar__taxon-info { flex: 1; min-width: 0; }
.inat-sidebar__taxon-name {
  font-weight: 600; font-style: italic; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.inat-sidebar__taxon-meta { font-size: 11px; color: var(--text-secondary, #999); }
.inat-sidebar__active {
  margin-top: 8px; padding: 8px; border-radius: 4px;
  background: rgba(255, 120, 0, 0.1); border: 1px solid rgba(255, 120, 0, 0.3);
}
.inat-sidebar__active-name { font-weight: 600; font-size: 13px; color: #ff7800; }
.inat-sidebar__active-count { font-size: 12px; color: var(--text-secondary, #999); margin-top: 2px; }
.inat-sidebar__actions { display: flex; gap: 6px; margin-top: 8px; }
.inat-sidebar__hint { font-size: 12px; color: var(--text-secondary, #999); margin-top: 4px; }
`;

let styleEl: HTMLStyleElement | null = null;

function injectCSS() {
	if (styleEl) return;
	styleEl = document.createElement("style");
	styleEl.textContent = CSS;
	document.head.appendChild(styleEl);
}

function removeCSS() {
	if (styleEl) {
		styleEl.remove();
		styleEl = null;
	}
}

const { ui: { Sidebar, Section, TextInput, Button }, toast } = MMA;

export function INatSidebar({ onClose }: { onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Taxon[]>([]);
	const [searching, setSearching] = useState(false);
	const [, bump] = useState(0);

	const refresh = useCallback(() => bump((n) => n + 1), []);

	useEffect(() => {
		injectCSS();
		setOnUpdate(refresh);
		return () => {
			setOnUpdate(null);
			removeCSS();
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
