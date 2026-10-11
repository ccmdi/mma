import { useMemo, useState, useCallback } from "react";
import { Store } from "@/store/store";
import { Editor } from "@/store/editor";
import { Location } from "@/store/location";
import { Tag } from "@/store/tag";
import { Tooltip } from "@/components/primitives/Tooltip";
import { svThumbnailUrl } from "@/lib/sv/lookup";
import { TagPill } from "@/components/primitives/TagPill";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { toggleInSet } from "@/lib/util/util";
import { t } from "@/lib/i18n";
import { Trans } from "@/components/primitives/Trans";

function DuplicateItem({
	location,
	selected,
	onDelete,
	onSelect,
	onClick,
	tagMap,
}: {
	location: Location;
	selected: boolean;
	onDelete: () => void;
	onSelect: (checked: boolean) => void;
	onClick: () => void;
	tagMap: Record<number, { name: string; color: string }>;
}) {
	const thumbSrc = location.panoId ? svThumbnailUrl(location.panoId, location.heading) : null;

	return (
		<li className="duplicate-item">
			<label className="duplicate-item__select">
				<Checkbox checked={selected} onChange={(e) => onSelect(e.target.checked)} />
			</label>
			<button className="duplicate-item__thumbnail" onClick={onClick}>
				{thumbSrc ? (
					<img src={thumbSrc} style={{ minHeight: 96 }} />
				) : (
					<div style={{ minHeight: 96 }} />
				)}
			</button>
			<div className="duplicate-item__tags">
				{location.tags.length > 0 ? (
					<>
						<strong>{t("Tags:")}</strong>{" "}
						{location.tags.map((tid) => {
							const tag = tagMap[tid];
							if (!tag) return null;
							return <TagPill key={tid} small color={tag.color} label={tag.name} />;
						})}
					</>
				) : (
					<em>{t("No tags")}</em>
				)}
			</div>
			<div className="duplicate-item__meta">{Math.round(location.heading)}&deg;</div>
			<div className="duplicate-item__actions">
				<Button variant="destructive" onClick={onDelete}>
					{t("Delete")}
				</Button>
			</div>
		</li>
	);
}

export default function SameLocation() {
	const locations = Store.use((s) => s.duplicateLocations);
	const tagMap = Store.use(() => Tag.all());

	const [selected, setSelected] = useState<Set<number>>(() => new Set());

	const sorted = useMemo(
		() =>
			[...locations].sort((a, b) =>
				a.tags.length !== b.tags.length ? b.tags.length - a.tags.length : a.createdAt - b.createdAt,
			),
		[locations],
	);

	const toggleSelect = useCallback((loc: Location, checked: boolean) => {
		setSelected((prev) => toggleInSet(prev, loc.id, checked));
	}, []);

	const deleteSingle = useCallback(
		(loc: Location) => {
			void Location.remove(new Set([loc.id]));
			Editor.removeDuplicate(loc.id);
			const remaining = locations.filter((l) => l.id !== loc.id);
			if (remaining.length <= 1) {
				if (remaining.length === 1) Editor.openDuplicate(remaining[0]);
				else Editor.closeDuplicates();
			}
		},
		[locations],
	);

	const keepSelected = useCallback(() => {
		const toDelete = new Set(locations.map((l) => l.id)).difference(selected);
		void Location.remove(toDelete);
		const remaining = locations.find((l) => selected.has(l.id));
		if (remaining) Editor.openDuplicate(remaining);
		else Editor.closeDuplicates();
	}, [locations, selected]);

	const deleteSelected = useCallback(() => {
		void Location.remove(new Set(selected));
		const remaining = locations.find((l) => !selected.has(l.id));
		if (remaining) Editor.openDuplicate(remaining);
		else Editor.closeDuplicates();
	}, [locations, selected]);

	return (
		<section className="duplicates">
			<h2>
				<Trans
					msg={{ one: "{count} location", other: "{count} locations" }}
					n={locations.length}
					count={<span className="mono">{locations.length}</span>}
				/>
			</h2>
			<p>
				{t(
					"Multiple locations were selected around this coordinate. Click one of the thumbnails below\n\t\t\t\tto view that location.",
				)}
			</p>
			<ul className="duplicates__location-list">
				{sorted.map((loc) => (
					<DuplicateItem
						key={loc.id}
						location={loc}
						selected={selected.has(loc.id)}
						onDelete={() => deleteSingle(loc)}
						onSelect={(checked) => toggleSelect(loc, checked)}
						onClick={() => Editor.openDuplicate(loc)}
						tagMap={tagMap}
					/>
				))}
			</ul>
			<div className="duplicates__actions">
				<Tooltip
					content={t("Delete all duplicate locations, except the selected ones")}
					side="bottom"
				>
					<Button variant="destructive" disabled={selected.size === 0} onClick={keepSelected}>
						{t("Keep selected")}
					</Button>
				</Tooltip>
				<Tooltip content={t("Delete selected locations")} side="bottom">
					<Button variant="destructive" disabled={selected.size === 0} onClick={deleteSelected}>
						{t("Delete selected")}
					</Button>
				</Tooltip>
				<Button onClick={Editor.closeDuplicates}>{t("Cancel")}</Button>
			</div>
		</section>
	);
}
