import { useState } from "react";
import { mdiChevronDown, mdiChevronUp } from "@mdi/js";
import type { Tag } from "@/bindings.gen";
import { getMapState } from "@/store/useMapStore";
import { sortTagsByMode, tagColorFor, appendTagName } from "@/lib/util/util";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { Icon } from "@/components/primitives/Icon";
import { useSetting, setSetting } from "@/store/settings";
import { displayTagName } from "@/store/selections";
import { t } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";

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
	const collapsed = useSetting("fullscreenTagbarCollapsed");
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
	const filtered = input.trim()
		? available.filter((t) => t.name.toLowerCase().includes(input.toLowerCase()))
		: available;

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
							className="form-add-tag__input fullscreen-tagbar__input"
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
			<button
				type="button"
				className="fullscreen-tagbar__collapse"
				aria-label={collapsed ? t("Expand tag bar") : t("Collapse tag bar")}
				onClick={() => setSetting("fullscreenTagbarCollapsed", !collapsed)}
			>
				<Icon path={collapsed ? mdiChevronUp : mdiChevronDown} size={16} />
			</button>
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
