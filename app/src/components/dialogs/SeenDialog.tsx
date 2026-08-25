import { useState, useEffect, useCallback } from "react";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { NSelect } from "@/components/primitives/NSelect";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import { Flag } from "@/components/primitives/Flag";
import {
	getSeenEntries,
	getSeenCount,
	clearSeen,
	getSeenCountries,
	getSeenMaps,
} from "@/lib/seen/seen";
import { dayMonthFmt } from "@/lib/util/format";
import { getLocale, t } from "@/lib/i18n";
import type { SeenEntry, SeenFilter } from "@/bindings.gen";

const PAGE_SIZE = 9;

function formatDateTime(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const time = d.toLocaleTimeString(getLocale(), {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	if (sameDay) return time;
	return dayMonthFmt.format(d) + " " + time;
}

function SeenEntryCard({
	entry,
	onLoad,
}: {
	entry: SeenEntry;
	onLoad: (entry: SeenEntry) => void;
}) {
	const src = entry.thumbnail ? `data:image/jpeg;base64,${entry.thumbnail}` : null;

	return (
		<button className="seen-entry" onClick={() => onLoad(entry)}>
			<div className="seen-entry__thumb">
				{src ? <img src={src} alt="" /> : <div className="seen-entry__no-thumb" />}
			</div>
			<div className="seen-entry__info">
				<span className="seen-entry__location">
					<Flag code={entry.countryCode} height={12} className="seen-entry__flag" />
					{entry.address || `${entry.lat.toFixed(4)}, ${entry.lng.toFixed(4)}`}
				</span>
				<span className="seen-entry__time mono">{formatDateTime(entry.enteredAt)}</span>
			</div>
		</button>
	);
}

export function SeenDialog({
	open,
	onOpenChange,
	onLoadPano,
}: DialogProps & { onLoadPano: (entry: SeenEntry) => void }) {
	const [entries, setEntries] = useState<SeenEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(0);
	const [loading, setLoading] = useState(false);
	const [ready, setReady] = useState(false);
	const [confirmingClear, setConfirmingClear] = useState(false);

	const [countries, setCountries] = useState<string[]>([]);
	const [maps, setMaps] = useState<{ id: string; name: string }[]>([]);

	const [filterCountry, setFilterCountry] = useState<string>("");
	const [filterMap, setFilterMap] = useState<string>("");
	const [filterSearch, setFilterSearch] = useState<string>("");

	const buildFilter = useCallback((): SeenFilter | undefined => {
		const f: SeenFilter = {};
		if (filterCountry) f.country = filterCountry;
		if (filterMap) f.mapId = filterMap;
		if (filterSearch) f.search = filterSearch;
		return f.country || f.mapId || f.search ? f : undefined;
	}, [filterCountry, filterMap, filterSearch]);

	const load = useCallback(async (p: number, filter?: SeenFilter) => {
		setLoading(true);
		const [rows, count] = await Promise.all([
			getSeenEntries(PAGE_SIZE, p * PAGE_SIZE, filter),
			getSeenCount(filter),
		]);
		setEntries(rows);
		setTotal(count);
		setPage(p);
		setLoading(false);
	}, []);

	useEffect(() => {
		if (open) {
			setReady(false);
			setFilterCountry("");
			setFilterMap("");
			setFilterSearch("");
			void Promise.all([
				load(0),
				getSeenCountries().then(setCountries),
				getSeenMaps().then(setMaps),
			]).then(() => setReady(true));
		}
	}, [open, load]);

	useEffect(() => {
		if (!ready) return;
		void load(0, buildFilter());
	}, [filterCountry, filterMap]);

	const debouncedSearch = useDebouncedCallback((value: string) => {
		void load(0, { ...buildFilter(), search: value || undefined });
	}, 250);

	const handleSearchInput = (value: string) => {
		setFilterSearch(value);
		debouncedSearch(value);
	};

	const handleLoad = (entry: SeenEntry) => {
		onLoadPano(entry);
		onOpenChange(false);
	};

	const handleClear = async () => {
		if (!confirmingClear) {
			setConfirmingClear(true);
			return;
		}
		setConfirmingClear(false);
		await clearSeen();
		setEntries([]);
		setTotal(0);
	};

	const totalPages = Math.ceil(total / PAGE_SIZE);

	return (
		<Dialog open={open && ready} onOpenChange={onOpenChange}>
			<DialogContent title={t("Seen ({n})", { n: total })} className="seen-dialog">
				<div className="seen-dialog__filters">
					<NSelect
						className="seen-dialog__select"
						value={filterCountry || "_all"}
						onChange={(e) => setFilterCountry(e.target.value === "_all" ? "" : e.target.value)}
					>
						<option value="_all">{t("All countries")}</option>
						{countries.map((c) => (
							<option key={c} value={c}>
								{c.toUpperCase()}
							</option>
						))}
					</NSelect>
					<NSelect
						className="seen-dialog__select"
						value={filterMap || "_all"}
						onChange={(e) => setFilterMap(e.target.value === "_all" ? "" : e.target.value)}
					>
						<option value="_all">{t("All maps")}</option>
						{maps.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
							</option>
						))}
					</NSelect>
					<TextInput
						className="seen-dialog__search"
						type="text"
						placeholder={t("Search address...")}
						value={filterSearch}
						onChange={(e) => handleSearchInput(e.target.value)}
					/>
				</div>
				<div className="seen-dialog__grid">
					{entries.length === 0 && !loading ? (
						<div className="seen-dialog__empty">{t("No panos found.")}</div>
					) : (
						entries.map((e) => <SeenEntryCard key={e.id} entry={e} onLoad={handleLoad} />)
					)}
				</div>
				<div className="seen-dialog__footer">
					<Button
						variant="destructive"
						onClick={() => void handleClear()}
						onBlur={() => setConfirmingClear(false)}
					>
						{confirmingClear ? t("Are you sure?") : t("Clear")}
					</Button>
					<div className="seen-dialog__pagination">
						<Button
							disabled={page === 0 || loading}
							onClick={() => void load(page - 1, buildFilter())}
						>
							{t("Prev")}
						</Button>
						<span className="mono">{totalPages > 0 ? `${page + 1} / ${totalPages}` : "0 / 0"}</span>
						<Button
							disabled={page >= totalPages - 1 || loading}
							onClick={() => void load(page + 1, buildFilter())}
						>
							{t("Next")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
