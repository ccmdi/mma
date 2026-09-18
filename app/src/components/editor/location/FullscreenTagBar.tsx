import { useState } from "react";
import { mdiChevronDown, mdiChevronUp } from "@mdi/js";
import type { Tag } from "@/bindings.gen";
import { getMapState } from "@/store/useMapStore";
import { sortTagsByMode, tagColorFor, appendTagName } from "@/lib/util/util";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { useSetting } from "@/store/settings";
import { persisted, useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { displayTagName } from "@/store/selections";
import { t } from "@/lib/i18n";
import { search } from "@/lib/search";
import { Button } from "@/components/primitives/Button";
import { IconButton } from "@/components/primitives/IconButton";

/** Tag bar dropped down to a thin strip. Toggled from the bar itself, not Settings. */
const FULLSCREEN_TAGBAR_COLLAPSED = persisted("fullscreenTagbarCollapsed", false);

export function FullscreenTagBar({
	pendingTags,
	onChangeTags,
	tags,
}: {
	pendingTags: string[];
	onChangeTags: (tags: string[]) => void;
	tags: Tag[];
}) {
	const [input, setInput] = useState("");
	const [focused, setFocused] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [collapsed, setCollapsed] = useLocalStorage(FULLSCREEN_TAGBAR_COLLAPSED);
	const tagSortMode = useSetting("tagSortMode");
	useSetting("truncateTagPaths");
	useSetting("tagViewMode");
	const label = displayTagName;

	const handleAdd = (e: React.FormEvent) => {
		e.preventDefault();
		const name = input.trim();
		if (!name) return;
		onChangeTags(appendTagName(pendingTags, name, tags));
		setInput("");
	};

	const toggleTag = (t: Tag) => {
		const lower = t.name.toLowerCase();
		if (pendingTags.some((n) => n.toLowerCase() === lower)) {
			onChangeTags(pendingTags.filter((n) => n.toLowerCase() !== lower));
		} else {
			onChangeTags([...pendingTags, t.name]);
		}
		setInput("");
	};

	const pendingLower = new Set(pendingTags.map((n) => n.toLowerCase()));
	const sorted = sortTagsByMode(tags, tagSortMode, getMapState().tagCounts);
	const available = sorted.filter((t) => !pendingLower.has(t.name.toLowerCase()));
	const filtered = search(available, input, (t) => [t.name]);

	return (
		<div
			className={`fullscreen-tagbar${collapsed ? " is-collapsed" : ""}`}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
		>
			<div className="fullscreen-tagbar__row">
				<div className="fullscreen-tagbar__content">
					<ul className="tag-list">
						{pendingTags.map((name) => (
							<TagPill
								as="li"
								key={name}
								small
								color={tagColorFor(name, tags)}
								label={label(name)}
								button={
									<TagPillButton
										variant="delete"
										onClick={() => onChangeTags(pendingTags.filter((n) => n !== name))}
									/>
								}
							/>
						))}
					</ul>
					<form className="form-add-tag" onSubmit={handleAdd}>
						<Button className="form-add-tag__button" type="submit">
							+
						</Button>
						<input
							className="form-add-tag__input"
							type="text"
							placeholder={t("Add a tag...")}
							spellCheck={false}
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onFocus={() => setFocused(true)}
							onBlur={() => setTimeout(() => setFocused(false), 150)}
						/>
					</form>
				</div>
			</div>
			<IconButton
				className="fullscreen-tagbar__collapse"
				icon={collapsed ? mdiChevronUp : mdiChevronDown}
				size={16}
				label={collapsed ? t("Expand tag bar") : t("Collapse tag bar")}
				tooltip={false}
				overlay
				onClick={() => setCollapsed(!collapsed)}
			/>
			{!collapsed && (focused || hovered) && filtered.length > 0 && (
				<div className="fullscreen-tagbar__palette">
					{filtered.map((t) => (
						<TagPill
							as="button"
							key={t.id}
							small
							color={t.color}
							label={label(t.name)}
							className="fullscreen-tagbar__palette-tag"
							type="button"
							onMouseDown={(e: React.MouseEvent) => {
								e.preventDefault(); // don't move focus: palette stays open, hotkeys keep working
								toggleTag(t);
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}
