import { Store } from "@/store/store";
import { Tag } from "@/store/tag";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { displayTagName, togglePendingTag, type PendingTags } from "@/lib/data/tags";
import { colorForName } from "@/lib/util/color";

/** One removable pill per pending tag, named from the live tag records. */
export function PendingTagPills({
	pending,
	onChange,
}: {
	pending: PendingTags;
	onChange: (pending: PendingTags) => void;
}) {
	const records = Store.use(Tag.all);
	return (
		<>
			{pending.ids.map((id) => {
				const tag = records[id];
				return (
					tag && (
						<TagPill
							as="li"
							key={id}
							small
							color={tag.color}
							label={displayTagName(tag.name)}
							button={
								<TagPillButton
									variant="delete"
									onClick={() => onChange(togglePendingTag(pending, id))}
								/>
							}
						/>
					)
				);
			})}
			{pending.names.map((name) => (
				<TagPill
					as="li"
					key={`name:${name}`}
					small
					color={colorForName(name)}
					label={displayTagName(name)}
					button={
						<TagPillButton
							variant="delete"
							onClick={() =>
								onChange({ ...pending, names: pending.names.filter((n) => n !== name) })
							}
						/>
					}
				/>
			))}
		</>
	);
}
