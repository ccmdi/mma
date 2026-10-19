import { useState } from "react";
import { mdiChevronDown, mdiChevronUp } from "@mdi/js";
import { Tag } from "@/store/tag";
import { sortTagsByMode, addPendingTag, togglePendingTag, type PendingTags } from "@/lib/data/tags";
import { TagPill } from "@/components/primitives/TagPill";
import { PendingTagPills } from "./PendingTagPills";
import { useSetting } from "@/store/settings";
import { persisted, useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { displayTagName } from "@/lib/data/tags";
import { t } from "@/lib/i18n";
import { search } from "@/lib/search";
import { IconButton } from "@/components/primitives/IconButton";
import { AddTagForm } from "@/components/editor/tags/AddTagForm";

/** Tag bar dropped down to a thin strip. Toggled from the bar itself, not Settings. */
const FULLSCREEN_TAGBAR_COLLAPSED = persisted("fullscreenTagbarCollapsed", false);

export function FullscreenTagBar({
	pendingTags,
	onChangeTags,
	tags,
}: {
	pendingTags: PendingTags;
	onChangeTags: (tags: PendingTags) => void;
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

	const handleAdd = () => {
		const name = input.trim();
		if (!name) return;
		onChangeTags(addPendingTag(pendingTags, name, tags));
		setInput("");
	};

	const toggleTag = (t: Tag) => {
		onChangeTags(togglePendingTag(pendingTags, t.id));
		setInput("");
	};

	const sorted = sortTagsByMode(tags, tagSortMode, Tag.counts());
	const available = sorted.filter((t) => !pendingTags.ids.includes(t.id));
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
						<PendingTagPills pending={pendingTags} onChange={onChangeTags} />
					</ul>
					<AddTagForm
						value={input}
						onChange={setInput}
						onAdd={handleAdd}
						onFocus={() => setFocused(true)}
						onBlur={() => setTimeout(() => setFocused(false), 150)}
					/>
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
