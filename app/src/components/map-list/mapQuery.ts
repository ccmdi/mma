/** Map-list search grammar: whitespace-separated terms, AND'd together.
 *  `label:x` or `label:"x y"` matches maps carrying that label (prefix,
 *  case-insensitive); plain terms match name or labels by substring. */
import type { MapMeta } from "@/bindings.gen";
import type { SortMode } from "@/types";
import { ensurePathNode, normalizePath, type PathTreeNode } from "@/lib/data/tagPaths";

export interface MapFolderNode extends PathTreeNode<MapFolderNode> {
	maps: MapMeta[];
	/** Total maps at this folder and every subfolder under it. */
	mapCount: number;
	/** Total locations across every map in this folder's subtree. */
	locationCount: number;
}

export function sortMaps(maps: MapMeta[], mode: SortMode): MapMeta[] {
	const sorted = [...maps];
	switch (mode) {
		case "name":
			return sorted.sort((a, b) => a.name.localeCompare(b.name));
		case "opened":
			return sorted.sort((a, b) => {
				const at = a.lastOpenedAt ?? "";
				const bt = b.lastOpenedAt ?? "";
				if (!at && bt) return 1;
				if (at && !bt) return -1;
				return at > bt ? -1 : at < bt ? 1 : 0;
			});
		case "created":
			return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		case "amount":
			return sorted.sort((a, b) => b.locationCount - a.locationCount);
	}
}

/** Build the nested map-folder tree from `/`-delimited folder paths and synthetic empty folders. */
export function buildMapTree(
	maps: MapMeta[],
	syntheticFolders: readonly string[],
	sortMode: SortMode,
): { folders: MapFolderNode[]; rootMaps: MapMeta[] } {
	const folders: MapFolderNode[] = [];
	const rootMaps: MapMeta[] = [];

	const ensureFolder = (raw: string): MapFolderNode | null => {
		const clean = normalizePath(raw);
		if (!clean) return null;
		return ensurePathNode(folders, clean.split("/"), (segment, fullPath, parentPath) => ({
			segment,
			fullPath,
			parentPath,
			children: [],
			maps: [],
			mapCount: 0,
			locationCount: 0,
		}));
	};

	for (const sf of syntheticFolders) ensureFolder(sf);
	for (const m of maps) {
		const node = m.folder ? ensureFolder(m.folder) : null;
		if (node) node.maps.push(m);
		else rootMaps.push(m);
	}

	const finalize = (nodes: MapFolderNode[]) => {
		nodes.sort((a, b) => a.segment.localeCompare(b.segment));
		for (const n of nodes) {
			finalize(n.children);
			n.maps = sortMaps(n.maps, sortMode);
			let mapCount = n.maps.length;
			let locationCount = n.maps.reduce((a, m) => a + m.locationCount, 0);
			for (const c of n.children) {
				mapCount += c.mapCount;
				locationCount += c.locationCount;
			}
			n.mapCount = mapCount;
			n.locationCount = locationCount;
		}
	};
	finalize(folders);

	return { folders, rootMaps: sortMaps(rootMaps, sortMode) };
}

export interface MapQuery {
	text: string[];
	labels: string[];
}

const TERM_RE = /label:"([^"]*)"|label:(\S+)|(\S+)/gi;

export function parseMapQuery(query: string): MapQuery {
	const text: string[] = [];
	const labels: string[] = [];
	for (const m of query.matchAll(TERM_RE)) {
		const label = m[1] ?? m[2];
		if (label != null) {
			if (label) labels.push(label.toLowerCase());
		} else {
			text.push(m[3].toLowerCase());
		}
	}
	return { text, labels };
}

export function mapMatchesQuery(name: string, mapLabels: string[], q: MapQuery): boolean {
	const nameLc = name.toLowerCase();
	const labelsLc = mapLabels.map((l) => l.toLowerCase());
	return (
		q.labels.every((t) => labelsLc.some((l) => l.startsWith(t))) &&
		q.text.every((t) => nameLc.includes(t) || labelsLc.some((l) => l.includes(t)))
	);
}

/** The `label:` term that selects exactly this label, quoted when needed. */
export function labelToken(label: string): string {
	const clean = label.replace(/"/g, "");
	return /\s/.test(clean) ? `label:"${clean}"` : `label:${clean}`;
}

/** Add the label's token to the query if absent, else remove it (chip click toggle). */
export function toggleLabelInQuery(query: string, label: string): string {
	const token = labelToken(label);
	const lc = token.toLowerCase();
	const parts = query.match(/label:"[^"]*"|\S+/gi) ?? [];
	const without = parts.filter((p) => p.toLowerCase() !== lc);
	const next = without.length === parts.length ? [...parts, token] : without;
	return next.join(" ");
}

/** Hides the list's map rows and folders that miss the query. */
export function applyMapFilter(listEl: HTMLElement | null, query: string) {
	if (!listEl) return;
	const entries = listEl.querySelectorAll<HTMLElement>("[data-filter-name]");
	const folders = listEl.querySelectorAll<HTMLElement>("[data-filter-folder]");
	const q = parseMapQuery(query);
	if (q.text.length === 0 && q.labels.length === 0) {
		for (const el of entries) el.hidden = false;
		for (const el of folders) el.hidden = false;
	} else {
		for (const el of entries) {
			const labels = (el.dataset.filterLabels ?? "").split("\n").filter(Boolean);
			el.hidden = !mapMatchesQuery(el.dataset.filterName!, labels, q);
		}
		for (const el of folders) {
			const hasVisible = el.querySelector<HTMLElement>("[data-filter-name]:not([hidden])") !== null;
			el.hidden = !hasVisible;
		}
	}
}
