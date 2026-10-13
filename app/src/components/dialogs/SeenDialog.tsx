import { useState, useEffect } from "react";
import { useAsync, useSticky } from "@/lib/hooks/useAsync";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import {
	Dialog,
	DialogActions,
	DialogContent,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { EmptyState } from "@/components/primitives/EmptyState";
import { NSelect } from "@/components/primitives/NSelect";
import { Button } from "@/components/primitives/Button";
import { Flag } from "@/components/primitives/Flag";
import { Seen } from "@/lib/seen/seen";
import { dayMonthFmt } from "@/lib/util/format";
import { getLocale, t } from "@/lib/i18n";
import type { SeenEntry, SeenFilter } from "@/bindings.gen";
import { SearchInput } from "@/components/primitives/SearchInput";

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
				<span className="seen-entry__location truncate">
					<Flag code={entry.countryCode} height={12} className="seen-entry__flag" />
					{entry.address || `${entry.lat.toFixed(4)}, ${entry.lng.toFixed(4)}`}
				</span>
				<span className="seen-entry__time mono truncate">{formatDateTime(entry.enteredAt)}</span>
			</div>
		</button>
	);
}

export function SeenDialog({
	open,
	onOpenChange,
	onLoadPano,
}: DialogProps & { onLoadPano: (entry: SeenEntry) => void }) {
	const [page, setPage] = useState(0);
	const [filterCountry, setFilterCountry] = useState("");
	const [filterMap, setFilterMap] = useState("");
	const [filterSearch, setFilterSearch] = useState("");
	const [search, setSearch] = useState("");
	const [cleared, setCleared] = useState(0);

	useEffect(() => {
		if (open) return;
		setPage(0);
		setFilterCountry("");
		setFilterMap("");
		setFilterSearch("");
		setSearch("");
	}, [open]);

	const options = useAsync(
		() => (open ? Promise.all([Seen.countries(), Seen.maps()]) : null),
		[open],
	).data;
	const listing = useAsync(() => {
		if (!open) return null;
		const filter: SeenFilter = {
			country: filterCountry || undefined,
			mapId: filterMap || undefined,
			search: search || undefined,
		};
		const used = filter.country || filter.mapId || filter.search ? filter : undefined;
		return Promise.all([Seen.entries(PAGE_SIZE, page * PAGE_SIZE, used), Seen.count(used)]);
	}, [open, page, filterCountry, filterMap, search, cleared]);
	const shown = useSticky(listing);
	const [entries, total] = shown ?? [[], 0];
	const [countries, maps] = options ?? [[], []];
	const loading = listing.loading;
	const ready = shown !== null && options !== null;

	const filterBy = (set: (value: string) => void) => (value: string) => {
		set(value);
		setPage(0);
	};

	const debouncedSearch = useDebouncedCallback((value: string) => {
		setSearch(value);
		setPage(0);
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
		await Seen.clear();
		setCleared((n) => n + 1);
	};

	const totalPages = Math.ceil(total / PAGE_SIZE);

	return (
		<Dialog open={open && ready} onOpenChange={onOpenChange}>
			<DialogContent title={t("Seen ({n})", { n: total })} className="seen-dialog" size="lg">
				<div className="seen-dialog__filters">
					<NSelect
						className="seen-dialog__select"
						value={filterCountry || "_all"}
						onChange={(e) =>
							filterBy(setFilterCountry)(e.target.value === "_all" ? "" : e.target.value)
						}
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
						onChange={(e) =>
							filterBy(setFilterMap)(e.target.value === "_all" ? "" : e.target.value)
						}
					>
						<option value="_all">{t("All maps")}</option>
						{maps.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
							</option>
						))}
					</NSelect>
					<SearchInput
						className="seen-dialog__search"
						placeholder={t("Search address...")}
						value={filterSearch}
						onChange={(e) => handleSearchInput(e.target.value)}
					/>
				</div>
				<div className="seen-dialog__grid">
					{entries.length === 0 && !loading ? (
						<EmptyState>{t("No panos found.")}</EmptyState>
					) : (
						entries.map((e) => <SeenEntryCard key={e.id} entry={e} onLoad={handleLoad} />)
					)}
				</div>
				<div className="seen-dialog__pagination">
					<Button disabled={page === 0 || loading} onClick={() => setPage(page - 1)}>
						{t("Prev")}
					</Button>
					<span className="mono">{totalPages > 0 ? `${page + 1} / ${totalPages}` : "0 / 0"}</span>
					<Button disabled={page >= totalPages - 1 || loading} onClick={() => setPage(page + 1)}>
						{t("Next")}
					</Button>
				</div>
				<DialogActions
					destructive={{ label: t("Clear"), confirm: true, onClick: () => void handleClear() }}
					cancel={{ label: t("Close") }}
				/>
			</DialogContent>
		</Dialog>
	);
}
