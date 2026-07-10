import { useState, useEffect, useCallback } from "react";
import * as Select from "@radix-ui/react-select";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import {
	getSeenEntries,
	getSeenCount,
	clearSeen,
	getSeenCountries,
	getSeenMaps,
} from "@/lib/seen/seen";
import type { SeenEntry, SeenFilter } from "@/bindings.gen";

const PAGE_SIZE = 9;

function formatDateTime(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	if (sameDay) return time;
	return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
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
					{entry.countryCode && (
						<img
							height={12}
							width={16}
							src={`/flags/${entry.countryCode.toUpperCase()}.svg`}
							alt={entry.countryCode}
							style={{ borderRadius: "2px", verticalAlign: "middle", marginRight: 4 }}
						/>
					)}
					{entry.address || `${entry.lat.toFixed(4)}, ${entry.lng.toFixed(4)}`}
				</span>
				<span className="seen-entry__time">{formatDateTime(entry.enteredAt)}</span>
			</div>
		</button>
	);
}

export function SeenDialog({
	open,
	onOpenChange,
	onLoadPano,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onLoadPano: (entry: SeenEntry) => void;
}) {
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
			Promise.all([
				load(0),
				getSeenCountries().then(setCountries),
				getSeenMaps().then(setMaps),
			]).then(() => setReady(true));
		}
	}, [open, load]);

	useEffect(() => {
		if (!ready) return;
		load(0, buildFilter());
	}, [filterCountry, filterMap]);

	const debouncedSearch = useDebouncedCallback((value: string) => {
		load(0, { ...buildFilter(), search: value || undefined });
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
			<DialogContent title={`Seen (${total})`} className="seen-dialog">
				<div className="seen-dialog__filters">
					<Select.Root
						value={filterCountry || "_all"}
						onValueChange={(v) => setFilterCountry(v === "_all" ? "" : v)}
					>
						<Select.Trigger className="select__input seen-dialog__select">
							<Select.Value placeholder="All countries" />
						</Select.Trigger>
						<Select.Portal>
							<Select.Content className="select__content" position="popper" sideOffset={6}>
								<Select.Viewport>
									<Select.Item value="_all" className="select__option">
										<Select.ItemText>All countries</Select.ItemText>
									</Select.Item>
									{countries.map((c) => (
										<Select.Item key={c} value={c} className="select__option">
											<Select.ItemText>{c.toUpperCase()}</Select.ItemText>
										</Select.Item>
									))}
								</Select.Viewport>
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					<Select.Root
						value={filterMap || "_all"}
						onValueChange={(v) => setFilterMap(v === "_all" ? "" : v)}
					>
						<Select.Trigger className="select__input seen-dialog__select">
							<Select.Value placeholder="All maps" />
						</Select.Trigger>
						<Select.Portal>
							<Select.Content className="select__content" position="popper" sideOffset={6}>
								<Select.Viewport>
									<Select.Item value="_all" className="select__option">
										<Select.ItemText>All maps</Select.ItemText>
									</Select.Item>
									{maps.map((m) => (
										<Select.Item key={m.id} value={m.id} className="select__option">
											<Select.ItemText>{m.name}</Select.ItemText>
										</Select.Item>
									))}
								</Select.Viewport>
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					<input
						className="input seen-dialog__search"
						type="text"
						placeholder="Search address..."
						value={filterSearch}
						onChange={(e) => handleSearchInput(e.target.value)}
					/>
				</div>
				<div className="seen-dialog__grid">
					{entries.length === 0 && !loading ? (
						<div className="seen-dialog__empty">No panos found.</div>
					) : (
						entries.map((e) => <SeenEntryCard key={e.id} entry={e} onLoad={handleLoad} />)
					)}
				</div>
				<div className="seen-dialog__footer">
					<button
						className="button button--danger"
						onClick={handleClear}
						onBlur={() => setConfirmingClear(false)}
					>
						{confirmingClear ? "Are you sure?" : "Clear"}
					</button>
					<div className="seen-dialog__pagination">
						<button
							className="button"
							disabled={page === 0 || loading}
							onClick={() => load(page - 1, buildFilter())}
						>
							Prev
						</button>
						<span>{totalPages > 0 ? `${page + 1} / ${totalPages}` : "0 / 0"}</span>
						<button
							className="button"
							disabled={page >= totalPages - 1 || loading}
							onClick={() => load(page + 1, buildFilter())}
						>
							Next
						</button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
